/**
 * NOT-597: socket-free coverage for deck assignment (validation, store,
 * tool schema). The HTTP suite (`deck-assignment.http.test.ts`) covers
 * the end-to-end promotion; it needs loopback listeners and runs in CI.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DatabaseManager } from '../models/database';
import { TrustedSessionStore } from '../trusted-session/store';
import { validateAssignmentWorkspace } from '../deck-assignment-validation';
import { UNASSIGNED_DECK_MESSAGE } from '../mcp-unassigned';
import { formatMcpToolError } from './policy';
import { registerMcpTools, type McpToolHost } from './register';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) {
    try {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-assign-unit-'));
  tmpDirs.push(dir);
  return dir;
}

type CapturedTool = {
  config: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> };
  handler: (...args: any[]) => Promise<any>;
};

function buildUnassignedHost(): { host: McpToolHost; tools: Map<string, CapturedTool>; spies: Record<string, any> } {
  const tools = new Map<string, CapturedTool>();
  const spies = { callBackendAPI: vi.fn(async () => ({ status: 'pending', requestId: 'asg_test' })) };
  const host = {
    registerTool: (name: string, config: CapturedTool['config'], handler: CapturedTool['handler']) => {
      tools.set(name, { config, handler });
    },
    profile: 'standard',
    unassigned: true,
    getSessionId: () => 'mcp_test',
    getMode: () => 'normal' as const,
    refreshRuntimeSession: async () => ({ mode: 'normal' as const, deckId: 'deck_a' }),
    getAgentHeaders: () => ({}),
    getBoundDeckId: async () => 'deck_a',
    callBackendAPI: spies.callBackendAPI,
    fetchDeck: async () => ({ id: 'deck_a', name: 'alpha' }),
    buildBindingPayload: async () => ({}),
    registerLiveDisplay: async () => {},
    syncWorkspaceOnBind: async () => null,
    sessionBinding: {
      getBinding: () => ({}),
      setWorkspace: vi.fn(),
      setDeckId: vi.fn(),
      setTrustedSession: vi.fn(),
      isLaunchSession: () => false,
      isUnassigned: () => true,
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

describe('assignment workspace validation (NOT-597)', () => {
  it('accepts an existing absolute directory', () => {
    const dir = makeWorkspace();
    const result = validateAssignmentWorkspace(dir);
    expect(result.ok).toBe(true);
  });

  it('refuses missing, relative, dot-dot, and non-directory paths', () => {
    const dir = makeWorkspace();
    expect(validateAssignmentWorkspace(undefined).ok).toBe(false);
    expect(validateAssignmentWorkspace('').ok).toBe(false);
    expect(validateAssignmentWorkspace('relative/path').ok).toBe(false);
    expect(validateAssignmentWorkspace(path.join(dir, 'missing')).ok).toBe(false);
    expect(validateAssignmentWorkspace(`${dir}${path.sep}..${path.sep}evil`).ok).toBe(false);
    const file = path.join(dir, 'file.txt');
    fs.writeFileSync(file, 'x', 'utf8');
    expect(validateAssignmentWorkspace(file).ok).toBe(false);
  });
});

describe('unassigned tool surface (NOT-597)', () => {
  it('lists request_deck_assignment with no deck-selecting argument', () => {
    const { host, tools } = buildUnassignedHost();
    registerMcpTools(host);
    expect(tools.get('get_session_context')).toBeDefined();
    const tool = tools.get('request_deck_assignment');
    expect(tool).toBeDefined();
    const keys = Object.keys(tool!.config.inputSchema);
    for (const forbidden of ['deck', 'deckId', 'deck_id', 'target', 'deckName']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys).toContain('workspace');
  });

  it('refuses invalid workspaces with no backend call (no approval opened)', async () => {
    const { host, tools, spies } = buildUnassignedHost();
    registerMcpTools(host);
    const handler = tools.get('request_deck_assignment')!.handler;
    for (const args of [
      {},
      { workspace: 'relative/path' },
      { workspace: '/tmp/definitely-missing-agent-deck-assign' },
      { workspace: '/tmp/foo/../bar' },
    ]) {
      const result = await handler(args);
      expect(result.isError).toBe(true);
    }
    expect(spies.callBackendAPI).not.toHaveBeenCalled();
  });

  it('unassigned message names the tool first and keeps the CLI fallback', () => {
    expect(UNASSIGNED_DECK_MESSAGE).toContain('request_deck_assignment');
    expect(UNASSIGNED_DECK_MESSAGE).toContain('agent-deck use <deck>');
    expect(UNASSIGNED_DECK_MESSAGE.indexOf('request_deck_assignment')).toBeLessThan(
      UNASSIGNED_DECK_MESSAGE.indexOf('agent-deck use <deck>'),
    );
  });
});

describe('TrustedSessionStore deck-assignment commit (NOT-597)', () => {
  async function setupDecks() {
    const db = new DatabaseManager(':memory:');
    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const deckA = await db.createDeck({ name: 'deck-a' });
    const deckB = await db.createDeck({ name: 'deck-b' });
    return { db, store, deckA, deckB };
  }

  it('workspace-default creates a session and writes use.json', async () => {
    const { store, deckB } = await setupDecks();
    const workspace = makeWorkspace();
    const record = store.createDeckAssignmentRequest({
      mcpSessionId: 'mcp_1',
      workspaceRoot: workspace,
    });
    expect(record.status).toBe('pending');

    const result = store.applyDeckAssignmentResolution(
      record.requestId,
      { deckId: deckB.id, decision: 'workspace-default' },
      {
        validateWorkspace: (root) => {
          const validated = validateAssignmentWorkspace(root);
          return validated.ok ? { ok: true } : { ok: false, error: validated.error };
        },
      },
    );
    expect(result.outcome).toBe('resolved');
    if (result.outcome !== 'resolved') throw new Error('expected resolved');
    expect(result.deckId).toBe(deckB.id);
    expect(result.runtimeSessionId).toBeTruthy();

    const useJson = JSON.parse(
      fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
    ) as { deckId?: string };
    expect(useJson.deckId).toBe(deckB.id);

    const consumed = store.getConsumedDeckAssignmentByMcp('mcp_1');
    expect(consumed?.runtimeSessionId).toBe(result.runtimeSessionId);
  });

  it('session scope creates a session and writes nothing', async () => {
    const { store, deckA } = await setupDecks();
    const workspace = makeWorkspace();
    const record = store.createDeckAssignmentRequest({
      mcpSessionId: 'mcp_2',
      workspaceRoot: workspace,
    });
    const result = store.applyDeckAssignmentResolution(record.requestId, {
      deckId: deckA.id,
      decision: 'session',
    });
    expect(result.outcome).toBe('resolved');
    expect(fs.existsSync(path.join(workspace, '.agent-deck'))).toBe(false);
  });

  it('decline writes nothing and creates no session', async () => {
    const { store } = await setupDecks();
    const workspace = makeWorkspace();
    const record = store.createDeckAssignmentRequest({
      mcpSessionId: 'mcp_3',
      workspaceRoot: workspace,
    });
    const result = store.applyDeckAssignmentResolution(record.requestId, { decision: 'decline' });
    expect(result.outcome).toBe('declined');
    expect(fs.existsSync(path.join(workspace, '.agent-deck'))).toBe(false);
    expect(store.getConsumedDeckAssignmentByMcp('mcp_3')).toBeNull();
  });
});
