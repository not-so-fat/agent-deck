/**
 * NOT-213: deck-switch approval through MCP form elicitation.
 *
 * Transport-level coverage with stub hosts (no sockets): capability
 * gating, the elicited form shape, accept/decline/cancel translation
 * into the approval API, fallback on unsupported/error/malformed, and
 * the approval API as the backstop for forged scopes and request ids.
 */
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { BackendApiError } from '../lib/backend-api-error';
import { formatMcpToolError } from './policy';
import {
  buildCancelRecoveryPayload,
  buildDeckSwitchElicitationInput,
  DeckSwitchApprovalCommitUnavailable,
  isDeckSwitchApprovalScope,
  presentDeckSwitchApproval,
  submitDeckSwitchApprovalViaBackend,
  supportsFormElicitation,
  type DeckSwitchCreationResult,
  type ElicitationResult,
} from './elicitation';
import { registerMcpTools, type McpToolHost } from './register';

const CREATION: DeckSwitchCreationResult = {
  requestId: 'req_1',
  status: 'pending',
  createdAt: '2026-09-21T00:00:00.000Z',
  expiresAt: '2026-09-21T00:30:00.000Z',
  currentDeckId: 'deck_a',
  currentDeckName: 'alpha',
  requestedDeckId: 'deck_b',
  requestedDeckName: 'beta',
  presentation: {
    kind: 'deck_switch_request',
    title: 'Switch deck to "beta"?',
    body: 'Agent requested a switch from "alpha" to "beta". The active deck is unchanged; a human decision is still required.',
    status: 'pending',
    expiresAt: '2026-09-21T00:30:00.000Z',
    channels: ['host-elicitation', 'browser'],
  },
};

function stubDeps(overrides?: {
  supported?: boolean;
  supportThrows?: boolean;
  elicitation?: ElicitationResult | Error;
  elicitCalls?: unknown[];
  submit?: (args: { requestId: string; runtimeSessionId: string; decision: string }) => Promise<unknown>;
  submitCalls?: Array<{ requestId: string; runtimeSessionId: string; decision: string }>;
}) {
  const elicitCalls: unknown[] = overrides?.elicitCalls ?? [];
  const submitCalls: Array<{ requestId: string; runtimeSessionId: string; decision: string }> =
    overrides?.submitCalls ?? [];
  return {
    elicitCalls,
    submitCalls,
    deps: {
      creation: CREATION,
      runtimeSessionId: 'rs_owner',
      supportsFormElicitation: () => {
        if (overrides?.supportThrows) {
          throw new Error('capability probe failed');
        }
        return overrides?.supported ?? true;
      },
      elicitForm: async (input: { message: string; requestedSchema: Record<string, unknown> }) => {
        elicitCalls.push(input);
        const outcome = overrides?.elicitation ?? { action: 'cancel' as const };
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
      submitApproval: async (args: { requestId: string; runtimeSessionId: string; decision: 'session' | 'workspace-default' | 'decline' }) => {
        submitCalls.push(args);
        if (overrides?.submit) {
          return overrides.submit(args);
        }
        return { requestId: args.requestId, decision: args.decision, status: 'consumed' };
      },
    },
  };
}

describe('form elicitation capability gate (NOT-213)', () => {
  it('detects advertised form support', () => {
    expect(supportsFormElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(supportsFormElicitation({ elicitation: { form: { applyDefaults: true } } })).toBe(true);
  });

  it('rejects missing, malformed, or url-only capabilities', () => {
    expect(supportsFormElicitation(undefined)).toBe(false);
    expect(supportsFormElicitation(null)).toBe(false);
    expect(supportsFormElicitation({})).toBe(false);
    expect(supportsFormElicitation({ elicitation: undefined })).toBe(false);
    expect(supportsFormElicitation({ elicitation: { url: {} } })).toBe(false);
    expect(supportsFormElicitation({ elicitation: { form: null } })).toBe(false);
    expect(supportsFormElicitation('elicitation')).toBe(false);
  });
});

describe('elicited form shape (NOT-213)', () => {
  it('offers both scopes and decline with human labels', () => {
    const input = buildDeckSwitchElicitationInput(CREATION);
    const schema = input.requestedSchema as {
      type: string;
      properties: {
        requestId: { type: string; default: string };
        scope: { type: string; enum: string[]; enumNames: string[] };
      };
      required: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties.scope.enum).toEqual(['session', 'workspace-default', 'decline']);
    expect(schema.properties.scope.enumNames).toEqual([
      'This session only',
      'This workspace by default',
      'Decline',
    ]);
    expect(schema.required).toEqual(expect.arrayContaining(['requestId', 'scope']));
    expect(schema.properties.requestId.default).toBe('req_1');
    expect(input.message).toContain('beta');
  });

  it('carries only the request id and scope — no secrets or links', () => {
    const serialized = JSON.stringify(buildDeckSwitchElicitationInput(CREATION)).toLowerCase();
    for (const forbidden of ['http://', 'https://', 'ws://', 'bearer', 'token', 'secret', 'cookie', 'credential']) {
      expect(serialized, `form must not contain ${forbidden}`).not.toContain(forbidden);
    }
    expect(Object.keys(
      (buildDeckSwitchElicitationInput(CREATION).requestedSchema as { properties: Record<string, unknown> }).properties,
    ).sort()).toEqual(['requestId', 'scope']);
  });

  it('recognizes exactly the three approval scopes', () => {
    expect(isDeckSwitchApprovalScope('session')).toBe(true);
    expect(isDeckSwitchApprovalScope('workspace-default')).toBe(true);
    expect(isDeckSwitchApprovalScope('decline')).toBe(true);
    expect(isDeckSwitchApprovalScope('approve')).toBe(false);
    expect(isDeckSwitchApprovalScope('')).toBe(false);
    expect(isDeckSwitchApprovalScope(undefined)).toBe(false);
  });
});

describe('presentDeckSwitchApproval orchestration (NOT-213)', () => {
  it('resolves exactly once with the accepted scope', async () => {
    const { deps, submitCalls, elicitCalls } = stubDeps({
      elicitation: { action: 'accept', content: { requestId: 'req_1', scope: 'session' } },
    });

    const outcome = await presentDeckSwitchApproval(deps);

    expect(outcome.handled).toBe('resolved');
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toEqual({ requestId: 'req_1', runtimeSessionId: 'rs_owner', decision: 'session' });
    expect(outcome.payload).toMatchObject({ requestId: 'req_1', decision: 'session', status: 'consumed' });
    // The native UI was actually shown before resolving.
    expect(elicitCalls).toHaveLength(1);
  });

  it('forwards the workspace-default scope unchanged', async () => {
    const { deps, submitCalls } = stubDeps({
      elicitation: { action: 'accept', content: { requestId: 'req_1', scope: 'workspace-default' } },
    });

    const outcome = await presentDeckSwitchApproval(deps);

    expect(outcome.handled).toBe('resolved');
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0].decision).toBe('workspace-default');
  });

  it('translates an accepted decline scope into a decline resolution', async () => {
    const { deps, submitCalls } = stubDeps({
      elicitation: { action: 'accept', content: { requestId: 'req_1', scope: 'decline' } },
    });

    const outcome = await presentDeckSwitchApproval(deps);

    expect(outcome.handled).toBe('resolved');
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0].decision).toBe('decline');
  });

  it('translates a host-level decline into a decline resolution', async () => {
    const { deps, submitCalls } = stubDeps({ elicitation: { action: 'decline' } });

    const outcome = await presentDeckSwitchApproval(deps);

    expect(outcome.handled).toBe('resolved');
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toMatchObject({ requestId: 'req_1', decision: 'decline' });
  });

  it('leaves a cancelled request pending with reopen instructions', async () => {
    const { deps, submitCalls } = stubDeps({ elicitation: { action: 'cancel' } });

    const outcome = await presentDeckSwitchApproval(deps);

    expect(outcome.handled).toBe('pending-recovery');
    expect(submitCalls).toHaveLength(0);
    expect(outcome.payload).toMatchObject({ requestId: 'req_1', status: 'pending', channel: 'browser' });
    const text = JSON.stringify(outcome.payload).toLowerCase();
    expect(text).toContain('still pending');
    expect(text).toContain('menubar');
    expect(text).toContain('browser approval');
    expect(text).not.toContain('http://');
    expect(text).not.toContain('https://');
  });

  it('falls back without eliciting when the capability is unsupported', async () => {
    const elicitCalls: unknown[] = [];
    const submitCalls: Array<{ requestId: string; runtimeSessionId: string; decision: string }> = [];
    const { deps } = stubDeps({ supported: false, elicitCalls, submitCalls });

    const outcome = await presentDeckSwitchApproval(deps);

    expect(outcome.handled).toBe('fallback');
    expect(outcome.payload).toBe(CREATION);
    expect(elicitCalls).toHaveLength(0);
    expect(submitCalls).toHaveLength(0);
  });

  it('falls back when the capability probe itself throws', async () => {
    const { deps, submitCalls } = stubDeps({ supportThrows: true });

    const outcome = await presentDeckSwitchApproval(deps);

    expect(outcome.handled).toBe('fallback');
    expect(outcome.payload).toBe(CREATION);
    expect(submitCalls).toHaveLength(0);
  });

  it.each([
    ['timeout', new Error('RequestTimeout')],
    ['transport error', new Error('connection closed')],
    ['schema mismatch', Object.assign(new Error('Elicitation response content does not match'), { code: -32602 })],
  ])('falls back without changing the deck on %s', async (_label, error) => {
    const { deps, submitCalls } = stubDeps({ elicitation: error });

    const outcome = await presentDeckSwitchApproval(deps);

    expect(outcome.handled).toBe('fallback');
    expect(outcome.payload).toBe(CREATION);
    expect(submitCalls).toHaveLength(0);
  });

  it.each([
    ['missing content', { action: 'accept' }],
    ['non-object content', { action: 'accept', content: 'session' }],
    ['forged scope', { action: 'accept', content: { requestId: 'req_1', scope: 'approve' } }],
    ['empty scope', { action: 'accept', content: { requestId: 'req_1', scope: '' } }],
    ['forged request id', { action: 'accept', content: { requestId: 'req_other', scope: 'session' } }],
    ['missing request id', { action: 'accept', content: { scope: 'session' } }],
    ['unknown action', { action: 'submit' }],
  ])('falls back without submitting on malformed response: %s', async (_label, elicitation) => {
    const { deps, submitCalls } = stubDeps({
      elicitation: elicitation as ElicitationResult,
    });

    const outcome = await presentDeckSwitchApproval(deps);

    expect(outcome.handled).toBe('fallback');
    expect(outcome.payload).toBe(CREATION);
    expect(submitCalls).toHaveLength(0);
  });

  it('falls back when the server cannot submit', async () => {
    const { deps, submitCalls } = stubDeps({
      elicitation: { action: 'accept', content: { requestId: 'req_1', scope: 'session' } },
      submit: async () => {
        throw new DeckSwitchApprovalCommitUnavailable();
      },
    });

    const outcome = await presentDeckSwitchApproval(deps);

    expect(outcome.handled).toBe('fallback');
    expect(outcome.payload).toBe(CREATION);
    expect(submitCalls).toHaveLength(1);
  });

  it('propagates approval API rejections without retrying', async () => {
    const { deps, submitCalls } = stubDeps({
      elicitation: { action: 'accept', content: { requestId: 'req_1', scope: 'session' } },
      submit: async () => {
        throw new BackendApiError('Deck-switch request expired', 410);
      },
    });

    await expect(presentDeckSwitchApproval(deps)).rejects.toThrow('Deck-switch request expired');
    expect(submitCalls).toHaveLength(1);
  });

  it('builds a secret-free, link-free cancel payload', () => {
    const payload = buildCancelRecoveryPayload(CREATION);
    expect(payload).toMatchObject({ requestId: 'req_1', status: 'pending' });
    const text = JSON.stringify(payload).toLowerCase();
    for (const forbidden of ['http://', 'https://', 'bearer', 'token', 'secret', 'cookie']) {
      expect(text, `cancel payload must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('submitDeckSwitchApprovalViaBackend (NOT-213)', () => {
  const SECRET = 'test-admin-secret-0123456789abcdef';
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.AGENT_DECK_ADMIN_SECRET;
    process.env.AGENT_DECK_ADMIN_SECRET = SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) {
      delete process.env.AGENT_DECK_ADMIN_SECRET;
    } else {
      process.env.AGENT_DECK_ADMIN_SECRET = savedSecret;
    }
  });

  it('posts request id and scope to the resolve endpoint with a server credential', async () => {
    const calls: Array<{ endpoint: string; init?: RequestInit }> = [];
    const callBackendAPI = vi.fn(async (endpoint: string, init?: RequestInit) => {
      calls.push({ endpoint, init });
      return { requestId: 'req_1', decision: 'session', status: 'consumed' };
    });

    const result = await submitDeckSwitchApprovalViaBackend({
      callBackendAPI,
      requestId: 'req_1',
      runtimeSessionId: 'rs_owner',
      decision: 'session',
    });

    expect(result).toMatchObject({ status: 'consumed' });
    expect(calls).toHaveLength(1);
    expect(calls[0].endpoint).toBe('/api/trusted-session/deck-switch/req_1/resolve');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ runtimeSessionId: 'rs_owner', decision: 'session' });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('refuses to submit without a server credential', async () => {
    delete process.env.AGENT_DECK_ADMIN_SECRET;
    const callBackendAPI = vi.fn(async () => ({}));

    await expect(
      submitDeckSwitchApprovalViaBackend({
        callBackendAPI,
        requestId: 'req_1',
        runtimeSessionId: 'rs_owner',
        decision: 'session',
      }),
    ).rejects.toBeInstanceOf(DeckSwitchApprovalCommitUnavailable);
    expect(callBackendAPI).not.toHaveBeenCalled();
  });
});

describe('switch_deck elicitation wiring (NOT-213)', () => {
  type CapturedTool = {
    config: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> };
    handler: (...args: any[]) => Promise<any>;
  };

  const SECRET = 'test-admin-secret-0123456789abcdef';
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedSecret = process.env.AGENT_DECK_ADMIN_SECRET;
    process.env.AGENT_DECK_ADMIN_SECRET = SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) {
      delete process.env.AGENT_DECK_ADMIN_SECRET;
    } else {
      process.env.AGENT_DECK_ADMIN_SECRET = savedSecret;
    }
  });

  function buildStubHost(overrides?: {
    elicitation?: ElicitationResult | Error | null;
    supported?: boolean;
    creation?: Record<string, unknown>;
  }): {
    host: McpToolHost;
    tools: Map<string, CapturedTool>;
    calls: Array<{ endpoint: string; init?: RequestInit }>;
  } {
    const tools = new Map<string, CapturedTool>();
    const calls: Array<{ endpoint: string; init?: RequestInit }> = [];
    const creation = overrides?.creation ?? { ...CREATION };
    const host = {
      registerTool: (name: string, config: CapturedTool['config'], handler: CapturedTool['handler']) => {
        tools.set(name, { config, handler });
      },
      profile: 'standard' as const,
      getSessionId: () => 'mcp_test',
      getMode: () => 'normal' as const,
      refreshRuntimeSession: async () => ({ mode: 'normal' as const, deckId: 'deck_a' }),
      getAgentHeaders: () => ({ [AGENT_DECK_SESSION_HEADER]: 'rs_owner' }),
      getBoundDeckId: vi.fn(),
      callBackendAPI: vi.fn(async (endpoint: string, init?: RequestInit) => {
        calls.push({ endpoint, init });
        if (endpoint === '/api/trusted-session/deck-switch') {
          return creation;
        }
        if (endpoint.includes('/resolve')) {
          return { requestId: 'req_1', decision: 'session', status: 'consumed', deckId: 'deck_b', deckName: 'beta' };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      }),
      fetchDeck: vi.fn(),
      buildBindingPayload: async () => ({}),
      registerLiveDisplay: async () => {},
      syncWorkspaceOnBind: async () => null,
      sessionBinding: {
        getBinding: () => ({
          workspaceRoot: '/work/test',
          deckId: 'deck_a',
          runtimeSessionId: 'rs_owner',
        }),
        setWorkspace: vi.fn(),
        setDeckId: vi.fn(),
        setTrustedSession: vi.fn(),
        isLaunchSession: () => false,
        hasSessionDeckOverride: () => false,
      },
      badgeBySession: new Map<string, string>(),
      backendUrl: 'http://127.0.0.1:9',
      toolResult: (data: unknown) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      }),
      toolError: (error: unknown) => formatMcpToolError(error),
      ...(overrides?.elicitation === null
        ? {}
        : {
            elicitation: {
              supportsFormElicitation: () => overrides?.supported ?? true,
              elicitForm: async (input: { message: string; requestedSchema: Record<string, unknown> }) => {
                const outcome = overrides?.elicitation ?? { action: 'cancel' as const };
                if (outcome instanceof Error) {
                  throw outcome;
                }
                void input;
                return outcome;
              },
            },
          }),
    } as unknown as McpToolHost;
    return { host, tools, calls };
  }

  function resolveCalls(calls: Array<{ endpoint: string; init?: RequestInit }>) {
    return calls.filter((call) => call.endpoint.includes('/resolve'));
  }

  it('elicits after creating a pending request and resolves once on accept', async () => {
    const { host, tools, calls } = buildStubHost({
      elicitation: { action: 'accept', content: { requestId: 'req_1', scope: 'workspace-default' } },
    });
    registerMcpTools(host);

    const result = await tools.get('switch_deck')!.handler({ target: 'beta' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({ requestId: 'req_1', status: 'consumed' });
    expect(result.isError).toBeUndefined();
    const resolved = resolveCalls(calls);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].endpoint).toBe('/api/trusted-session/deck-switch/req_1/resolve');
    expect(JSON.parse(String(resolved[0].init?.body))).toEqual({
      runtimeSessionId: 'rs_owner',
      decision: 'workspace-default',
    });
    expect((resolved[0].init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('keeps the request pending with reopen help on cancel', async () => {
    const { host, tools, calls } = buildStubHost({ elicitation: { action: 'cancel' } });
    registerMcpTools(host);

    const result = await tools.get('switch_deck')!.handler({ target: 'beta' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({ requestId: 'req_1', status: 'pending' });
    expect(JSON.stringify(payload).toLowerCase()).toContain('menubar');
    expect(resolveCalls(calls)).toHaveLength(0);
  });

  it('returns the browser fallback hint when elicitation is unsupported', async () => {
    const { host, tools, calls } = buildStubHost({
      supported: false,
      elicitation: { action: 'accept', content: { requestId: 'req_1', scope: 'session' } },
    });
    registerMcpTools(host);

    const result = await tools.get('switch_deck')!.handler({ target: 'beta' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({
      requestId: 'req_1',
      status: 'pending',
      presentation: { kind: 'deck_switch_request' },
    });
    expect(resolveCalls(calls)).toHaveLength(0);
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/trusted-session/deck-switch']);
  });

  it('returns the browser fallback hint on elicitation timeout', async () => {
    const { host, tools, calls } = buildStubHost({ elicitation: new Error('RequestTimeout') });
    registerMcpTools(host);

    const result = await tools.get('switch_deck')!.handler({ target: 'beta' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({ requestId: 'req_1', status: 'pending' });
    expect(resolveCalls(calls)).toHaveLength(0);
  });

  it('never elicits for an already-active deck', async () => {
    const elicitation = { action: 'accept' as const, content: { requestId: 'req_1', scope: 'session' as const } };
    const { host, tools, calls } = buildStubHost({
      elicitation,
      creation: { status: 'already_on_deck', currentDeckId: 'deck_a', currentDeckName: 'alpha' },
    });
    registerMcpTools(host);

    const result = await tools.get('switch_deck')!.handler({ target: 'alpha' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({ status: 'already_on_deck' });
    expect(resolveCalls(calls)).toHaveLength(0);
  });

  it('keeps the established fallback when no elicitation provider is wired', async () => {
    const { host, tools, calls } = buildStubHost({ elicitation: null });
    registerMcpTools(host);

    const result = await tools.get('switch_deck')!.handler({ target: 'beta' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({ requestId: 'req_1', status: 'pending' });
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/trusted-session/deck-switch']);
  });

  it('surfaces approval API rejections without retrying', async () => {
    const { host, tools, calls } = buildStubHost({
      elicitation: { action: 'accept', content: { requestId: 'req_1', scope: 'session' } },
    });
    host.callBackendAPI = vi.fn(async (endpoint: string, init?: RequestInit) => {
      calls.push({ endpoint, init });
      if (endpoint === '/api/trusted-session/deck-switch') {
        return { ...CREATION };
      }
      throw new BackendApiError('Deck-switch request expired', 410);
    });
    registerMcpTools(host);

    const result = await tools.get('switch_deck')!.handler({ target: 'beta' });

    expect(result.isError).toBe(true);
    expect(resolveCalls(calls)).toHaveLength(1);
  });
});

describe('approval API backstop for forged input (NOT-213)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'deck-a' });
    const deckB = await db.createDeck({ name: 'deck-b' });
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

  function resolve(
    fastify: Awaited<ReturnType<typeof Fastify>>,
    store: TrustedSessionStore,
    requestId: string,
    body: Record<string, unknown>,
  ) {
    return fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload: body,
    });
  }

  it('rejects a forged scope and changes nothing', async () => {
    const { fastify, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const response = await resolve(fastify, store, request.requestId, {
      runtimeSessionId: session.sessionId,
      decision: 'approve',
    });

    expect(response.statusCode).toBe(400);
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });

  it('rejects a forged request id', async () => {
    const { fastify, store, deckA } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });

    const response = await resolve(fastify, store, 'req_forged', {
      runtimeSessionId: session.sessionId,
      decision: 'session',
    });

    expect(response.statusCode).toBe(404);
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
  });

  it('rejects a foreign session resolving another request', async () => {
    const { fastify, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const other = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const response = await resolve(fastify, store, request.requestId, {
      runtimeSessionId: other.sessionId,
      decision: 'session',
    });

    expect(response.statusCode).toBe(403);
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });
});
