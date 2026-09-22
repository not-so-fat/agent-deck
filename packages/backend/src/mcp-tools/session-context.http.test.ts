/**
 * NOT-189: one-call session context bootstrap (get_session_context).
 *
 * A single read-only call must return the binding identity plus the deck
 * cards that previously required get_session_binding + get_bound_deck.
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_DECK_ID_HEADER } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import type { AgentDeckMCPServer } from '../mcp-server';
import { PatchManager } from '../playbooks/patch-manager';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { registerCredentialRoutes } from '../routes/credentials';
import { registerDeckRoutes } from '../routes/decks';
import { registerPlaybookPatchRoutes } from '../routes/playbook-patches';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerScopeRoutes } from '../routes/scope';
import { registerServiceRoutes } from '../routes/services';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { LiveDisplayRegistry } from '../scope/live-display-registry';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';
import {
  callToolMcpResult,
  listTools,
  openSession,
  postInitialize,
  startMcpServer,
} from './test-harness';
import { UNASSIGNED_DECK_MESSAGE, unassignedDeckBinding } from '../mcp-unassigned';

const REQUIRED_CONTEXT_FIELDS = [
  'workspaceRoot',
  'effective_deck_id',
  'effective_deck_name',
  'effective_deck_source',
  'badge',
  'display_summary',
  'services',
  'credentials',
  'playbooks',
] as const;

describe('MCP session context bootstrap (NOT-189)', () => {
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
    const deckAlpha = await db.createDeck({ name: 'alpha' });
    const service = await db.createService({
      name: 'linear',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp',
    });
    await db.addServiceToDeck({ deckId: deckAlpha.id, serviceId: service.id, position: 0 });
    const credential = await db.createCredential({
      id: 'cred_alpha_test',
      label: 'Alpha key',
      scheme: 'bearer',
      envName: 'ALPHA_API_KEY',
      keychainAccount: 'cred_alpha_test',
      tags: [],
      hasSecret: false,
    });
    await db.addCredentialToDeck({
      deckId: deckAlpha.id,
      credentialId: credential.id,
      position: 0,
    });
    const playbook = await db.createPlaybook({
      id: 'pb_context_http_test',
      title: 'context-pb',
      body: '## Gotchas\n- Keep it short.\n',
      triggers: ['context trigger'],
    });
    await db.addPlaybookToDeck({ deckId: deckAlpha.id, playbookId: playbook.id, position: 0 });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const liveDisplayRegistry = new LiveDisplayRegistry();

    const playbookManager = new PlaybookManager(db);
    const patchManager = new PatchManager(db, playbookManager);

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('liveDisplayRegistry', liveDisplayRegistry);
    fastify.decorate('serviceManager', {
      discoverServiceTools: async () => [],
      callServiceTool: async () => ({ success: true, result: {} }),
      getAllServices: async () => [service],
      getService: async (id: string) => (id === service.id ? service : null),
      updateToolSettings: async () => null,
    } as unknown as ServiceManager);
    fastify.decorate('credentialManager', {
      get: async () => null,
      listForDeck: async () => [],
      isCredentialOnDeck: async () => false,
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    fastify.decorate('playbookManager', playbookManager);
    fastify.decorate('patchManager', patchManager);
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });

    registerHttpPolicyHook(fastify);
    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.register(registerPlaybookPatchRoutes, { prefix: '/api/playbook-patches' });
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
      db,
      deckAlpha,
      store,
    };
  }

  it('one call returns all nine fields with values equal to the two-call results', async () => {
    const { backendUrl, deckAlpha } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);

    const tools = await listTools(started.port, sessionId, 2, deckHeaders);
    expect(tools.map((tool) => tool.name)).toContain('get_session_context');
    const bound = await callToolMcpResult(
      started.port,
      sessionId,
      'bind_workspace',
      { workspaceRoot: '/tmp/agent-deck-context', deckId: deckAlpha.id },
      11,
      deckHeaders,
    );
    expect(bound.isError).toBe(false);

    const binding = await callToolMcpResult(
      started.port,
      sessionId,
      'get_session_binding',
      {},
      12,
      deckHeaders,
    );
    const deck = await callToolMcpResult(
      started.port,
      sessionId,
      'get_bound_deck',
      {},
      13,
      deckHeaders,
    );
    const context = await callToolMcpResult(
      started.port,
      sessionId,
      'get_session_context',
      {},
      14,
      deckHeaders,
    );

    expect(context.isError).toBe(false);
    for (const field of REQUIRED_CONTEXT_FIELDS) {
      expect(context.data, `missing field ${field}`).toHaveProperty(field);
    }

    // Binding identity matches the get_session_binding result.
    expect(context.data.workspaceRoot).toBe(binding.data.workspaceRoot);
    expect(context.data.effective_deck_id).toBe(binding.data.effective_deck_id);
    expect(context.data.effective_deck_name).toBe(binding.data.effective_deck_name);
    expect(context.data.effective_deck_source).toBe(binding.data.effective_deck_source);
    expect(context.data.badge).toBe(binding.data.badge);
    expect(context.data.display_summary).toBe(binding.data.display_summary);

    // Deck cards match the get_bound_deck result.
    expect(context.data.services).toEqual(deck.data.services);
    expect(context.data.credentials).toEqual(deck.data.credentials);
    expect(context.data.playbooks).toEqual(deck.data.playbooks);

    // Playbooks stay lazy summaries: id/title/triggers only, no bodies.
    const playbooks = context.data.playbooks as Array<Record<string, unknown>>;
    expect(playbooks.length).toBeGreaterThan(0);
    for (const playbook of playbooks) {
      expect(Object.keys(playbook).sort()).toEqual(['id', 'title', 'triggers']);
    }
    expect(JSON.stringify(context.data)).not.toContain('Keep it short');
  });

  it('unassigned session returns GRANT_REQUIRED with no deck metadata', async () => {
    const { backendUrl } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const init = await postInitialize(started.port, 1);
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const tools = await listTools(started.port, sessionId!, 2);
    expect(tools.map((tool) => tool.name)).toContain('get_session_context');

    const context = await callToolMcpResult(
      started.port,
      sessionId!,
      'get_session_context',
      {},
      3,
    );
    expect(context.isError).toBe(true);
    expect(context.data).toEqual(unassignedDeckBinding());
    expect(context.data.error_code).toBe('GRANT_REQUIRED');
    expect(String(context.data.message ?? '')).toContain(UNASSIGNED_DECK_MESSAGE.slice(0, 20));
    // No deck metadata leaks through the bootstrap read.
    for (const field of ['effective_deck_id', 'effective_deck_name', 'services', 'credentials', 'playbooks'] as const) {
      expect(context.data, `leaked field ${field}`).not.toHaveProperty(field);
    }
  });

  it('invalid launch deck is rejected at connect before any deck data', async () => {
    const { backendUrl } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const init = await postInitialize(started.port, 1, 'vitest', {
      [AGENT_DECK_DECK_ID_HEADER]: '00000000-0000-4000-8000-000000000000',
    });
    expect(init.status).toBe(401);
    const body = (await init.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').toContain('LAUNCH_DECK_INVALID');
  });

  it('revoked launch deck returns the existing deck error with no deck data serialized', async () => {
    const { backendUrl, db, deckAlpha } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: deckAlpha.id };
    const sessionId = await openSession(started.port, 1, deckHeaders);

    // Revoke the launch deck after the session authenticated.
    expect(await db.deleteDeck(deckAlpha.id)).toBe(true);

    const context = await callToolMcpResult(
      started.port,
      sessionId,
      'get_session_context',
      {},
      2,
      deckHeaders,
    );
    const binding = await callToolMcpResult(
      started.port,
      sessionId,
      'get_session_binding',
      {},
      3,
      deckHeaders,
    );
    const deck = await callToolMcpResult(
      started.port,
      sessionId,
      'get_bound_deck',
      {},
      4,
      deckHeaders,
    );

    // The one-call bootstrap surfaces the same existing error as both
    // legacy calls — the shared /api/scope/deck authorization path.
    expect(context.isError).toBe(true);
    expect(binding.isError).toBe(true);
    expect(deck.isError).toBe(true);
    expect(context.data).toEqual(binding.data);
    expect(context.data).toEqual(deck.data);
    // The error serializes before any deck data: no deck fields, no deck text.
    for (const field of ['effective_deck_id', 'effective_deck_name', 'services', 'credentials', 'playbooks'] as const) {
      expect(context.data, `leaked field ${field}`).not.toHaveProperty(field);
    }
    expect(JSON.stringify(context.data)).not.toContain(deckAlpha.id);
    expect(JSON.stringify(context.data)).not.toContain('alpha');
  });
});
