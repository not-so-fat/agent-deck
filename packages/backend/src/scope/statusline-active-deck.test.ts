/**
 * NOT-233: the statusline reflects the session-active deck after a switch.
 *
 * Producer finding (see PR description): the host-rendered statusline is fed
 * by `agent-deck statusline` (packages/cli/src/statusline.ts), which prints
 * the `displayLine` from `GET /api/scope/display`. That route resolves via
 * `resolveDeckDisplay` from the in-memory `LiveDisplayRegistry` — it never
 * reads `.agent-deck/use.json`. The issue hypothesis (statusline reads the
 * workspace default) is refuted: the staleness came from the commit path.
 * `applyDeckSwitchResolution` rebinds the runtime session in the database but
 * nothing refreshed the live-display entry, so the statusline kept naming
 * the previous deck while `get_session_binding` (which resolves live from
 * `/api/scope/deck`) already reported the new one.
 *
 * End-to-end through real HTTP routes (fastify.inject): live bind on deck A,
 * approve a switch to deck B, then read the statusline text from
 * `GET /api/scope/display`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { formatDisplayLine } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { writeUseManifest } from '../playbooks/stub-sync';
import { registerScopeRoutes } from '../routes/scope';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { LiveDisplayRegistry } from './live-display-registry';

const DECK_A_NAME = 'personal-dev-planning';
const DECK_B_NAME = 'personal-dev';

function makeWorkspaceRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-not233-'));
}

function useJsonPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agent-deck', 'use.json');
}

function readRawUseJson(workspaceRoot: string): Buffer {
  return fs.readFileSync(useJsonPath(workspaceRoot));
}

describe('statusline follows the session-active deck (NOT-233)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: DECK_A_NAME });
    const deckB = await db.createDeck({ name: DECK_B_NAME });
    const serviceOnB = await db.createService({
      name: 'svc-b',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp-b',
    });
    await db.addServiceToDeck({ deckId: deckB.id, serviceId: serviceOnB.id, position: 0 });
    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const registry = new LiveDisplayRegistry();

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('liveDisplayRegistry', registry);
    registerHttpPolicyHook(fastify);
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.register(registerScopeRoutes, { prefix: '/api/scope' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, db, store, registry, deckA, deckB };
  }

  async function bindLiveSession(
    registry: LiveDisplayRegistry,
    store: TrustedSessionStore,
    input: { mcpSessionId: string; workspaceRoot?: string; deckId: string; deckName: string },
  ) {
    const session = store.createRuntimeSession({
      deckId: input.deckId,
      mcpSessionId: input.mcpSessionId,
    });
    registry.upsert({
      mcpSessionId: input.mcpSessionId,
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      deckId: input.deckId,
      deckName: input.deckName,
      source: 'launch',
      cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
      updatedAt: '2026-09-20T00:00:00.000Z',
    });
    return session;
  }

  async function getDisplay(fastify: Awaited<ReturnType<typeof Fastify>>, workspaceRoot: string) {
    const response = await fastify.inject({
      method: 'GET',
      url: `/api/scope/display?workspaceRoot=${encodeURIComponent(workspaceRoot)}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json().data as {
      deckId: string | null;
      deckName: string | null;
      source: string;
      cardCounts: { mcp: number; credentials: number; playbooks: number };
      displayLine: string;
    };
  }

  it('session-only switch moves the statusline to B with the session marker and leaves use.json byte-identical', async () => {
    const { fastify, store, registry, deckA, deckB } = await buildApp();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseManifest(workspaceRoot, { version: 3, deckId: deckA.id, deckName: DECK_A_NAME });
    const useJsonBefore = readRawUseJson(workspaceRoot);

    const session = await bindLiveSession(registry, store, {
      mcpSessionId: 'mcp-not233-session',
      workspaceRoot,
      deckId: deckA.id,
      deckName: DECK_A_NAME,
    });
    const badge = registry.get('mcp-not233-session')?.badge;
    expect(badge).toBeTruthy();

    const before = await getDisplay(fastify, workspaceRoot);
    expect(before.deckName).toBe(DECK_A_NAME);
    expect(before.displayLine).not.toContain('session (default');

    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      mcpSessionId: 'mcp-not233-session',
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
    });
    const resolveResponse = await fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${request.requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload: { runtimeSessionId: session.sessionId, decision: 'session' },
    });
    expect(resolveResponse.statusCode).toBe(200);
    expect(resolveResponse.json()).toMatchObject({
      success: true,
      data: { decision: 'session', status: 'consumed', deckName: DECK_B_NAME },
    });

    // NOT-203 invariant: a session-scope commit never touches use.json.
    expect(readRawUseJson(workspaceRoot).equals(useJsonBefore)).toBe(true);

    const display = await getDisplay(fastify, workspaceRoot);
    expect(display.deckId).toBe(deckB.id);
    expect(display.deckName).toBe(DECK_B_NAME);
    expect(display.cardCounts).toEqual({ mcp: 1, credentials: 0, playbooks: 0 });
    expect(display.displayLine).toContain(`session (default ${DECK_A_NAME})`);
    expect(display.displayLine).toContain(`⌘${badge}`);

    // Same composition as get_session_binding.display_summary: active name,
    // counts, badge, saved-default name, id-based override flag.
    const entry = registry.get('mcp-not233-session');
    expect(entry?.deckId).toBe(deckB.id);
    const expected = formatDisplayLine(DECK_B_NAME, display.cardCounts, {
      badge,
      workspaceDefaultName: DECK_A_NAME,
      sessionOverride: true,
      updatedAt: entry?.updatedAt,
    });
    expect(display.displayLine).toBe(expected);
  });

  it('no session-level switch names the launch deck with no session marker', async () => {
    const { fastify, store, registry, deckA } = await buildApp();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseManifest(workspaceRoot, { version: 3, deckId: deckA.id, deckName: DECK_A_NAME });
    await bindLiveSession(registry, store, {
      mcpSessionId: 'mcp-not233-launch',
      workspaceRoot,
      deckId: deckA.id,
      deckName: DECK_A_NAME,
    });

    const display = await getDisplay(fastify, workspaceRoot);
    expect(display.deckId).toBe(deckA.id);
    expect(display.deckName).toBe(DECK_A_NAME);
    expect(display.displayLine).not.toContain('session (default');
  });

  it('launch session with no assignment file names the launch deck with no session marker', async () => {
    const { fastify, store, registry, deckA } = await buildApp();
    const workspaceRoot = makeWorkspaceRoot();
    expect(fs.existsSync(useJsonPath(workspaceRoot))).toBe(false);
    await bindLiveSession(registry, store, {
      mcpSessionId: 'mcp-not233-nofile',
      workspaceRoot,
      deckId: deckA.id,
      deckName: DECK_A_NAME,
    });

    const display = await getDisplay(fastify, workspaceRoot);
    expect(display.deckName).toBe(DECK_A_NAME);
    expect(display.displayLine).not.toContain('session (default');
  });

  it('workspace-default switch moves the statusline to the new deck', async () => {
    const { fastify, store, registry, deckA, deckB } = await buildApp();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseManifest(workspaceRoot, { version: 3, deckId: deckA.id, deckName: DECK_A_NAME });
    const session = await bindLiveSession(registry, store, {
      mcpSessionId: 'mcp-not233-default',
      workspaceRoot,
      deckId: deckA.id,
      deckName: DECK_A_NAME,
    });

    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      mcpSessionId: 'mcp-not233-default',
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
    });
    const resolveResponse = await fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${request.requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload: { runtimeSessionId: session.sessionId, decision: 'workspace-default' },
    });
    expect(resolveResponse.statusCode).toBe(200);

    const display = await getDisplay(fastify, workspaceRoot);
    expect(display.deckId).toBe(deckB.id);
    expect(display.deckName).toBe(DECK_B_NAME);
    expect(display.displayLine).toContain(`◆ ${DECK_B_NAME} ·`);
    // Active deck now equals the saved default, so no override marker.
    expect(display.displayLine).not.toContain('session (default');
  });
});
