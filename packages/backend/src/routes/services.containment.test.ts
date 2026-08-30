import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { registerServiceRoutes } from './services';
import { TrustedSessionStore, generateGrantSecret } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';

describe('service route containment (NOT-44)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(`:memory:${Math.random()}`);
    const boundDeck = await db.createDeck({ name: 'bound' });
    await db.createDeck({ name: 'other' });

    const serviceOnBound = await db.createService({
      name: 'bound-svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp',
    });
    const serviceOffDeck = await db.createService({
      name: 'other-svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/other',
    });
    await db.addServiceToDeck({ deckId: boundDeck.id, serviceId: serviceOnBound.id, position: 0 });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const workspace = store.getOrCreateWorkspaceKey('ws-digest');
    const secret = generateGrantSecret();
    const pending = store.createPendingGrant(workspace.id, boundDeck.id, secret);
    store.activateGrant(pending.id);
    const grant = store.findActiveGrantBySecret(secret)!;
    const session = store.createRuntimeSession({
      workspaceKeyId: workspace.id,
      workspaceGrantId: grant.id,
      deckId: boundDeck.id,
    });

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('serviceManager', {
      discoverServiceTools: async () => [],
      callServiceTool: async () => ({ success: true, result: {} }),
      getAllServices: async () => [serviceOnBound, serviceOffDeck],
      getService: async (id: string) =>
        id === serviceOnBound.id ? serviceOnBound : id === serviceOffDeck.id ? serviceOffDeck : null,
    } as unknown as ServiceManager);
    fastify.decorate('broadcastServiceUpdate', () => {});

    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, sessionId: session.sessionId, serviceOnBound, serviceOffDeck };
  }

  it('denies agent access to tools on a service outside the bound deck', async () => {
    const { fastify, sessionId, serviceOffDeck } = await buildApp();
    const response = await fastify.inject({
      method: 'GET',
      url: `/api/services/${serviceOffDeck.id}/tools`,
      headers: { [AGENT_DECK_SESSION_HEADER]: sessionId },
    });

    expect(response.statusCode).toBe(403);
    const body = response.json() as { error_code?: string };
    expect(body.error_code).toBe('RESOURCE_OUT_OF_SCOPE');
  });

  it('allows agent access to tools on a bound-deck service', async () => {
    const { fastify, sessionId, serviceOnBound } = await buildApp();
    const response = await fastify.inject({
      method: 'GET',
      url: `/api/services/${serviceOnBound.id}/tools`,
      headers: { [AGENT_DECK_SESSION_HEADER]: sessionId },
    });

    expect(response.statusCode).toBe(200);
  });
});
