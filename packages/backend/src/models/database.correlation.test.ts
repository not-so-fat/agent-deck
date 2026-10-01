import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from './database';

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-09-30T00:00:00.000Z';
const CORRELATION = '123e4567-e89b-42d3-a456-426614174000';
const OTHER = 'dealer-run_other001';

const tempFiles: string[] = [];
afterEach(() => {
  while (tempFiles.length) {
    const file = tempFiles.pop()!;
    try {
      fs.unlinkSync(file);
    } catch {
      // already removed
    }
  }
});

function tempDbPath(): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-corr-')),
    'test.db',
  );
  tempFiles.push(file);
  return file;
}

/** A pre-NOT-304 store: card_usage_events without the correlation column. */
function writeLegacyStore(dbPath: string): void {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE card_usage_events (
      id TEXT PRIMARY KEY,
      card_type TEXT NOT NULL,
      card_id TEXT NOT NULL,
      deck_id TEXT,
      action TEXT NOT NULL,
      success INTEGER,
      source TEXT NOT NULL,
      session_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
  raw
    .prepare(
      `INSERT INTO card_usage_events
        (id, card_type, card_id, deck_id, action, success, source, session_id, created_at)
       VALUES
        ('legacy-1', 'playbook', 'pb-legacy', 'deck-1', 'fetch', 1, 'agent', 'hashed', '2026-09-10T10:00:00.000Z')`,
    )
    .run();
  raw.close();
}

describe('card usage correlation id (NOT-304)', () => {
  it('migrates legacy stores: old rows read back with correlationId null', async () => {
    const dbPath = tempDbPath();
    writeLegacyStore(dbPath);

    const db = new DatabaseManager(dbPath);
    const { events } = await db.listCardUsageEvents({ from: FROM, to: TO, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'legacy-1', correlationId: null });

    const columns = db
      .getSqliteDatabase()
      .prepare('PRAGMA table_info(card_usage_events)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('correlation_id');

    const index = db
      .getSqliteDatabase()
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_card_usage_correlation'",
      )
      .get();
    expect(index).toBeDefined();
  });

  it('persists the exact correlation id on service, credential, and playbook events', async () => {
    const db = new DatabaseManager(':memory:');
    for (const cardType of ['service', 'credential', 'playbook'] as const) {
      await db.recordCardUsageEvent({
        cardType,
        cardId: `${cardType}-1`,
        deckId: 'deck-1',
        action: 'fetch',
        success: true,
        source: 'agent',
        correlationId: CORRELATION,
        occurredAt: '2026-09-10T10:00:00.000Z',
      });
    }
    const { events } = await db.listCardUsageEvents({ from: FROM, to: TO, limit: 10 });
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.correlationId).toBe(CORRELATION);
    }
    // Stored verbatim — opaque, never hashed or interpreted.
    const raw = db
      .getSqliteDatabase()
      .prepare('SELECT correlation_id FROM card_usage_events')
      .all() as Array<{ correlation_id: string }>;
    expect(raw.every((row) => row.correlation_id === CORRELATION)).toBe(true);
  });

  it('drops invalid correlation input instead of persisting task content', async () => {
    const db = new DatabaseManager(':memory:');
    const event = await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-1',
      action: 'fetch',
      source: 'agent',
      correlationId: 'not-so-fat/agent_deck',
      occurredAt: '2026-09-10T10:00:00.000Z',
    });
    expect(event.correlationId).toBeNull();
    const { events } = await db.listCardUsageEvents({ from: FROM, to: TO, limit: 10 });
    expect(events[0].correlationId).toBeNull();
  });

  it('leaves correlationId null when no value is supplied', async () => {
    const db = new DatabaseManager(':memory:');
    const event = await db.recordCardUsageEvent({
      cardType: 'service',
      cardId: 'svc-1',
      action: 'tool_call',
      source: 'ide',
      occurredAt: '2026-09-10T10:00:00.000Z',
    });
    expect(event.correlationId).toBeNull();
  });

  it('filters by exact correlation id', async () => {
    const db = new DatabaseManager(':memory:');
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-match',
      action: 'fetch',
      source: 'agent',
      correlationId: CORRELATION,
      occurredAt: '2026-09-10T10:00:00.000Z',
    });
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-other',
      action: 'fetch',
      source: 'agent',
      correlationId: OTHER,
      occurredAt: '2026-09-10T10:00:01.000Z',
    });
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-legacy',
      action: 'fetch',
      source: 'agent',
      occurredAt: '2026-09-10T10:00:02.000Z',
    });

    const matched = await db.listCardUsageEvents({
      from: FROM,
      to: TO,
      limit: 10,
      correlationId: CORRELATION,
    });
    expect(matched.events.map((event) => event.cardId)).toEqual(['pb-match']);
    expect(matched.nextCursor).toBeNull();

    // Without the filter the full stream is preserved.
    const all = await db.listCardUsageEvents({ from: FROM, to: TO, limit: 10 });
    expect(all.events).toHaveLength(3);
  });

  it('rejects invalid correlation filters instead of matching broadly', async () => {
    const db = new DatabaseManager(':memory:');
    await expect(
      db.listCardUsageEvents({
        from: FROM,
        to: TO,
        limit: 10,
        correlationId: 'not-so-fat/agent_deck',
      }),
    ).rejects.toThrow('Invalid correlationId');
  });

  it('scopes by deck id for the coordinator read path', async () => {
    const db = new DatabaseManager(':memory:');
    for (const [cardId, deckId] of [
      ['pb-a', 'deck-a'],
      ['pb-b', 'deck-b'],
    ] as const) {
      await db.recordCardUsageEvent({
        cardType: 'playbook',
        cardId,
        deckId,
        action: 'fetch',
        source: 'agent',
        correlationId: CORRELATION,
        occurredAt: '2026-09-10T10:00:00.000Z',
      });
    }
    const scoped = await db.listCardUsageEvents({
      from: FROM,
      to: TO,
      limit: 10,
      correlationId: CORRELATION,
      deckId: 'deck-a',
    });
    expect(scoped.events.map((event) => event.cardId)).toEqual(['pb-a']);
  });

  it('keeps stable chronological cursor pagination within a correlation filter', async () => {
    const db = new DatabaseManager(':memory:');
    const stamps = [
      '2026-09-10T10:00:00.000Z',
      '2026-09-10T10:00:01.000Z',
      '2026-09-10T10:00:02.000Z',
    ];
    for (const [index, occurredAt] of stamps.entries()) {
      await db.recordCardUsageEvent({
        cardType: 'service',
        cardId: `svc-match-${index}`,
        action: 'tool_call',
        source: 'agent',
        correlationId: CORRELATION,
        occurredAt,
      });
      // Interleaved noise from another run must not disturb the pages.
      await db.recordCardUsageEvent({
        cardType: 'service',
        cardId: `svc-noise-${index}`,
        action: 'tool_call',
        source: 'agent',
        correlationId: OTHER,
        occurredAt,
      });
    }

    const first = await db.listCardUsageEvents({
      from: FROM,
      to: TO,
      limit: 2,
      correlationId: CORRELATION,
    });
    expect(first.events.map((event) => event.cardId)).toEqual([
      'svc-match-0',
      'svc-match-1',
    ]);
    expect(first.nextCursor).toBeTruthy();

    const second = await db.listCardUsageEvents({
      from: FROM,
      to: TO,
      limit: 2,
      correlationId: CORRELATION,
      cursor: first.nextCursor,
    });
    expect(second.events.map((event) => event.cardId)).toEqual(['svc-match-2']);
    expect(second.nextCursor).toBeNull();
  });
});
