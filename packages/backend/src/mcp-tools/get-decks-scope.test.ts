/**
 * NOT-232: get_decks/bind_workspace tool text must not promise "all decks".
 * Enumeration stays scoped to the session's active deck (NOT-203); only the
 * descriptions change. Socket-free: tool wiring via a stub host and the real
 * scope endpoint via fastify.inject (full MCP-over-HTTP acceptance runs in
 * CI/review where loopback sockets are available).
 */
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { AGENT_DECK_DECK_ID_HEADER, AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
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

function buildStubHost(opts: {
  deckId: string;
  callBackendAPI: (endpoint: string, init?: RequestInit) => Promise<unknown>;
}) {
  const tools = new Map<string, ToolEntry>();
  const host = {
    registerTool: (name: string, config: ToolEntry['config'], handler: ToolEntry['handler']) => {
      tools.set(name, { config, handler });
    },
    profile: 'standard',
    getSessionId: () => 'test-session',
    getMode: () => 'normal',
    refreshRuntimeSession: async () => ({ mode: 'normal' as const, deckId: opts.deckId }),
    getAgentHeaders: () => ({ [AGENT_DECK_DECK_ID_HEADER]: opts.deckId }),
    getBoundDeckId: async () => opts.deckId,
    callBackendAPI: vi.fn(opts.callBackendAPI),
    fetchDeck: async () => ({ id: opts.deckId, name: 'stub' }),
    buildBindingPayload: async () => ({}),
    registerLiveDisplay: async () => {},
    syncWorkspaceOnBind: async () => null,
    sessionBinding: {
      getBinding: () => ({ deckId: opts.deckId }),
      setWorkspace: () => {},
      setDeckId: () => {},
      setTrustedSession: () => {},
      isLaunchSession: () => false,
      hasSessionDeckOverride: () => false,
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

/** Real scope backend with two decks; deck B exists but is never in scope. */
async function buildScopeBackend() {
  const db = new DatabaseManager(':memory:');
  const deckA = await db.createDeck({ name: 'alpha' });
  const deckB = await db.createDeck({ name: 'beta' });
  const store = new TrustedSessionStore(db.getSqliteDatabase());
  const session = store.createRuntimeSession({ deckId: deckA.id });

  const fastify = Fastify();
  fastify.decorate('db', db);
  fastify.decorate('trustedSessionStore', store);
  fastify.decorate('credentialManager', {
    applySecretStatus: async (credentials: unknown[]) => credentials,
  });
  fastify.decorate('playbookManager', {
    listSummariesForDeck: async () => [],
  });
  fastify.decorate('liveDisplayRegistry', {
    getForDeck: () => null,
  });
  registerHttpPolicyHook(fastify);
  await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
  await fastify.register(registerScopeRoutes, { prefix: '/api/scope' });
  await fastify.ready();

  return { fastify, deckA, deckB, runtimeSessionId: session.sessionId };
}

describe('MCP get_decks scope wording (NOT-232)', () => {
  it('get_decks description never promises "all decks" and states the active-deck limit', async () => {
    const { fastify, deckA } = await buildScopeBackend();
    try {
      const tools = buildStubHost({
        deckId: deckA.id,
        callBackendAPI: async () => ({}),
      });
      const description = tools.get('get_decks')?.config.description;
      expect(description).toBeTruthy();
      expect(description!.toLowerCase()).not.toContain('all decks');
      expect(description!.toLowerCase()).toContain('active deck');
      expect(description!).toContain('switch_deck');
    } finally {
      await fastify.close();
    }
  });

  it('bind_workspace description never directs the caller to get_decks and names switch_deck', async () => {
    const { fastify, deckA } = await buildScopeBackend();
    try {
      const tools = buildStubHost({
        deckId: deckA.id,
        callBackendAPI: async () => ({}),
      });
      const description = tools.get('bind_workspace')?.config.description;
      expect(description).toBeTruthy();
      expect(description!).not.toContain('get_decks');
      expect(description!).toContain('switch_deck');
    } finally {
      await fastify.close();
    }
  });

  it('get_decks still returns only the session deck while another deck exists', async () => {
    const { fastify, deckA, deckB, runtimeSessionId } = await buildScopeBackend();
    try {
      // Deck B provably exists in the same store — containment means it
      // must still never surface through get_decks.
      expect((await fastify.db.getDeck(deckB.id))?.id).toBe(deckB.id);
      const tools = buildStubHost({
        deckId: deckA.id,
        callBackendAPI: async (endpoint: string) => {
          expect(endpoint).toBe('/api/scope/deck');
          const response = await fastify.inject({
            method: 'GET',
            url: '/api/scope/deck',
            headers: {
              [AGENT_DECK_DECK_ID_HEADER]: deckA.id,
              [AGENT_DECK_SESSION_HEADER]: runtimeSessionId,
            },
          });
          expect(response.statusCode).toBe(200);
          return response.json().data;
        },
      });
      const result = await tools.get('get_decks')!.handler({});
      const entries = JSON.parse(result.content[0].text) as Array<{
        id: string;
        name: string;
      }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(deckA.id);
      expect(entries.map((entry) => entry.id)).not.toContain(deckB.id);
    } finally {
      await fastify.close();
    }
  });
});
