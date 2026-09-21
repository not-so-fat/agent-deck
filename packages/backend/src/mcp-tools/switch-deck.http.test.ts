/**
 * NOT-209: request-only switch_deck MCP tool.
 * Runs against the real HTTP policy layer (strict SKIP flags off).
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_DECK_DECK_ID_HEADER,
  generateId,
} from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import type { AgentDeckMCPServer } from '../mcp-server';
import { registerCredentialRoutes } from '../routes/credentials';
import { registerDeckRoutes } from '../routes/decks';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerScopeRoutes } from '../routes/scope';
import { registerServiceRoutes } from '../routes/services';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';
import {
  callToolMcpResult,
  openSession,
  startMcpServer,
} from './test-harness';

describe('MCP request-only switch_deck (NOT-209)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  let mcpServer: AgentDeckMCPServer | undefined;
  let previousSkipDeckHeader: string | undefined;
  let previousSkipAdmin: string | undefined;
  let previousStubSync: string | undefined;

  beforeEach(() => {
    previousSkipDeckHeader = process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    previousSkipAdmin = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    previousStubSync = process.env.AGENT_DECK_STUB_SYNC;
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = '0';
    process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = '0';
    process.env.AGENT_DECK_STUB_SYNC = 'off';
  });

  afterEach(async () => {
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = undefined;
    }
    while (servers.length) {
      await servers.pop()?.close();
    }
    if (previousSkipDeckHeader === undefined) {
      delete process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    } else {
      process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = previousSkipDeckHeader;
    }
    if (previousSkipAdmin === undefined) {
      delete process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    } else {
      process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = previousSkipAdmin;
    }
    if (previousStubSync === undefined) {
      delete process.env.AGENT_DECK_STUB_SYNC;
    } else {
      process.env.AGENT_DECK_STUB_SYNC = previousStubSync;
    }
  });

  async function buildListeningBackend() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'alpha' });
    const deckB = await db.createDeck({ name: 'beta' });

    const serviceOnA = await db.createService({
      name: 'svc-a',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp-a',
    });
    const serviceOnB = await db.createService({
      name: 'svc-b',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp-b',
    });
    await db.addServiceToDeck({ deckId: deckA.id, serviceId: serviceOnA.id, position: 0 });
    await db.addServiceToDeck({ deckId: deckB.id, serviceId: serviceOnB.id, position: 0 });

    const store = new TrustedSessionStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('serviceManager', {
      discoverServiceTools: async () => [{ name: 'ping', description: 'Ping' }],
      callServiceTool: async () => ({ success: true, result: { ok: true } }),
      getAllServices: async () => [serviceOnA, serviceOnB],
      getService: async (id: string) =>
        id === serviceOnA.id ? serviceOnA : id === serviceOnB.id ? serviceOnB : null,
      updateToolSettings: async (id: string) =>
        id === serviceOnA.id ? serviceOnA : null,
    } as unknown as ServiceManager);
    fastify.decorate('credentialManager', {
      get: async (id: string) => ({ id, name: 'key', type: 'api_key' }),
      listForDeck: async () => [],
      isCredentialOnDeck: async () => false,
      applySecretStatus: async (credentials: unknown[]) => credentials,
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
    fastify.decorate('patchManager', {
      listOpenPatchSummaries: async () => [],
      snapshotVersion: async () => {},
    });
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });

    registerHttpPolicyHook(fastify);
    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.register(registerCredentialRoutes, { prefix: '/api/credentials' });
    await fastify.register(registerDeckRoutes, {
      prefix: '/api/decks',
      storeWriter: { writeDeck: async () => {} },
    });
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.register(registerScopeRoutes, { prefix: '/api/scope' });
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    servers.push(fastify);

    const address = fastify.server.address();
    const backendPort =
      typeof address === 'object' && address && 'port' in address ? address.port : 0;

    return {
      backendUrl: `http://127.0.0.1:${backendPort}`,
      deckA,
      deckB,
      serviceOnA,
      serviceOnB,
      store,
    };
  }

  it('creates a pending request and keeps deck/service routing on the active deck', async () => {
    const { backendUrl, deckA, deckB, serviceOnB } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const headersA = { [AGENT_DECK_DECK_ID_HEADER]: deckA.id };
    const sessionId = await openSession(started.port, 1, headersA);

    const requested = await callToolMcpResult(
      started.port,
      sessionId,
      'switch_deck',
      { target: 'beta' },
      2,
      headersA,
    );

    expect(requested.isError).toBe(false);
    expect(requested.data.status).toBe('pending');
    expect(typeof requested.data.requestId).toBe('string');
    expect(String(requested.data.requestId).length).toBeGreaterThan(0);
    expect(requested.data.currentDeckName).toBe('alpha');
    expect(requested.data.requestedDeckName).toBe('beta');
    expect(requested.data.presentation).toMatchObject({ kind: 'deck_switch_request' });

    // Active deck and routing still resolve against A while pending.
    const bound = await callToolMcpResult(started.port, sessionId, 'get_bound_deck', {}, 3, headersA);
    expect(bound.isError).toBe(false);
    expect(bound.data.id).toBe(deckA.id);

    const binding = await callToolMcpResult(
      started.port,
      sessionId,
      'get_session_binding',
      {},
      4,
      headersA,
    );
    expect(binding.isError).toBe(false);
    expect(binding.data.effective_deck_id).toBe(deckA.id);

    const decks = await callToolMcpResult(started.port, sessionId, 'get_decks', {}, 5, headersA);
    expect(decks.isError).toBe(false);
    expect(decks.data).toMatchObject([{ id: deckA.id }]);

    const offDeckTools = await callToolMcpResult(
      started.port,
      sessionId,
      'list_service_tools',
      { serviceId: serviceOnB.id },
      6,
      headersA,
    );
    expect(offDeckTools.isError).toBe(true);
    expect(offDeckTools.data).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });

    const offDeckCall = await callToolMcpResult(
      started.port,
      sessionId,
      'call_service_tool',
      { serviceId: serviceOnB.id, toolName: 'ping', arguments: {} },
      7,
      headersA,
    );
    expect(offDeckCall.isError).toBe(true);
    expect(offDeckCall.data).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });

    // The requested deck id is stable and matches deck B.
    expect(requested.data.requestedDeckId).toBe(deckB.id);
  });

  it('repeating an identical request returns the same request without opening another approval', async () => {
    const { backendUrl, deckA, deckB, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const headersA = { [AGENT_DECK_DECK_ID_HEADER]: deckA.id };
    const sessionId = await openSession(started.port, 1, headersA);

    const first = await callToolMcpResult(
      started.port,
      sessionId,
      'switch_deck',
      { target: 'beta' },
      2,
      headersA,
    );
    expect(first.isError).toBe(false);

    // Same target by id resolves to the same pending request.
    const second = await callToolMcpResult(
      started.port,
      sessionId,
      'switch_deck',
      { target: deckB.id },
      3,
      headersA,
    );
    expect(second.isError).toBe(false);
    expect(second.data.requestId).toBe(first.data.requestId);
    expect(second.data.status).toBe('pending');

    const runtimeSessionId = store.findActiveRuntimeSessionByMcpSessionId(sessionId)?.sessionId;
    expect(runtimeSessionId).toBeTruthy();
    expect(store.listPendingDeckSwitchRequests(runtimeSessionId!).length).toBe(1);
  });

  it('unknown target fails without revealing deck contents or changing the binding', async () => {
    const { backendUrl, deckA, serviceOnB, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const headersA = { [AGENT_DECK_DECK_ID_HEADER]: deckA.id };
    const sessionId = await openSession(started.port, 1, headersA);

    const failed = await callToolMcpResult(
      started.port,
      sessionId,
      'switch_deck',
      { target: 'no-such-deck' },
      2,
      headersA,
    );
    expect(failed.isError).toBe(true);
    // No deck contents leak through the failure.
    expect(JSON.stringify(failed.data)).not.toContain('svc-b');
    expect(JSON.stringify(failed.data)).not.toContain('beta');
    expect(failed.data.requestId).toBeUndefined();

    const runtimeSessionId = store.findActiveRuntimeSessionByMcpSessionId(sessionId)?.sessionId;
    expect(runtimeSessionId).toBeTruthy();
    expect(store.listPendingDeckSwitchRequests(runtimeSessionId!)).toHaveLength(0);

    const bound = await callToolMcpResult(started.port, sessionId, 'get_bound_deck', {}, 3, headersA);
    expect(bound.isError).toBe(false);
    expect(bound.data.id).toBe(deckA.id);

    const offDeckTools = await callToolMcpResult(
      started.port,
      sessionId,
      'list_service_tools',
      { serviceId: serviceOnB.id },
      4,
      headersA,
    );
    expect(offDeckTools.data).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });
  });

  it('requesting the already-active deck opens no approval', async () => {
    const { backendUrl, deckA, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const headersA = { [AGENT_DECK_DECK_ID_HEADER]: deckA.id };
    const sessionId = await openSession(started.port, 1, headersA);

    const same = await callToolMcpResult(
      started.port,
      sessionId,
      'switch_deck',
      { target: deckA.id },
      2,
      headersA,
    );
    expect(same.isError).toBe(false);
    expect(same.data.status).toBe('already_on_deck');
    expect(same.data.requestId).toBeUndefined();

    const runtimeSessionId = store.findActiveRuntimeSessionByMcpSessionId(sessionId)?.sessionId;
    expect(runtimeSessionId).toBeTruthy();
    expect(store.listPendingDeckSwitchRequests(runtimeSessionId!)).toHaveLength(0);
  });

  it('embeds no approval capability or commit credential in the tool response', async () => {
    const { backendUrl, deckA } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const headersA = { [AGENT_DECK_DECK_ID_HEADER]: deckA.id };
    const sessionId = await openSession(started.port, 1, headersA);

    const requested = await callToolMcpResult(
      started.port,
      sessionId,
      'switch_deck',
      { target: 'beta' },
      2,
      headersA,
    );
    expect(requested.isError).toBe(false);

    const serialized = JSON.stringify(requested.data).toLowerCase();
    for (const forbidden of [
      'approv',
      'resolve',
      'commit',
      'token',
      'secret',
      'cookie',
      'bearer',
      'authoriz',
      'credential',
      'challenge',
      'http://',
      'https://',
      'ws://',
    ]) {
      expect(serialized, `response must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // No deck payload beyond display-safe id/name labels.
    expect(serialized).not.toContain('services');
    expect(serialized).not.toContain('playbook');
  });
});
