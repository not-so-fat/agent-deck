/**
 * NOT-209: request-only switch_deck MCP tool — socket-free coverage.
 * Full MCP-over-HTTP acceptance lives in switch-deck.http.test.ts (needs
 * loopback sockets, run in CI/review); this file covers the same contract
 * without binding ports: the creation endpoint via fastify.inject and the
 * tool wiring via a stub host.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { resolveRoutePolicy } from '../trusted-session/route-policy-registry';
import { TrustedSessionStore } from '../trusted-session/store';
import { BackendApiError } from '../lib/backend-api-error';
import { formatMcpToolError } from './policy';
import { registerMcpTools, type McpToolHost } from './register';

const FORBIDDEN_SUBSTRINGS = [
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
];

describe('switch_deck creation endpoint (NOT-209)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'alpha' });
    const deckB = await db.createDeck({ name: 'beta' });
    const store = new TrustedSessionStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    registerHttpPolicyHook(fastify);
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, store, deckA, deckB };
  }

  function agentHeaders(sessionId: string): Record<string, string> {
    return { [AGENT_DECK_SESSION_HEADER]: sessionId };
  }

  it('registers the agent-accessible creation policy', () => {
    expect(resolveRoutePolicy('POST', '/api/trusted-session/deck-switch')).toBe(
      'requireAgentResource',
    );
  });

  it('creates a pending request by name without touching bindings', async () => {
    const { fastify, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: agentHeaders(session.sessionId),
      payload: { target: 'beta' },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.status).toBe('pending');
    expect(typeof data.requestId).toBe('string');
    expect(data.requestId.length).toBeGreaterThan(0);
    expect(data.currentDeckId).toBe(deckA.id);
    expect(data.currentDeckName).toBe('alpha');
    expect(data.requestedDeckId).toBe(deckB.id);
    expect(data.requestedDeckName).toBe('beta');
    expect(data.presentation).toMatchObject({
      kind: 'deck_switch_request',
      status: 'pending',
      channels: ['host-elicitation', 'browser'],
    });

    // No approval capability or commit credential embedded.
    const serialized = JSON.stringify(data).toLowerCase();
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(serialized, `response must not contain ${forbidden}`).not.toContain(forbidden);
    }
    expect(serialized).not.toContain('services');
    expect(serialized).not.toContain('playbook');

    // Exactly one pending request; session binding unchanged.
    expect(store.listPendingDeckSwitchRequests(session.sessionId)).toHaveLength(1);
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
  });

  it('dedupes identical pending requests across name and id refs', async () => {
    const { fastify, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });

    const first = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: agentHeaders(session.sessionId),
      payload: { target: 'beta' },
    });
    const second = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: agentHeaders(session.sessionId),
      payload: { target: deckB.id },
    });

    expect(first.json().data.requestId).toBe(second.json().data.requestId);
    expect(second.json().data.status).toBe('pending');
    expect(store.listPendingDeckSwitchRequests(session.sessionId)).toHaveLength(1);
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
  });

  it('rejects unknown targets without revealing contents or changing bindings', async () => {
    const { fastify, store, deckA } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: agentHeaders(session.sessionId),
      payload: { target: 'no-such-deck' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ success: false, error: 'Deck not found' });
    expect(JSON.stringify(response.json())).not.toContain('beta');
    expect(store.listPendingDeckSwitchRequests(session.sessionId)).toHaveLength(0);
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
  });

  it('opens no request for the already-active deck', async () => {
    const { fastify, store, deckA } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: agentHeaders(session.sessionId),
      payload: { target: 'alpha' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'already_on_deck',
      currentDeckId: deckA.id,
      currentDeckName: 'alpha',
    });
    expect(response.json().data.requestId).toBeUndefined();
    expect(store.listPendingDeckSwitchRequests(session.sessionId)).toHaveLength(0);
  });

  it('requires a target and an owning session', async () => {
    const { fastify, store, deckA } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });

    const missingTarget = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: agentHeaders(session.sessionId),
      payload: { target: '   ' },
    });
    expect(missingTarget.statusCode).toBe(400);

    const noSession = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      payload: { target: 'beta' },
    });
    expect(noSession.statusCode).toBe(401);
    expect(store.listPendingDeckSwitchRequests(session.sessionId)).toHaveLength(0);
  });
});

describe('switch_deck tool wiring (NOT-209)', () => {
  type CapturedTool = {
    config: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> };
    handler: (...args: any[]) => Promise<any>;
  };

  function buildStubHost(overrides?: {
    runtimeSessionId?: string | null;
    workspaceRoot?: string;
    callBackendAPI?: (endpoint: string, init?: RequestInit) => Promise<any>;
  }): { host: McpToolHost; tools: Map<string, CapturedTool>; spies: Record<string, any> } {
    const tools = new Map<string, CapturedTool>();
    const spies = {
      callBackendAPI: vi.fn(
        overrides?.callBackendAPI ??
          (async () => ({
            requestId: 'req_test',
            status: 'pending',
            currentDeckName: 'alpha',
            requestedDeckName: 'beta',
          })),
      ),
      setDeckId: vi.fn(),
      setWorkspace: vi.fn(),
      setTrustedSession: vi.fn(),
      fetchDeck: vi.fn(),
      getBoundDeckId: vi.fn(),
    };
    const runtimeSessionId = overrides?.runtimeSessionId === undefined ? 'rs_test' : overrides.runtimeSessionId;
    const host = {
      registerTool: (name: string, config: CapturedTool['config'], handler: CapturedTool['handler']) => {
        tools.set(name, { config, handler });
      },
      profile: 'standard' as const,
      getSessionId: () => 'mcp_test',
      getMode: () => 'normal' as const,
      refreshRuntimeSession: async () => ({ mode: 'normal' as const, deckId: 'deck_a' }),
      getAgentHeaders: () => ({}),
      getBoundDeckId: spies.getBoundDeckId,
      callBackendAPI: spies.callBackendAPI,
      fetchDeck: spies.fetchDeck,
      buildBindingPayload: async () => ({}),
      registerLiveDisplay: async () => {},
      syncWorkspaceOnBind: async () => null,
      sessionBinding: {
        getBinding: () => ({
          workspaceRoot: overrides?.workspaceRoot ?? '/work/test',
          deckId: 'deck_a',
          runtimeSessionId: runtimeSessionId ?? undefined,
        }),
        setWorkspace: spies.setWorkspace,
        setDeckId: spies.setDeckId,
        setTrustedSession: spies.setTrustedSession,
        isLaunchSession: () => false,
        hasSessionDeckOverride: () => false,
      },
      badgeBySession: new Map<string, string>(),
      backendUrl: 'http://127.0.0.1:9',
      toolResult: (data: unknown) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      }),
      toolError: (error: unknown) => formatMcpToolError(error),
    } as unknown as McpToolHost;
    return { host, tools, spies };
  }

  it('registers switch_deck on runtime and standard profiles with a target input', () => {
    for (const profile of ['runtime', 'standard'] as const) {
      const { host, tools } = buildStubHost();
      registerMcpTools({ ...host, profile });
      const tool = tools.get('switch_deck');
      expect(tool, `switch_deck registered for ${profile}`).toBeDefined();
      expect(tool!.config.title.length).toBeGreaterThan(0);
      expect(tool!.config.description).toMatch(/request-only/i);
      expect(tool!.config.inputSchema.target).toBeDefined();
      expect(tool!.config.inputSchema.target.safeParse('beta').success).toBe(true);
      expect(tool!.config.inputSchema.target.safeParse('').success).toBe(false);
    }
  });

  it('forwards the target server-side and changes no local binding', async () => {
    const { host, tools, spies } = buildStubHost();
    registerMcpTools(host);

    const result = await tools.get('switch_deck')!.handler({ target: 'beta' });

    expect(spies.callBackendAPI).toHaveBeenCalledTimes(1);
    const [endpoint, init] = spies.callBackendAPI.mock.calls[0];
    expect(endpoint).toBe('/api/trusted-session/deck-switch');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      target: 'beta',
      workspaceRoot: '/work/test',
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      requestId: 'req_test',
      status: 'pending',
    });

    // Request-only: no local binding or routing state moves.
    expect(spies.setDeckId).not.toHaveBeenCalled();
    expect(spies.setWorkspace).not.toHaveBeenCalled();
    expect(spies.setTrustedSession).not.toHaveBeenCalled();
    expect(spies.getBoundDeckId).not.toHaveBeenCalled();
    expect(spies.fetchDeck).not.toHaveBeenCalled();
  });

  it('fails closed without a runtime session and without calling the backend', async () => {
    const { host, tools, spies } = buildStubHost({ runtimeSessionId: null });
    registerMcpTools(host);

    const result = await tools.get('switch_deck')!.handler({ target: 'beta' });

    expect(result.isError).toBe(true);
    expect(spies.callBackendAPI).not.toHaveBeenCalled();
  });

  it('surfaces backend failures without leaking deck contents', async () => {
    const { host, tools } = buildStubHost({
      callBackendAPI: async () => {
        throw new BackendApiError('Deck not found', 404);
      },
    });
    registerMcpTools(host);

    const result = await tools.get('switch_deck')!.handler({ target: 'no-such-deck' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('beta');
    expect(result.content[0].text).not.toContain('requestId');
  });
});
