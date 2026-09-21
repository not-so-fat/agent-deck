/**
 * NOT-211: get_session_binding reports the active deck separately from the
 * persistent workspace default, with active_source session | workspace | launch.
 * Socket-free: drives the registered tool handler with a mock host, a real
 * McpSessionBindingStore, and real assignment files in tmp dirs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { McpSessionBindingStore } from '../mcp-session-binding';
import { writeUseManifest } from '../playbooks/stub-sync';
import { registerMcpTools } from './register';
import type { McpToolHost } from './register';

const DECK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DECK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type CapturedHandler = (...args: any[]) => Promise<any>;

function setupHost(opts: {
  scopeDeck: { id: string; name: string } | null;
  badge?: string;
}): { host: McpToolHost; handlers: Map<string, CapturedHandler>; sessionBinding: McpSessionBindingStore } {
  const handlers = new Map<string, CapturedHandler>();
  const sessionBinding = new McpSessionBindingStore();
  const badgeBySession = new Map<string, string>();
  if (opts.badge) {
    badgeBySession.set('s1', opts.badge);
  }
  const host: McpToolHost = {
    registerTool: (name, _config, handler) => {
      handlers.set(name, handler);
    },
    profile: 'standard',
    getSessionId: () => 's1',
    getMode: () => 'normal',
    refreshRuntimeSession: async () => ({ mode: 'normal' as const, deckId: DECK_B }),
    getAgentHeaders: () => ({}),
    getBoundDeckId: async () => DECK_B,
    callBackendAPI: async (endpoint: string) => {
      if (endpoint === '/api/scope/deck') {
        return opts.scopeDeck
          ? { ...opts.scopeDeck, services: [], credentials: [], playbooks: [] }
          : null;
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    fetchDeck: async (deckId: string) => ({ id: deckId, name: deckId }),
    buildBindingPayload: async () => ({}),
    registerLiveDisplay: async () => {},
    syncWorkspaceOnBind: async () => null,
    sessionBinding,
    badgeBySession,
    backendUrl: 'http://127.0.0.1:1',
    toolResult: (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] }),
    toolError: (error: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }],
    }),
  };
  registerMcpTools(host);
  return { host, handlers, sessionBinding };
}

async function callBinding(handlers: Map<string, CapturedHandler>): Promise<Record<string, unknown>> {
  const handler = handlers.get('get_session_binding');
  expect(handler).toBeDefined();
  const result = await handler!();
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function makeWorkspaceRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-not211-unit-'));
}

describe('get_session_binding active vs workspace default (NOT-211)', () => {
  it('returns both decks with session source when active differs from default', async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const { handlers, sessionBinding } = setupHost({
      scopeDeck: { id: DECK_B, name: 'beta' },
      badge: 'fox',
    });
    sessionBinding.setTrustedSession('s1', {
      runtimeSessionId: 'ses_1',
      deckId: DECK_B,
      workspaceRoot,
      mode: 'normal',
    });
    writeUseManifest(workspaceRoot, { version: 3, deckId: DECK_A, deckName: 'alpha' });

    const data = await callBinding(handlers);
    expect(data.active_deck_id).toBe(DECK_B);
    expect(data.active_deck_name).toBe('beta');
    expect(data.workspace_default_deck_id).toBe(DECK_A);
    expect(data.workspace_default_deck_name).toBe('alpha');
    expect(data.active_source).toBe('session');
    expect(String(data.display_summary)).toContain('beta');
    expect(String(data.display_summary)).toContain('session (default alpha)');
    // Legacy fields stay compatible.
    expect(data.effective_deck_id).toBe(DECK_B);
    expect(data.effective_deck_name).toBe('beta');
    expect(data.session_deck_id).toBe(DECK_B);
  });

  it('reports workspace source with no override marker when active equals default', async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const { handlers, sessionBinding } = setupHost({
      scopeDeck: { id: DECK_B, name: 'beta' },
    });
    sessionBinding.setTrustedSession('s1', {
      runtimeSessionId: 'ses_1',
      deckId: DECK_B,
      workspaceRoot,
      mode: 'normal',
    });
    writeUseManifest(workspaceRoot, { version: 3, deckId: DECK_B, deckName: 'beta' });

    const data = await callBinding(handlers);
    expect(data.active_source).toBe('workspace');
    expect(data.workspace_default_deck_id).toBe(DECK_B);
    expect(String(data.display_summary)).not.toContain('session (default');
  });

  it('reports launch source with explicit null default and no assignment file', async () => {
    const workspaceRoot = makeWorkspaceRoot();
    const { handlers, sessionBinding } = setupHost({
      scopeDeck: { id: DECK_B, name: 'beta' },
    });
    sessionBinding.setLaunchSession('s1', {
      runtimeSessionId: 'ses_launch',
      deckId: DECK_B,
      workspaceRoot,
      mode: 'normal',
    });
    expect(fs.existsSync(path.join(workspaceRoot, '.agent-deck', 'use.json'))).toBe(false);

    const data = await callBinding(handlers);
    expect(data.active_deck_id).toBe(DECK_B);
    expect(data.workspace_default_deck_id).toBeNull();
    expect(data.workspace_default_deck_name).toBeNull();
    expect(data.active_source).toBe('launch');
    expect(String(data.display_summary)).not.toContain('session (default');
  });

  it('shows no marker when use.json deckName is stale but ids are equal', async () => {
    // Deck B was renamed beta after the assignment file saved the old name:
    // equal ids mean workspace source, so the stale name must not imply an
    // override (AC2).
    const workspaceRoot = makeWorkspaceRoot();
    const { handlers, sessionBinding } = setupHost({
      scopeDeck: { id: DECK_B, name: 'beta' },
    });
    sessionBinding.setTrustedSession('s1', {
      runtimeSessionId: 'ses_1',
      deckId: DECK_B,
      workspaceRoot,
      mode: 'normal',
    });
    writeUseManifest(workspaceRoot, { version: 3, deckId: DECK_B, deckName: 'alpha-stale' });

    const data = await callBinding(handlers);
    expect(data.active_source).toBe('workspace');
    expect(data.workspace_default_deck_id).toBe(DECK_B);
    expect(String(data.display_summary)).not.toContain('session (default');
  });

  it('shows the marker for same-name decks with different ids', async () => {
    // Two decks share the display name beta: different ids are a real
    // override, and the marker must not be hidden by the name match.
    const workspaceRoot = makeWorkspaceRoot();
    const { handlers, sessionBinding } = setupHost({
      scopeDeck: { id: DECK_B, name: 'beta' },
    });
    sessionBinding.setTrustedSession('s1', {
      runtimeSessionId: 'ses_1',
      deckId: DECK_B,
      workspaceRoot,
      mode: 'normal',
    });
    writeUseManifest(workspaceRoot, { version: 3, deckId: DECK_A, deckName: 'beta' });

    const data = await callBinding(handlers);
    expect(data.active_source).toBe('session');
    expect(data.workspace_default_deck_id).toBe(DECK_A);
    expect(String(data.display_summary)).toContain('session (default beta)');
  });
});
