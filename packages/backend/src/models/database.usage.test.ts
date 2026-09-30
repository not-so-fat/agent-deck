import { describe, expect, it } from 'vitest';

import { DatabaseManager } from './database';

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-09-30T00:00:00.000Z';

describe('card usage events (NOT-292)', () => {
  it('starts with no observation evidence for any card type', async () => {
    const db = new DatabaseManager(':memory:');
    await expect(db.getUsageObservationStart('service')).resolves.toBeNull();
    await expect(db.getUsageObservationStart('credential')).resolves.toBeNull();
    await expect(db.getUsageObservationStart('playbook')).resolves.toBeNull();
    await expect(db.getUsageObservationStarts()).resolves.toEqual({
      service: null,
      credential: null,
      playbook: null,
    });
  });

  it('records the first observation time per card type independently', async () => {
    const db = new DatabaseManager(':memory:');
    const first = await db.recordCardUsageEvent({
      cardType: 'service',
      cardId: 'svc-1',
      action: 'tool_call',
      success: true,
      source: 'ide',
      occurredAt: '2026-09-10T12:00:00.000Z',
    });
    expect(first.deckId).toBeNull();
    expect(first.sessionId).toBeNull();

    // A later event must not move the observation start.
    await db.recordCardUsageEvent({
      cardType: 'service',
      cardId: 'svc-1',
      action: 'tool_call',
      success: false,
      source: 'ide',
      occurredAt: '2026-09-11T12:00:00.000Z',
    });

    await expect(db.getUsageObservationStart('service')).resolves.toBe(
      '2026-09-10T12:00:00.000Z',
    );
    await expect(db.getUsageObservationStart('credential')).resolves.toBeNull();
    await expect(db.getUsageObservationStart('playbook')).resolves.toBeNull();
  });

  it('rejects unknown card types', async () => {
    const db = new DatabaseManager(':memory:');
    await expect(
      db.recordCardUsageEvent({
        // @ts-expect-error intentional invalid card type
        cardType: 'widget',
        cardId: 'w-1',
        action: 'tool_call',
        source: 'ide',
      }),
    ).rejects.toThrow('Unknown card usage card type');
  });

  it('maps credential-backed exec runs to success/failure deterministically', async () => {
    const db = new DatabaseManager(':memory:');
    for (const id of ['cred-ok', 'cred-fail', 'cred-unknown']) {
      await db.createCredential({
        id,
        label: id,
        scheme: 'bearer',
        envName: 'TEST_API_KEY',
        keychainAccount: id,
        tags: [],
        hasSecret: false,
      });
    }
    const deck = await db.createDeck({ name: 'deck-1' });
    await db.createExecRun({
      deckId: deck.id,
      command: 'echo hi',
      credentialIds: ['cred-ok'],
      exitCode: 0,
      startedAt: '2026-09-10T10:00:00.000Z',
      finishedAt: '2026-09-10T10:00:01.000Z',
    });
    await db.createExecRun({
      command: 'false',
      credentialIds: ['cred-fail'],
      exitCode: 3,
      startedAt: '2026-09-10T11:00:00.000Z',
    });
    await db.createExecRun({
      command: 'sleep 60',
      credentialIds: ['cred-unknown'],
      startedAt: '2026-09-10T12:00:00.000Z',
    });

    const { events } = await db.listCardUsageEvents({ from: FROM, to: TO, limit: 10 });
    expect(events.map((event) => [event.cardId, event.action, event.success, event.source])).toEqual([
      ['cred-ok', 'exec_run', true, 'exec'],
      ['cred-fail', 'exec_run', false, 'exec'],
      ['cred-unknown', 'exec_run', null, 'exec'],
    ]);
    expect(events[0].deckId).toBe(deck.id);
    expect(events[0].createdAt).toBe('2026-09-10T10:00:01.000Z');
    // Exec-run observation time is available for classification.
    await expect(db.getUsageObservationStart('credential')).resolves.toBe(
      '2026-09-10T10:00:01.000Z',
    );
  });

  it('treats timestamp boundaries as inclusive', async () => {
    const db = new DatabaseManager(':memory:');
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-edge-from',
      action: 'fetch',
      source: 'agent',
      occurredAt: FROM,
    });
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-edge-to',
      action: 'fetch',
      source: 'agent',
      occurredAt: TO,
    });
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-before',
      action: 'fetch',
      source: 'agent',
      occurredAt: '2026-08-31T23:59:59.999Z',
    });
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-after',
      action: 'fetch',
      source: 'agent',
      occurredAt: '2026-09-30T00:00:00.001Z',
    });

    const { events, nextCursor } = await db.listCardUsageEvents({ from: FROM, to: TO, limit: 10 });
    expect(events.map((event) => event.cardId)).toEqual(['pb-edge-from', 'pb-edge-to']);
    expect(nextCursor).toBeNull();
  });

  it('paginates chronologically with a stable opaque cursor', async () => {
    const db = new DatabaseManager(':memory:');
    const stamps = [
      '2026-09-10T10:00:00.000Z',
      '2026-09-10T10:00:01.000Z',
      '2026-09-10T10:00:02.000Z',
      '2026-09-10T10:00:03.000Z',
    ];
    for (const [index, occurredAt] of stamps.entries()) {
      await db.recordCardUsageEvent({
        cardType: 'service',
        cardId: `svc-${index}`,
        action: 'tool_call',
        success: true,
        source: 'agent',
        occurredAt,
      });
    }

    const first = await db.listCardUsageEvents({ from: FROM, to: TO, limit: 2 });
    expect(first.events.map((event) => event.cardId)).toEqual(['svc-0', 'svc-1']);
    expect(first.nextCursor).toBeTruthy();
    // Opaque: the cursor must not leak the raw event id.
    expect(first.nextCursor!).not.toContain(first.events[1].id);

    const second = await db.listCardUsageEvents({
      from: FROM,
      to: TO,
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.events.map((event) => event.cardId)).toEqual(['svc-2', 'svc-3']);
    expect(second.nextCursor).toBeNull();

    // Re-running the first page is deterministic.
    const replay = await db.listCardUsageEvents({ from: FROM, to: TO, limit: 2 });
    expect(replay.nextCursor).toBe(first.nextCursor);
    expect(replay.events.map((event) => event.id)).toEqual(
      first.events.map((event) => event.id),
    );
  });

  it('orders same-timestamp events deterministically by id', async () => {
    const db = new DatabaseManager(':memory:');
    const at = '2026-09-15T00:00:00.000Z';
    const ids = ['id-c', 'id-a', 'id-b'];
    for (const id of ids) {
      await db.recordCardUsageEvent({
        id,
        cardType: 'credential',
        cardId: 'cred-1',
        action: 'service_call',
        source: 'agent',
        occurredAt: at,
      });
    }
    const { events } = await db.listCardUsageEvents({ from: FROM, to: TO, limit: 10 });
    expect(events.map((event) => event.id)).toEqual(['id-a', 'id-b', 'id-c']);

    const cursor = DatabaseManager.encodeCardUsageCursor(at, 'id-a');
    const rest = await db.listCardUsageEvents({ from: FROM, to: TO, cursor, limit: 10 });
    expect(rest.events.map((event) => event.id)).toEqual(['id-b', 'id-c']);
  });

  it('rejects malformed cursors', async () => {
    const db = new DatabaseManager(':memory:');
    await expect(
      db.listCardUsageEvents({ from: FROM, to: TO, cursor: 'not-a-cursor!!', limit: 10 }),
    ).rejects.toThrow('Invalid cursor');
    await expect(
      db.listCardUsageEvents({ from: FROM, to: TO, cursor: 'e30=', limit: 10 }),
    ).rejects.toThrow('Invalid cursor');
  });
});
