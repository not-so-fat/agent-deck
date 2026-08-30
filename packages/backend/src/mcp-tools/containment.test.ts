import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { generateId } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import type { AgentDeckMCPServer } from '../mcp-server';
import { registerCredentialRoutes } from '../routes/credentials';
import { registerDeckRoutes } from '../routes/decks';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerServiceRoutes } from '../routes/services';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore, generateGrantSecret } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';
import {
  callToolMcpResult,
  openSession,
  startMcpServer,
} from './test-harness';

describe('MCP bound-deck containment (NOT-44)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  let mcpServer: AgentDeckMCPServer | undefined;

  afterEach(async () => {
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = undefined;
    }
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildListeningBackend() {
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
    const workspace = store.getOrCreateWorkspaceKey('mcp-not-44');
    const secret = generateGrantSecret();
    const pending = store.createPendingGrant(workspace.id, boundDeck.id, secret);
    store.activateGrant(pending.id);

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('serviceManager', {
      discoverServiceTools: async () => [{ name: 'ping', description: 'Ping' }],
      callServiceTool: async () => ({ success: true, result: { ok: true } }),
      getAllServices: async () => [serviceOnBound, serviceOffDeck],
      getService: async (id: string) =>
        id === serviceOnBound.id ? serviceOnBound : id === serviceOffDeck.id ? serviceOffDeck : null,
      updateToolSettings: async (id: string) =>
        id === serviceOnBound.id ? serviceOnBound : null,
    } as unknown as ServiceManager);
    fastify.decorate('credentialManager', {
      get: async (id: string) => ({ id, name: 'key', type: 'api_key' }),
      listForDeck: async () => [],
      isCredentialOnDeck: async () => false,
    });
    fastify.decorate('playbookManager', {
      getWithDependencies: async () => null,
      listSummariesForDeck: async () => [],
      listForDeck: async () => [],
      isPlaybookOnDeck: async () => false,
      createWithDependencies: async () => ({
        id: generateId(),
        title: 'pb',
        body: 'body',
        triggers: ['t'],
      }),
      updateWithDependencies: async () => null,
      delete: async () => true,
    });
    fastify.decorate('patchManager', { listOpenPatchSummaries: async () => [], snapshotVersion: async () => {} });
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });

    registerHttpPolicyHook(fastify);
    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.register(registerCredentialRoutes, { prefix: '/api/credentials' });
    await fastify.register(registerDeckRoutes, { prefix: '/api/decks', storeWriter: { writeDeck: async () => {} } });
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    servers.push(fastify);

    const address = fastify.server.address();
    const backendPort =
      typeof address === 'object' && address && 'port' in address ? address.port : 0;

    return {
      backendUrl: `http://127.0.0.1:${backendPort}`,
      grantSecret: secret,
      serviceOnBound,
      serviceOffDeck,
    };
  }

  it('list_service_tools returns RESOURCE_OUT_OF_SCOPE for off-deck service', async () => {
    const { backendUrl, grantSecret, serviceOffDeck } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const sessionId = await openSession(started.port, 1, grantSecret);
    const result = await callToolMcpResult(started.port, sessionId, 'list_service_tools', {
      serviceId: serviceOffDeck.id,
    }, 2);

    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });
  });

  it('call_service_tool returns RESOURCE_OUT_OF_SCOPE for off-deck service', async () => {
    const { backendUrl, grantSecret, serviceOffDeck } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const sessionId = await openSession(started.port, 1, grantSecret);
    const result = await callToolMcpResult(started.port, sessionId, 'call_service_tool', {
      serviceId: serviceOffDeck.id,
      toolName: 'ping',
      arguments: {},
    }, 2);

    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });
  });

  it('list_service_tools succeeds for on-deck service', async () => {
    const { backendUrl, grantSecret, serviceOnBound } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const sessionId = await openSession(started.port, 1, grantSecret);
    const result = await callToolMcpResult(started.port, sessionId, 'list_service_tools', {
      serviceId: serviceOnBound.id,
    }, 2);

    expect(result.isError).toBe(false);
  });
});
