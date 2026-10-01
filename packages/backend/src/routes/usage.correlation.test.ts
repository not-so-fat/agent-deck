import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_DECK_CLIENT_HEADER,
  AGENT_DECK_CORRELATION_HEADER,
  AGENT_DECK_SESSION_HEADER,
  generateId,
} from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { TrustedSessionStore } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';
import { registerPlaybookRoutes } from './playbooks';
import { registerServiceRoutes } from './services';
import { registerUsageRoutes } from './usage';

const CORRELATION = '123e4567-e89b-42d3-a456-426614174000';
const OTHER = 'dealer-run_other001';

const RESPONSE_KEYS = [
  'action',
  'cardId',
  'cardType',
  'correlationId',
  'deckId',
  'occurredAt',
  'sessionId',
  'source',
  'success',
].sort();

describe('card usage correlation over HTTP (NOT-304)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildPlaybookApp() {
    const db = new DatabaseManager(':memory:');
    const boundDeck = await db.createDeck({ name: 'bound' });
    const otherDeck = await db.createDeck({ name: 'other' });
    const onDeck = await db.createPlaybook({
      id: generateId(),
      title: 'on-deck',
      body: 'body',
      triggers: ['t'],
    });
    const offDeck = await db.createPlaybook({
      id: generateId(),
      title: 'off-deck',
      body: 'body',
      triggers: ['t'],
    });
    await db.addPlaybookToDeck({ deckId: boundDeck.id, playbookId: onDeck.id, position: 0 });
    await db.addPlaybookToDeck({ deckId: otherDeck.id, playbookId: offDeck.id, position: 0 });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const session = store.createRuntimeSession({ deckId: boundDeck.id });

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('playbookManager', {
      getWithDependencies: async (id: string) =>
        [onDeck, offDeck].some((playbook) => playbook.id === id)
          ? {
              id,
              title: 'title',
              body: 'body',
              triggers: ['t'],
              dependsOnCredentialIds: [],
              dependsOnServiceIds: [],
            }
          : null,
    });
    fastify.decorate('patchManager', { listOpenPatchSummaries: async () => [] });

    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.ready();
    servers.push(fastify);
    return { fastify, db, store, session, boundDeck, onDeck, offDeck };
  }

  async function buildServiceApp() {
    const db = new DatabaseManager(':memory:');
    const boundDeck = await db.createDeck({ name: 'bound' });
    const credential = await db.createCredential({
      id: 'cred-1',
      label: 'api key',
      scheme: 'bearer',
      envName: 'TEST_API_KEY',
      keychainAccount: 'cred-1',
      tags: [],
      hasSecret: true,
    });
    const service = await db.createService({
      name: 'cred-svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/cred',
      credentialId: credential.id,
    });
    await db.addServiceToDeck({ deckId: boundDeck.id, serviceId: service.id, position: 0 });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const session = store.createRuntimeSession({ deckId: boundDeck.id });

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('serviceManager', {
      callServiceTool: async () => ({ success: true, result: { ok: true } }),
      getService: async (id: string) => db.getService(id),
      getAllServices: async () => [service],
      discoverServiceTools: async () => [],
    } as unknown as ServiceManager);
    fastify.decorate('broadcastServiceUpdate', () => {});

    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.ready();
    servers.push(fastify);
    return { fastify, db, session, boundDeck, service, credential };
  }

  async function buildUsageApp(db: DatabaseManager) {
    const fastify = Fastify();
    fastify.decorate('db', db);
    await fastify.register(registerUsageRoutes, { prefix: '/api/usage' });
    await fastify.ready();
    servers.push(fastify);
    return fastify;
  }

  async function allEvents(db: DatabaseManager) {
    const { events } = await db.listCardUsageEvents({
      from: '2000-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
      limit: 50,
    });
    return events;
  }

  it('stores the exact correlation id on every playbook fetch event', async () => {
    const { fastify, db, session, boundDeck, onDeck } = await buildPlaybookApp();

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${onDeck.id}`,
      headers: {
        [AGENT_DECK_SESSION_HEADER]: session.sessionId,
        [AGENT_DECK_CORRELATION_HEADER]: CORRELATION,
      },
    });
    expect(response.statusCode).toBe(200);

    const events = await allEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cardType: 'playbook',
      cardId: onDeck.id,
      deckId: boundDeck.id,
      correlationId: CORRELATION,
    });
  });

  it('stores the same correlation id on service and credential events from one call', async () => {
    const { fastify, db, session, service, credential } = await buildServiceApp();

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/services/${service.id}/call`,
      headers: {
        [AGENT_DECK_SESSION_HEADER]: session.sessionId,
        [AGENT_DECK_CLIENT_HEADER]: 'ide',
        [AGENT_DECK_CORRELATION_HEADER]: CORRELATION,
      },
      payload: { toolName: 'search', arguments: {} },
    });
    expect(response.statusCode).toBe(200);

    const events = await allEvents(db);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.correlationId).toBe(CORRELATION);
    }
    expect(events.map((event) => event.cardType)).toContain('credential');
    expect(events.find((event) => event.cardType === 'credential')?.cardId).toBe(
      credential.id,
    );
  });

  it('leaves correlationId null on the legacy path without the header', async () => {
    const { fastify, db, session, onDeck } = await buildPlaybookApp();

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${onDeck.id}`,
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
    });
    expect(response.statusCode).toBe(200);

    const events = await allEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].correlationId).toBeNull();
  });

  it('varying only the correlation header never changes the authorization outcome', async () => {
    const { fastify, session, onDeck, offDeck } = await buildPlaybookApp();
    const base = { [AGENT_DECK_SESSION_HEADER]: session.sessionId };

    // Same authorized fetch under absent / valid / different / invalid values.
    const variants: Record<string, string> = {
      absent: '',
      valid: CORRELATION,
      different: OTHER,
      invalid: 'not-so-fat/agent_deck',
    };
    const bodies = new Map<string, unknown>();
    for (const [name, value] of Object.entries(variants)) {
      const headers =
        name === 'absent' ? base : { ...base, [AGENT_DECK_CORRELATION_HEADER]: value };
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/playbooks/${onDeck.id}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      bodies.set(name, response.json().data?.id);
    }
    // Identical resource served in every variant.
    expect(new Set(bodies.values()).size).toBe(1);

    // Same denied fetch (off-deck card) in every variant — the correlation
    // header grants nothing and widens nothing.
    const denied = new Set<number>();
    for (const [name, value] of Object.entries(variants)) {
      const headers =
        name === 'absent' ? base : { ...base, [AGENT_DECK_CORRELATION_HEADER]: value };
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/playbooks/${offDeck.id}`,
        headers,
      });
      denied.add(response.statusCode);
    }
    expect(denied.size).toBe(1);
    expect([...denied][0]).not.toBe(200);
  });

  it('returns only matching events for an exact correlationId filter', async () => {
    const db = new DatabaseManager(':memory:');
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-match',
      deckId: 'deck-1',
      action: 'fetch',
      success: true,
      source: 'agent',
      correlationId: CORRELATION,
      occurredAt: '2026-09-10T10:00:00.000Z',
    });
    await db.recordCardUsageEvent({
      cardType: 'service',
      cardId: 'svc-other',
      deckId: 'deck-1',
      action: 'tool_call',
      success: true,
      source: 'agent',
      correlationId: OTHER,
      occurredAt: '2026-09-10T10:00:01.000Z',
    });
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-legacy',
      deckId: null,
      action: 'fetch',
      success: true,
      source: 'agent',
      occurredAt: '2026-09-10T10:00:02.000Z',
    });
    const fastify = await buildUsageApp(db);

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/usage/events?from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z&correlationId=${CORRELATION}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.events.map((event: { cardId: string }) => event.cardId)).toEqual([
      'pb-match',
    ]);
    expect(body.data.events[0].correlationId).toBe(CORRELATION);
    expect(body.data.nextCursor).toBeNull();
  });

  it('rejects invalid correlationId filters instead of matching broadly', async () => {
    const db = new DatabaseManager(':memory:');
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-1',
      action: 'fetch',
      source: 'agent',
      correlationId: CORRELATION,
      occurredAt: '2026-09-10T10:00:00.000Z',
    });
    const fastify = await buildUsageApp(db);

    for (const bad of ['not-so-fat/agent_deck', 'Fix the bug', 'x'.repeat(129), 'short']) {
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/usage/events?from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z&correlationId=${encodeURIComponent(bad)}`,
      });
      expect(response.statusCode).toBe(400);
    }
    // The stored event is untouched by the rejected filters.
    const { events } = await db.listCardUsageEvents({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-30T00:00:00.000Z',
      limit: 10,
    });
    expect(events).toHaveLength(1);
  });

  it('paginates a correlation-filtered stream with a stable cursor', async () => {
    const db = new DatabaseManager(':memory:');
    for (let index = 0; index < 3; index += 1) {
      await db.recordCardUsageEvent({
        cardType: 'service',
        cardId: `svc-${index}`,
        action: 'tool_call',
        success: true,
        source: 'agent',
        correlationId: CORRELATION,
        occurredAt: `2026-09-10T10:00:0${index}.000Z`,
      });
    }
    const fastify = await buildUsageApp(db);
    const base =
      '/api/usage/events?from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z' +
      `&correlationId=${CORRELATION}&limit=2`;

    const first = await fastify.inject({ method: 'GET', url: base });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.data.events.map((event: { cardId: string }) => event.cardId)).toEqual([
      'svc-0',
      'svc-1',
    ]);
    expect(firstBody.data.nextCursor).toBeTruthy();

    const second = await fastify.inject({
      method: 'GET',
      url: `${base}&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.data.events.map((event: { cardId: string }) => event.cardId)).toEqual([
      'svc-2',
    ]);
    expect(secondBody.data.nextCursor).toBeNull();
  });

  it('exposes only the allowlisted public fields including correlationId', async () => {
    const db = new DatabaseManager(':memory:');
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-1',
      deckId: 'deck-1',
      action: 'fetch',
      success: true,
      source: 'agent',
      sessionId: 'ses_live_bearer_value',
      correlationId: CORRELATION,
      occurredAt: '2026-09-10T10:00:00.000Z',
    });
    const fastify = await buildUsageApp(db);

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/usage/events?from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z&correlationId=${CORRELATION}`,
    });
    expect(response.statusCode).toBe(200);
    const events = response.json().data.events;
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]).sort()).toEqual(RESPONSE_KEYS);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('ses_live_bearer_value');
    expect(serialized).not.toMatch(/repository|prompt|argument|result|header|secret/i);
    expect(events[0].correlationId).toBe(CORRELATION);
  });
});
