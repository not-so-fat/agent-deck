import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER, generateId } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { registerCredentialRoutes } from './credentials';
import { registerDeckRoutes } from './decks';
import { registerPlaybookRoutes } from './playbooks';
import { registerServiceRoutes } from './services';
import { TrustedSessionStore, generateGrantSecret } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';

describe('bound-deck containment verification (NOT-44)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(`:memory:${Math.random()}`);
    const boundDeck = await db.createDeck({ name: 'bound' });
    const otherDeck = await db.createDeck({ name: 'other' });

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

    const playbookOnBound = await db.createPlaybook({
      id: generateId(),
      title: 'on-deck',
      body: 'body',
      triggers: ['t'],
    });
    const playbookOffDeck = await db.createPlaybook({
      id: generateId(),
      title: 'off-deck',
      body: 'body',
      triggers: ['t'],
    });
    await db.addPlaybookToDeck({
      deckId: boundDeck.id,
      playbookId: playbookOnBound.id,
      position: 0,
    });
    await db.addPlaybookToDeck({
      deckId: otherDeck.id,
      playbookId: playbookOffDeck.id,
      position: 0,
    });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const workspace = store.getOrCreateWorkspaceKey('not-44');
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
      updateToolSettings: async (id: string) =>
        id === serviceOnBound.id ? serviceOnBound : null,
    } as unknown as ServiceManager);
    fastify.decorate('credentialManager', {
      get: async (id: string) => ({ id, name: 'key', type: 'api_key' }),
      listForDeck: async () => [],
      isCredentialOnDeck: async (deckId: string, credentialId: string) =>
        deckId === boundDeck.id && credentialId === 'cred-on',
    });
    fastify.decorate('playbookManager', {
      getWithDependencies: async (id: string) =>
        id === playbookOnBound.id
          ? { id, title: 'on-deck', body: 'body', triggers: ['t'], dependsOnCredentialIds: [], dependsOnServiceIds: [] }
          : id === playbookOffDeck.id
            ? { id, title: 'off-deck', body: 'body', triggers: ['t'], dependsOnCredentialIds: [], dependsOnServiceIds: [] }
            : null,
      listSummariesForDeck: async () => [],
      listForDeck: async () => [],
      isPlaybookOnDeck: async (deckId: string, playbookId: string) =>
        deckId === boundDeck.id && playbookId === playbookOnBound.id,
    });
    fastify.decorate('patchManager', { listOpenPatchSummaries: async () => [] });
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });

    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.register(registerCredentialRoutes, { prefix: '/api/credentials' });
    await fastify.register(registerDeckRoutes, { prefix: '/api/decks', storeWriter: { writeDeck: async () => {} } });
    await fastify.ready();
    servers.push(fastify);

    return {
      fastify,
      sessionId: session.sessionId,
      serviceOnBound,
      serviceOffDeck,
      playbookOnBound,
      playbookOffDeck,
      otherDeck,
      boundDeck,
    };
  }

  const agentHeaders = (sessionId: string) => ({
    [AGENT_DECK_SESSION_HEADER]: sessionId,
  });

  it('denies cross-deck service tools, call, and get', async () => {
    const { fastify, sessionId, serviceOffDeck } = await buildApp();

    for (const [method, url] of [
      ['GET', `/api/services/${serviceOffDeck.id}/tools`],
      ['GET', `/api/services/${serviceOffDeck.id}`],
      ['POST', `/api/services/${serviceOffDeck.id}/call`],
    ] as const) {
      const response = await fastify.inject({
        method,
        url,
        headers: agentHeaders(sessionId),
        payload: method === 'POST' ? { toolName: 'x', arguments: {} } : undefined,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });
    }
  });

  it('denies cross-deck playbook and credential reads', async () => {
    const { fastify, sessionId, playbookOffDeck } = await buildApp();

    const playbook = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${playbookOffDeck.id}`,
      headers: agentHeaders(sessionId),
    });
    expect(playbook.statusCode).toBe(403);
    expect(playbook.json()).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });

    const credential = await fastify.inject({
      method: 'GET',
      url: '/api/credentials/cred-off',
      headers: agentHeaders(sessionId),
    });
    expect(credential.statusCode).toBe(403);
    expect(credential.json()).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });
  });

  it('denies deck card mutation on a non-bound deck id', async () => {
    const { fastify, sessionId, otherDeck, boundDeck, serviceOnBound } = await buildApp();

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/decks/${otherDeck.id}/services`,
      headers: agentHeaders(sessionId),
      payload: { serviceId: serviceOnBound.id },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });
  });

  it('elevated agent still denied cross-deck service call', async () => {
    const { fastify, sessionId, serviceOffDeck } = await buildApp();
    fastify.trustedSessionStore.elevateSessionToAdmin(sessionId);

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/services/${serviceOffDeck.id}/call`,
      headers: agentHeaders(sessionId),
      payload: { toolName: 'x', arguments: {} },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });
  });

  it('denies agent read of another deck by id (no service leak)', async () => {
    const { fastify, sessionId, otherDeck } = await buildApp();

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/decks/${otherDeck.id}`,
      headers: agentHeaders(sessionId),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });
  });
});
