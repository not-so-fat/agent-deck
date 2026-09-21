/**
 * NOT-214: retire legacy deck-switch/admin paths — socket-free coverage.
 * - switch_deck is the only switching operation on runtime/standard profiles.
 * - switch_bound_deck survives only on the legacy profile as a retired
 *   compatibility error: it changes nothing and points at switch_deck.
 * - bind_workspace is bootstrap-only: a bound session cannot move decks
 *   through it, even elevated; admin elevation stays for other deck admin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { BackendApiError } from '../lib/backend-api-error';
import { formatMcpToolError } from './policy';
import { registerMcpTools, type McpToolHost } from './register';

// The repo vitest config skips the admin check globally; these tests assert
// real elevation gating, so they opt back into the policy layer.
const previousSkipAdmin = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
beforeEach(() => {
  delete process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
});
afterEach(() => {
  if (previousSkipAdmin === undefined) {
    delete process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
  } else {
    process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = previousSkipAdmin;
  }
});

type CapturedTool = {
  config: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> };
  handler: (...args: any[]) => Promise<any>;
};

function buildStubHost(overrides?: {
  profile?: 'runtime' | 'standard' | 'legacy';
  boundDeckId?: string | null;
  runtimeSessionId?: string | null;
  mode?: 'normal' | 'agent-admin';
  fetchDeck?: (ref: string) => Promise<{ id: string; name: string }>;
}): { host: McpToolHost; tools: Map<string, CapturedTool>; spies: Record<string, any> } {
  const tools = new Map<string, CapturedTool>();
  const spies = {
    callBackendAPI: vi.fn(async () => ({ deckId: 'deck_a', mode: 'normal' })),
    setDeckId: vi.fn(),
    setWorkspace: vi.fn(),
    setTrustedSession: vi.fn(),
    fetchDeck: vi.fn(
      overrides?.fetchDeck ??
        (async (ref: string) => {
          if (ref === 'deck_b' || ref === 'beta') {
            return { id: 'deck_b', name: 'beta' };
          }
          if (ref === 'deck_a' || ref === 'alpha') {
            return { id: 'deck_a', name: 'alpha' };
          }
          throw new BackendApiError('Deck is outside the bound deck', 403, 'RESOURCE_OUT_OF_SCOPE');
        }),
    ),
  };
  const boundDeckId = overrides?.boundDeckId === undefined ? 'deck_a' : overrides.boundDeckId;
  const runtimeSessionId =
    overrides?.runtimeSessionId === undefined ? 'rs_test' : overrides.runtimeSessionId;
  const host = {
    registerTool: (name: string, config: CapturedTool['config'], handler: CapturedTool['handler']) => {
      tools.set(name, { config, handler });
    },
    profile: overrides?.profile ?? 'standard',
    getSessionId: () => 'mcp_test',
    getMode: () => 'normal' as const,
    refreshRuntimeSession: async () => ({
      mode: (overrides?.mode ?? 'normal') as 'normal' | 'agent-admin',
      deckId: 'deck_a',
    }),
    getAgentHeaders: () => ({}),
    getBoundDeckId: async () => 'deck_a',
    callBackendAPI: spies.callBackendAPI,
    fetchDeck: spies.fetchDeck,
    buildBindingPayload: async () => ({ deck_id: boundDeckId }),
    registerLiveDisplay: async () => {},
    syncWorkspaceOnBind: async () => null,
    sessionBinding: {
      getBinding: () => ({
        workspaceRoot: '/work/test',
        ...(boundDeckId ? { deckId: boundDeckId } : {}),
        ...(runtimeSessionId ? { runtimeSessionId } : {}),
      }),
      setWorkspace: spies.setWorkspace,
      setDeckId: spies.setDeckId,
      setTrustedSession: spies.setTrustedSession,
      isLaunchSession: () => true,
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

describe('retired switch surface (NOT-214)', () => {
  it('lists switch_deck — and not switch_bound_deck — on runtime and standard profiles', () => {
    for (const profile of ['runtime', 'standard'] as const) {
      const { host, tools } = buildStubHost({ profile });
      registerMcpTools({ ...host, profile });
      expect(tools.get('switch_deck'), `switch_deck registered for ${profile}`).toBeDefined();
      expect(tools.get('switch_bound_deck'), `no legacy switch tool for ${profile}`).toBeUndefined();
    }
  });

  it('keeps switch_bound_deck on the legacy profile only, as a retired stub', () => {
    const { host, tools } = buildStubHost({ profile: 'legacy' });
    registerMcpTools({ ...host, profile: 'legacy' as const });
    const stub = tools.get('switch_bound_deck');
    expect(stub).toBeDefined();
    expect(stub!.config.title).toMatch(/retired/i);
    expect(stub!.config.description).toContain('switch_deck');
  });

  it('legacy switch_bound_deck errors toward switch_deck without touching bindings', async () => {
    const { host, tools, spies } = buildStubHost({ profile: 'legacy' });
    registerMcpTools({ ...host, profile: 'legacy' as const });

    const result = await tools.get('switch_bound_deck')!.handler({ deckId: 'deck_b' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('switch_deck');
    expect(spies.callBackendAPI).not.toHaveBeenCalled();
    expect(spies.fetchDeck).not.toHaveBeenCalled();
    expect(spies.setDeckId).not.toHaveBeenCalled();
    expect(spies.setWorkspace).not.toHaveBeenCalled();
    expect(spies.setTrustedSession).not.toHaveBeenCalled();
  });
});

describe('bind_workspace is bootstrap-only (NOT-214)', () => {
  it('rejects a different-deck bind on an already-bound session, even when elevated', async () => {
    const { host, tools, spies } = buildStubHost({ mode: 'agent-admin' });
    registerMcpTools(host);

    const result = await tools
      .get('bind_workspace')!
      .handler({ workspaceRoot: '/work/test', deckId: 'deck_b' });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error_code).toBe('SWITCH_APPROVAL_REQUIRED');
    expect(JSON.stringify(body)).toContain('switch_deck');
    // No approval-bypass: no backend write, no local rebinding, no assignment heal.
    expect(spies.callBackendAPI).not.toHaveBeenCalled();
    expect(spies.setTrustedSession).not.toHaveBeenCalled();
    expect(spies.setDeckId).not.toHaveBeenCalled();
    expect(spies.setWorkspace).not.toHaveBeenCalled();
  });

  it('rejects without an elevation round-trip when the target is out of scope', async () => {
    const { host, tools, spies } = buildStubHost({
      fetchDeck: async () => {
        throw new BackendApiError('Deck is outside the bound deck', 403, 'RESOURCE_OUT_OF_SCOPE');
      },
    });
    registerMcpTools(host);

    const result = await tools
      .get('bind_workspace')!
      .handler({ workspaceRoot: '/work/test', deckId: 'beta' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error_code).toBe('SWITCH_APPROVAL_REQUIRED');
    expect(spies.callBackendAPI).not.toHaveBeenCalled();
  });

  it('still bootstraps an unbound session and rebinds the same deck without elevation', async () => {
    const fresh = buildStubHost({ boundDeckId: null, runtimeSessionId: null });
    registerMcpTools(fresh.host);
    const bound = await fresh.tools
      .get('bind_workspace')!
      .handler({ workspaceRoot: '/work/test', deckId: 'deck_a' });
    expect(bound.isError ?? false).toBe(false);
    expect(fresh.spies.setDeckId).toHaveBeenCalledWith('mcp_test', 'deck_a');

    const { host, tools, spies } = buildStubHost();
    registerMcpTools(host);
    const rebound = await tools
      .get('bind_workspace')!
      .handler({ workspaceRoot: '/work/test', deckId: 'deck_a' });
    expect(rebound.isError ?? false).toBe(false);
    expect(JSON.parse(rebound.content[0].text).deck_name).toBe('alpha');
    expect(spies.callBackendAPI).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spies.callBackendAPI.mock.calls[0][1].body))).toEqual({
      workspaceRoot: '/work/test',
      deckId: 'deck_a',
    });
  });
});

describe('admin elevation stays for unrelated deck administration (NOT-214)', () => {
  it('keeps elevation-gated deck admin tools registered', () => {
    const { host, tools } = buildStubHost();
    registerMcpTools(host);
    for (const name of ['request_admin_elevation', 'exit_admin_mode', 'create_deck', 'manage_deck_card']) {
      expect(tools.get(name), `${name} still registered`).toBeDefined();
    }
  });

  it('still gates deck-card edits on elevation', async () => {
    const { host, tools, spies } = buildStubHost({ mode: 'normal' });
    registerMcpTools(host);
    const denied = await tools
      .get('manage_deck_card')!
      .handler({ action: 'link', card_type: 'service', card_id: 'svc_1' });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text).error_code).toBe('ADMIN_REQUIRED');
    expect(spies.callBackendAPI).not.toHaveBeenCalled();
  });
});
