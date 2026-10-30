/**
 * NOT-537: pinned playbook version over a stub MCP host (socket-free).
 *
 * Tool wiring via a stub host whose `callBackendAPI` proxies to a real
 * Fastify backend through `fastify.inject`; the pin comes from a stub
 * session binding, the way the MCP server adopts the launch header.
 * Full MCP-over-HTTP acceptance (header adoption included) lives in
 * `mcp-server.http.test.ts` and runs where loopback sockets are available.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER, generateId, type PlaybookPin } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { PatchManager } from '../playbooks/patch-manager';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { registerPlaybookPatchRoutes } from '../routes/playbook-patches';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerScopeRoutes } from '../routes/scope';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { formatMcpToolError } from './policy';
import { registerMcpTools, type McpToolHost } from './register';

type ToolEntry = {
  config: { title: string; description: string; inputSchema: Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
};

const SESSION_ID = 'test-session';

function buildStubHost(opts: {
  deckId: string;
  pin?: PlaybookPin;
  callBackendAPI: (endpoint: string, init?: RequestInit) => Promise<unknown>;
}) {
  const tools = new Map<string, ToolEntry>();
  const host = {
    registerTool: (name: string, config: ToolEntry['config'], handler: ToolEntry['handler']) => {
      tools.set(name, { config, handler });
    },
    profile: 'standard',
    getSessionId: () => SESSION_ID,
    getMode: () => 'normal',
    refreshRuntimeSession: async () => ({ mode: 'normal' as const, deckId: opts.deckId }),
    getAgentHeaders: () => ({}),
    getBoundDeckId: async () => opts.deckId,
    callBackendAPI: opts.callBackendAPI,
    fetchDeck: async () => ({ id: opts.deckId, name: 'stub' }),
    buildBindingPayload: async () => ({}),
    registerLiveDisplay: async () => {},
    syncWorkspaceOnBind: async () => null,
    sessionBinding: {
      getBinding: () => ({ deckId: opts.deckId }),
      setWorkspace: () => {},
      setDeckId: () => {},
      setTrustedSession: () => {},
      isLaunchSession: () => true,
      hasSessionDeckOverride: () => false,
      getPlaybookPin: () => opts.pin,
    },
    badgeBySession: new Map<string, string>(),
    backendUrl: 'http://127.0.0.1:1',
    toolResult: (data: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    }),
    toolError: (error: unknown) => formatMcpToolError(error),
  } as unknown as McpToolHost;
  registerMcpTools(host);
  return tools;
}

function toolPayload(entry: ToolEntry | undefined, args: Record<string, unknown> = {}) {
  if (!entry) {
    throw new Error('tool not registered');
  }
  return entry.handler(args).then((result) => JSON.parse(result.content[0].text) as Record<string, unknown>);
}

describe('pinned playbook version tools (NOT-537)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildBackend() {
    const db = new DatabaseManager(':memory:');
    const deck = await db.createDeck({ name: 'eval' });
    const playbook = await db.createPlaybook({
      id: 'pb_baseline',
      title: 'current title',
      body: '## Gotchas\n- Current lesson.\n',
      triggers: ['current trigger'],
    });
    await db.addPlaybookToDeck({ deckId: deck.id, playbookId: playbook.id, position: 0 });
    const other = await db.createPlaybook({
      id: 'pb_other',
      title: 'other title',
      body: '## Gotchas\n- Other lesson.\n',
      triggers: ['other trigger'],
    });
    await db.addPlaybookToDeck({ deckId: deck.id, playbookId: other.id, position: 0 });

    const older = await db.createPlaybookVersion({
      id: generateId(),
      playbookId: playbook.id,
      title: 'older title',
      body: '## Gotchas\n- Older lesson.\n',
      triggers: ['older trigger'],
      patchId: null,
      actor: 'agent',
    });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const session = store.createRuntimeSession({ deckId: deck.id });
    const playbookManager = new PlaybookManager(db);
    const patchManager = new PatchManager(db, playbookManager);

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('credentialManager', {
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    fastify.decorate('playbookManager', playbookManager);
    fastify.decorate('patchManager', patchManager);
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });

    registerHttpPolicyHook(fastify);
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.register(registerPlaybookPatchRoutes, { prefix: '/api/playbook-patches' });
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.register(registerScopeRoutes, { prefix: '/api/scope' });
    await fastify.ready();
    servers.push(fastify);

    // The stub MCP host speaks to this backend the way the real MCP server
    // does: agent headers plus the trusted runtime session.
    const callBackendAPI = async (endpoint: string, init: RequestInit = {}): Promise<unknown> => {
      const response = await fastify.inject({
        method: (init.method ?? 'GET') as 'GET',
        url: `/api${endpoint.replace(/^\/api/, '')}`,
        headers: {
          [AGENT_DECK_SESSION_HEADER]: session.sessionId,
          ...((init.headers as Record<string, string> | undefined) ?? {}),
        },
        payload: init.body,
      });
      const body = response.json() as { success: boolean; data?: unknown; error?: string };
      if (response.statusCode < 200 || response.statusCode >= 300 || !body.success) {
        throw new Error(body.error ?? `backend ${response.statusCode}`);
      }
      return body.data;
    };

    return { db, deck, playbook, other, older, callBackendAPI };
  }

  it('returns the pinned version for the pinned id and the live body otherwise', async () => {
    const { db, deck, playbook, other, older, callBackendAPI } = await buildBackend();
    const pin = { playbookId: playbook.id, versionId: older.id };
    const tools = buildStubHost({ deckId: deck.id, pin, callBackendAPI });

    const pinned = await toolPayload(tools.get('get_playbook'), { playbook_id: playbook.id });
    expect(pinned).toMatchObject({
      id: playbook.id,
      title: 'older title',
      body: '## Gotchas\n- Older lesson.\n',
      triggers: ['older trigger'],
      openPatches: [],
      pinnedVersionId: older.id,
    });

    const untouched = await toolPayload(tools.get('get_playbook'), { playbook_id: other.id });
    expect(untouched).toMatchObject({ id: other.id, title: 'other title' });
    expect(untouched).not.toHaveProperty('pinnedVersionId');

    // The live playbook is never modified by a pinned read.
    expect((await db.getPlaybook(playbook.id))?.body).toBe('## Gotchas\n- Current lesson.\n');
  });

  it('leaves unpinned sessions exactly as before', async () => {
    const { deck, playbook, callBackendAPI } = await buildBackend();
    const tools = buildStubHost({ deckId: deck.id, callBackendAPI });

    const current = await toolPayload(tools.get('get_playbook'), { playbook_id: playbook.id });
    expect(current).toMatchObject({
      id: playbook.id,
      title: 'current title',
      body: '## Gotchas\n- Current lesson.\n',
    });
    expect(current).not.toHaveProperty('pinnedVersionId');
  });

  it('shows the pinned title and triggers in session summaries', async () => {
    const { deck, playbook, older, callBackendAPI } = await buildBackend();
    const pin = { playbookId: playbook.id, versionId: older.id };
    const tools = buildStubHost({ deckId: deck.id, pin, callBackendAPI });

    const context = await toolPayload(tools.get('get_session_context'));
    const summaries = context.playbooks as Array<{ id: string; title: string; triggers: string[] }>;
    expect(summaries.find((entry) => entry.id === playbook.id)).toEqual({
      id: playbook.id,
      title: 'older title',
      triggers: ['older trigger'],
    });

    const bound = await toolPayload(tools.get('get_bound_deck'));
    const deckPlaybooks = bound.playbooks as Array<{ id: string; title: string; triggers: string[] }>;
    expect(deckPlaybooks.find((entry) => entry.id === playbook.id)).toMatchObject({
      id: playbook.id,
      title: 'older title',
      triggers: ['older trigger'],
    });
  });

  it('blocks proposals in a pinned session without creating rows', async () => {
    const { db, deck, playbook, older, callBackendAPI } = await buildBackend();
    const pin = { playbookId: playbook.id, versionId: older.id };
    const tools = buildStubHost({ deckId: deck.id, pin, callBackendAPI });

    const patchesBefore = await db.listPlaybookPatches();
    const signalsBefore = await db.listFeedbackSignals();

    const blocked = await toolPayload(tools.get('propose_playbook_patch'), {
      kind: 'update',
      playbook_id: playbook.id,
      ops: [{ op: 'add_item', section: 'Gotchas', text: '- Pinned lesson.' }],
      rationale: 'evaluation run must not file this',
    });
    expect(String(blocked.error)).toContain('pinned to');
    expect(String(blocked.error)).toContain(playbook.id);

    expect(await db.listPlaybookPatches()).toHaveLength(patchesBefore.length);
    expect(await db.listFeedbackSignals()).toHaveLength(signalsBefore.length);
  });

  it('files proposals in an unpinned session as before', async () => {
    const { db, deck, playbook, callBackendAPI } = await buildBackend();
    const tools = buildStubHost({ deckId: deck.id, callBackendAPI });

    const result = await toolPayload(tools.get('propose_playbook_patch'), {
      kind: 'update',
      playbook_id: playbook.id,
      ops: [{ op: 'add_item', section: 'Gotchas', text: '- Unpinned lesson.' }],
      rationale: 'normal session files this',
    });
    expect(result).toHaveProperty('id');
    expect(await db.listPlaybookPatches()).toHaveLength(1);
    expect(await db.listFeedbackSignals()).toHaveLength(1);
  });
});
