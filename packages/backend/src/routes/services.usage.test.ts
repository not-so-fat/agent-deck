import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_CLIENT_HEADER, AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { DatabaseManager, hashCardUsageSessionId } from '../models/database';
import { TrustedSessionStore } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';
import { registerServiceRoutes } from './services';

type CallBehavior =
  | { kind: 'success' }
  | { kind: 'failure' }
  | { kind: 'throw' };

describe('service tool-call usage events (NOT-292)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp(behavior: CallBehavior) {
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
    const plainService = await db.createService({
      name: 'plain-svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp',
    });
    const credentialedService = await db.createService({
      name: 'cred-svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/cred',
      credentialId: credential.id,
    });
    await db.addServiceToDeck({ deckId: boundDeck.id, serviceId: plainService.id, position: 0 });
    await db.addServiceToDeck({
      deckId: boundDeck.id,
      serviceId: credentialedService.id,
      position: 1,
    });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const session = store.createRuntimeSession({ deckId: boundDeck.id });

    const callServiceTool = async () => {
      if (behavior.kind === 'throw') {
        throw new Error('transport exploded');
      }
      if (behavior.kind === 'failure') {
        return { success: false, error: 'tool failed' };
      }
      return { success: true, result: { ok: true } };
    };

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('serviceManager', {
      callServiceTool,
      getService: async (id: string) => db.getService(id),
      getAllServices: async () => [plainService, credentialedService],
      discoverServiceTools: async () => [],
    } as unknown as ServiceManager);
    fastify.decorate('broadcastServiceUpdate', () => {});

    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.ready();
    servers.push(fastify);

    const headers = {
      [AGENT_DECK_SESSION_HEADER]: session.sessionId,
      [AGENT_DECK_CLIENT_HEADER]: 'ide',
    };
    return { fastify, db, headers, session, boundDeck, plainService, credentialedService, credential };
  }

  async function usageEvents(db: DatabaseManager) {
    const { events } = await db.listCardUsageEvents({
      from: '2000-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
      limit: 50,
    });
    return events;
  }

  it('persists one successful service event for a tool call', async () => {
    const { fastify, db, headers, session, boundDeck, plainService } =
      await buildApp({ kind: 'success' });

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/services/${plainService.id}/call`,
      headers,
      payload: { toolName: 'search', arguments: { q: 'secret query' } },
    });
    expect(response.statusCode).toBe(200);

    const events = await usageEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cardType: 'service',
      cardId: plainService.id,
      deckId: boundDeck.id,
      action: 'tool_call',
      success: true,
      source: 'ide',
      sessionId: hashCardUsageSessionId(session.sessionId),
    });
    // The persisted event carries no request payload.
    expect(JSON.stringify(events[0])).not.toContain('secret query');
  });

  it('never persists the raw session bearer — only its one-way hash', async () => {
    const { fastify, db, headers, session, plainService } =
      await buildApp({ kind: 'success' });

    await fastify.inject({
      method: 'POST',
      url: `/api/services/${plainService.id}/call`,
      headers,
      payload: { toolName: 'search', arguments: {} },
    });

    const events = await usageEvents(db);
    expect(events).toHaveLength(1);
    // The live bearer could authenticate as the agent on its own, so it
    // must never be stored verbatim where the usage API can return it.
    expect(events[0].sessionId).not.toBe(session.sessionId);
    expect(events[0].sessionId).toBe(hashCardUsageSessionId(session.sessionId));
    expect(JSON.stringify(events)).not.toContain(session.sessionId);
  });

  it('normalizes unknown client sources instead of storing them verbatim', async () => {
    const { fastify, db, headers, plainService } = await buildApp({ kind: 'success' });

    await fastify.inject({
      method: 'POST',
      url: `/api/services/${plainService.id}/call`,
      headers: { ...headers, [AGENT_DECK_CLIENT_HEADER]: '<script>evil</script>' },
      payload: { toolName: 'search', arguments: {} },
    });

    const events = await usageEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe('rest');
  });

  it('persists one unsuccessful service event for a failed tool call', async () => {
    const { fastify, db, headers, plainService } = await buildApp({ kind: 'failure' });

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/services/${plainService.id}/call`,
      headers,
      payload: { toolName: 'search', arguments: {} },
    });
    expect(response.statusCode).toBe(200);

    const events = await usageEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cardType: 'service',
      cardId: plainService.id,
      action: 'tool_call',
      success: false,
    });
  });

  it('persists one unsuccessful service event when the call throws', async () => {
    const { fastify, db, headers, plainService } = await buildApp({ kind: 'throw' });

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/services/${plainService.id}/call`,
      headers,
      payload: { toolName: 'search', arguments: {} },
    });
    // A thrown call error surfaces as a 400 (pre-existing mapping) …
    expect(response.statusCode).toBe(400);
    expect(response.json().success).toBe(false);

    // … and still persists one unsuccessful service event.
    const events = await usageEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cardType: 'service', success: false });
  });

  it('persists a credential-use event without secrets on successful credential-backed calls', async () => {
    const { fastify, db, headers, credentialedService, credential } =
      await buildApp({ kind: 'success' });

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/services/${credentialedService.id}/call`,
      headers,
      payload: { toolName: 'search', arguments: {} },
    });
    expect(response.statusCode).toBe(200);

    const events = await usageEvents(db);
    expect(events).toHaveLength(2);
    const credentialEvent = events.find((event) => event.cardType === 'credential');
    expect(credentialEvent).toMatchObject({
      cardId: credential.id,
      action: 'service_call',
      success: true,
      source: 'ide',
    });
    // Only the credential id is stored — no secret, header, URL, or key material.
    expect(Object.keys(credentialEvent!).sort()).toEqual(
      ['action', 'cardId', 'cardType', 'correlationId', 'createdAt', 'deckId', 'id', 'sessionId', 'source', 'success'].sort(),
    );
  });

  it('persists no credential event when a credential-backed call fails', async () => {
    const { fastify, db, headers, credentialedService } = await buildApp({ kind: 'failure' });

    await fastify.inject({
      method: 'POST',
      url: `/api/services/${credentialedService.id}/call`,
      headers,
      payload: { toolName: 'search', arguments: {} },
    });

    const events = await usageEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0].cardType).toBe('service');
  });

  it('keeps the seeded service observation start across calls', async () => {
    const { fastify, db, headers, plainService } = await buildApp({ kind: 'success' });
    const before = await db.getUsageObservationStart('service');
    expect(before).toBeTruthy();

    await fastify.inject({
      method: 'POST',
      url: `/api/services/${plainService.id}/call`,
      headers,
      payload: { toolName: 'search', arguments: {} },
    });

    const start = await db.getUsageObservationStart('service');
    expect(start).toBe(before);
    expect(Number.isNaN(Date.parse(start!))).toBe(false);
  });
});
