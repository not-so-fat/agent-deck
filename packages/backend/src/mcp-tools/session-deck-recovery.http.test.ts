/**
 * NOT-634: an approved "This session only" deck survives a daemon restart
 * for a client that presents its pre-restart `Mcp-Session-Id`.
 *
 * A "restart" here is a fresh backend (new Fastify + new TrustedSessionStore)
 * and a fresh MCP server instance over the same SQLite database. This proves
 * the server-side contract only; it does not prove what real clients send
 * after a restart.
 */
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_DECK_DECK_ID_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
  writeDefaultDeck,
} from '@agent-deck/shared';

import { AgentDeckMCPServer, MCP_REQUIRE_BEARER_ENV_VAR } from '../mcp-server';
import { ClientGrantStore } from '../auth/client-grants';
import { DatabaseManager } from '../models/database';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerScopeRoutes } from '../routes/scope';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';

const MCP_ACCEPT = 'application/json, text/event-stream';

type Deck = { id: string; name: string };

type RawMcpResponse = {
  status: number;
  sessionHeader: string | null;
  body: any;
};

function initializePayload(id: number, clientName = 'vitest') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' },
    },
  };
}

function toolsCall(name: string, args: unknown, id: number) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function toolData(body: any): Record<string, unknown> {
  const text = body?.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`Unexpected tools/call result: ${JSON.stringify(body)}`);
  }
  if (body.result?.isError) {
    throw new Error(`tool error: ${text}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe('approved session deck survives a daemon restart (NOT-634)', () => {
  const tmpDirs: string[] = [];
  let db: DatabaseManager | undefined;
  let backend: Awaited<ReturnType<typeof Fastify>> | undefined;
  let mcpServer: AgentDeckMCPServer | undefined;
  let store: TrustedSessionStore;
  let backendUrl = '';
  let mcpPort = 0;
  let grantStore: ClientGrantStore | null = null;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    'AGENT_DECK_MCP_SKIP_DECK_HEADER',
    'AGENT_DECK_MCP_SKIP_ADMIN_CHECK',
    'AGENT_DECK_STUB_SYNC',
    'AGENT_DECK_HOME',
    'AGENT_DECK_HOSTED_MODE',
    MCP_REQUIRE_BEARER_ENV_VAR,
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = '0';
    process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = '0';
    process.env.AGENT_DECK_STUB_SYNC = 'off';
    delete process.env.AGENT_DECK_HOSTED_MODE;
    delete process.env[MCP_REQUIRE_BEARER_ENV_VAR];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'not634-home-'));
    tmpDirs.push(home);
    process.env.AGENT_DECK_HOME = home;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await stopDaemon();
    db = undefined;
    grantStore = null;
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.restoreAllMocks();
  });

  async function stopDaemon(): Promise<void> {
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = undefined;
    }
    if (backend) {
      await backend.close();
      backend = undefined;
    }
  }

  /** Start (or restart) backend + MCP server over the shared database. */
  async function startDaemon(): Promise<void> {
    db ??= new DatabaseManager(':memory:');
    store = new TrustedSessionStore(db.getSqliteDatabase());
    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('credentialManager', {
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    fastify.decorate('playbookManager', new PlaybookManager(db));
    if (grantStore) {
      fastify.decorate('grantStore', grantStore);
    }
    registerHttpPolicyHook(fastify);
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.register(registerScopeRoutes, { prefix: '/api/scope' });
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    backend = fastify;
    const address = fastify.server.address();
    const port = typeof address === 'object' && address && 'port' in address ? address.port : 0;
    backendUrl = `http://127.0.0.1:${port}`;

    mcpServer = new AgentDeckMCPServer(0, backendUrl, 'standard', '127.0.0.1', {
      ...(grantStore ? { grantStore } : {}),
    });
    await mcpServer.start();
    mcpPort = mcpServer.getPort();
  }

  async function restartDaemon(): Promise<void> {
    await stopDaemon();
    await startDaemon();
  }

  async function createDecks(...names: string[]): Promise<Deck[]> {
    db ??= new DatabaseManager(':memory:');
    const decks: Deck[] = [];
    for (const name of names) {
      decks.push(await db.createDeck({ name }));
    }
    return decks;
  }

  function makeWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not634-ws-'));
    tmpDirs.push(dir);
    return dir;
  }

  function writePin(dir: string, deck: Deck): void {
    fs.mkdirSync(path.join(dir, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agent-deck', 'use.json'),
      JSON.stringify({ version: 3, deckId: deck.id, deckName: deck.name }),
    );
  }

  async function post(
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<RawMcpResponse> {
    const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: MCP_ACCEPT, ...headers },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as any;
    return { status: response.status, sessionHeader: response.headers.get('mcp-session-id'), body };
  }

  async function initialize(
    headers: Record<string, string>,
    presentedSessionId?: string,
  ): Promise<RawMcpResponse> {
    return post(initializePayload(1), {
      ...headers,
      ...(presentedSessionId ? { 'mcp-session-id': presentedSessionId } : {}),
    });
  }

  async function openSession(headers: Record<string, string>): Promise<string> {
    const init = await initialize(headers);
    expect(init.status).toBe(200);
    expect(init.sessionHeader).toBeTruthy();
    return init.sessionHeader!;
  }

  async function sessionContext(
    sessionId: string,
    headers: Record<string, string>,
  ): Promise<RawMcpResponse & { data?: Record<string, unknown> }> {
    const raw = await post(toolsCall('get_session_context', {}, 7), {
      ...headers,
      'mcp-session-id': sessionId,
    });
    return raw.status === 200 && raw.body?.result ? { ...raw, data: toolData(raw.body) } : raw;
  }

  /** switch_deck from the session, then commit the human decision in the store. */
  async function switchAndResolve(
    sessionId: string,
    headers: Record<string, string>,
    target: Deck,
    decision: 'session' | 'workspace-default' | 'decline',
  ): Promise<void> {
    const raw = await post(toolsCall('switch_deck', { target: target.name }, 9), {
      ...headers,
      'mcp-session-id': sessionId,
    });
    const created = toolData(raw.body);
    expect(created.status).toBe('pending');
    const requestId = String(created.requestId);
    const request = store.getDeckSwitchRequest(requestId)!;
    const outcome = store.applyDeckSwitchResolution(requestId, request.runtimeSessionId, decision);
    expect(outcome.outcome).toBe(decision === 'decline' ? 'declined' : 'resolved');
  }

  function runtimeSessionCount(): number {
    return (
      db!.getSqliteDatabase().prepare('SELECT COUNT(*) AS n FROM runtime_sessions').get() as {
        n: number;
      }
    ).n;
  }

  function useDefaultDeck(deck: Deck): void {
    writeDefaultDeck({ deckId: deck.id, deckName: deck.name });
  }

  it('recovers the approved deck across two restarts, by original and by recovered id', async () => {
    const [deckA, deckB] = await createDecks('alpha', 'beta');
    useDefaultDeck(deckA);
    await startDaemon();
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace() };

    const original = await openSession(headers);
    const before = await sessionContext(original, headers);
    expect(before.data?.effective_deck_id).toBe(deckA.id);
    expect(before.data?.active_source).toBe('default-deck');

    await switchAndResolve(original, headers, deckB, 'session');
    // Side bug: a session bound from the default deck that switched reports
    // `session`, not `default-deck`.
    const switched = await sessionContext(original, headers);
    expect(switched.data?.effective_deck_id).toBe(deckB.id);
    expect(switched.data?.active_source).toBe('session');

    // Restart #1: the client keeps sending its original id (no re-initialize).
    await restartDaemon();
    const afterFirst = await sessionContext(original, headers);
    expect(afterFirst.status).toBe(200);
    expect(afterFirst.sessionHeader).toBe(original);
    expect(afterFirst.data?.effective_deck_id).toBe(deckB.id);
    expect(afterFirst.data?.active_source).toBe('session');

    // Restart #2: same original id, again a follow-up.
    await restartDaemon();
    const afterSecond = await sessionContext(original, headers);
    expect(afterSecond.data?.effective_deck_id).toBe(deckB.id);
    expect(afterSecond.data?.active_source).toBe('session');

    // Restart #3: the client re-initializes presenting the original id and
    // is handed a fresh (recovered) id bound to B.
    await restartDaemon();
    const reinit = await initialize(headers, original);
    expect(reinit.status).toBe(200);
    const recovered = reinit.sessionHeader!;
    expect(recovered).toBeTruthy();
    expect(recovered).not.toBe(original);
    const viaRecovered = await sessionContext(recovered, headers);
    expect(viaRecovered.data?.effective_deck_id).toBe(deckB.id);
    expect(viaRecovered.data?.active_source).toBe('session');

    // Restart #4: the client now presents the recovered id.
    await restartDaemon();
    const byRecoveredId = await sessionContext(recovered, headers);
    expect(byRecoveredId.data?.effective_deck_id).toBe(deckB.id);
    expect(byRecoveredId.data?.active_source).toBe('session');

    // Recovery never wrote workspace defaults.
    expect(fs.existsSync(path.join(headers[AGENT_DECK_WORKSPACE_HEADER], '.agent-deck'))).toBe(false);
  });

  it('two sessions sharing workspace and client metadata each recover their own deck', async () => {
    const [deckA, deckB, deckC] = await createDecks('alpha', 'beta', 'gamma');
    useDefaultDeck(deckA);
    await startDaemon();
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace() };

    const first = await openSession(headers);
    const second = await openSession(headers);
    await switchAndResolve(first, headers, deckB, 'session');
    await switchAndResolve(second, headers, deckC, 'session');

    await restartDaemon();
    expect((await sessionContext(first, headers)).data?.effective_deck_id).toBe(deckB.id);
    expect((await sessionContext(second, headers)).data?.effective_deck_id).toBe(deckC.id);

    // An unrelated old id with the same headers gets plain default-deck recovery.
    const stranger = await sessionContext('not634-unrelated-session', headers);
    expect(stranger.data?.effective_deck_id).toBe(deckA.id);
    expect(stranger.data?.active_source).toBe('default-deck');
  });

  it('the approved deck wins over a folder pin and a deck header on recovery', async () => {
    const [deckA, deckB, deckC] = await createDecks('alpha', 'beta', 'gamma');
    await startDaemon();
    const workspace = makeWorkspace();
    writePin(workspace, deckA);
    const pinned = { [AGENT_DECK_WORKSPACE_HEADER]: workspace };
    const pinnedSession = await openSession(pinned);
    await switchAndResolve(pinnedSession, pinned, deckB, 'session');

    const headered = {
      [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace(),
      [AGENT_DECK_DECK_ID_HEADER]: deckA.id,
    };
    const headerSession = await openSession(headered);
    await switchAndResolve(headerSession, headered, deckC, 'session');

    await restartDaemon();
    const pinnedAfter = await sessionContext(pinnedSession, pinned);
    expect(pinnedAfter.data?.effective_deck_id).toBe(deckB.id);
    expect(pinnedAfter.data?.active_source).toBe('session');
    const headerAfter = await sessionContext(headerSession, headered);
    expect(headerAfter.data?.effective_deck_id).toBe(deckC.id);
    expect(headerAfter.data?.active_source).toBe('session');
    // The folder pin was never rewritten.
    expect(JSON.parse(fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8')).deckId).toBe(
      deckA.id,
    );
  });

  it('transport cleanup (DELETE) revokes the runtime session but not the approved deck', async () => {
    const [deckA, deckB] = await createDecks('alpha', 'beta');
    useDefaultDeck(deckA);
    await startDaemon();
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace() };
    const original = await openSession(headers);
    await switchAndResolve(original, headers, deckB, 'session');
    const live = store.findActiveRuntimeSessionByMcpSessionId(original)!;
    expect(live).toBeTruthy();

    // A clean DELETE succeeds and revokes the runtime authority right away,
    // with the daemon still running and no lease forced to expire.
    const deleted = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'DELETE',
      headers: { ...headers, 'mcp-session-id': original },
    });
    expect(deleted.status).toBe(200);
    // The transport's close runs the unified cleanup asynchronously after
    // the 200; bounded wait, daemon still up, no lease touched.
    for (let attempt = 0; attempt < 100 && store.findActiveRuntimeSessionByMcpSessionId(original); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(store.findActiveRuntimeSessionByMcpSessionId(original)).toBeNull();
    expect(store.getRuntimeSessionRow(live.sessionId)?.revoked_at).toBeTruthy();
    expect(store.findSessionDeckOverride(original)?.deckId).toBe(deckB.id);

    await restartDaemon();
    const after = await sessionContext(original, headers);
    expect(after.data?.effective_deck_id).toBe(deckB.id);
    expect(after.data?.active_source).toBe('session');
  });

  it('lease expiry does not erase the approved deck; recovery is normal mode, not admin', async () => {
    const [deckA, deckB] = await createDecks('alpha', 'beta');
    useDefaultDeck(deckA);
    await startDaemon();
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace() };
    const original = await openSession(headers);
    await switchAndResolve(original, headers, deckB, 'session');

    // Elevate to admin before the restart: recovery must not restore it.
    const live = store.findActiveRuntimeSessionByMcpSessionId(original)!;
    expect(store.elevateSessionToAdmin(live.sessionId)?.mode).toBe('agent-admin');
    // The daemon dies without any transport cleanup.
    await stopDaemon();

    // Force every remaining lease past expiry and sweep.
    const sqlite = db!.getSqliteDatabase();
    sqlite
      .prepare(`UPDATE runtime_sessions SET expires_at = ?, admin_expires_at = ?`)
      .run('2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z');
    store.expireStaleSessions();
    expect(store.findActiveRuntimeSessionByMcpSessionId(original)).toBeNull();
    expect(store.findSessionDeckOverride(original)?.deckId).toBe(deckB.id);

    await startDaemon();
    const after = await sessionContext(original, headers);
    expect(after.data?.effective_deck_id).toBe(deckB.id);
    expect(after.data?.active_source).toBe('session');

    const binding = await post(toolsCall('get_session_binding', {}, 11), {
      ...headers,
      'mcp-session-id': original,
    });
    expect(binding.status).toBe(200);
    const runtimeRows = sqlite
      .prepare(
        `SELECT mode, admin_expires_at FROM runtime_sessions
         WHERE revoked_at IS NULL AND deck_id = ?`,
      )
      .all(deckB.id) as Array<{ mode: string; admin_expires_at: string | null }>;
    expect(runtimeRows).toHaveLength(1);
    expect(runtimeRows[0]).toEqual({ mode: 'normal', admin_expires_at: null });
  });

  it('a later approved B→C replaces B; a declined switch leaves B', async () => {
    const [deckA, deckB, deckC] = await createDecks('alpha', 'beta', 'gamma');
    useDefaultDeck(deckA);
    await startDaemon();
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace() };
    const original = await openSession(headers);
    await switchAndResolve(original, headers, deckB, 'session');

    // Decline after a restart: still B.
    await restartDaemon();
    await switchAndResolve(original, headers, deckC, 'decline');
    await restartDaemon();
    expect((await sessionContext(original, headers)).data?.effective_deck_id).toBe(deckB.id);

    // Approve B→C on the recovered session: C replaces B for the original id.
    await switchAndResolve(original, headers, deckC, 'session');
    await restartDaemon();
    const after = await sessionContext(original, headers);
    expect(after.data?.effective_deck_id).toBe(deckC.id);
    expect(after.data?.active_source).toBe('session');
  });

  it('a deleted approved deck fails explicitly instead of falling back', async () => {
    const [deckA, deckB] = await createDecks('alpha', 'beta');
    useDefaultDeck(deckA);
    await startDaemon();
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace() };
    const original = await openSession(headers);
    await switchAndResolve(original, headers, deckB, 'session');

    await stopDaemon();
    await db!.deleteDeck(deckB.id);
    await startDaemon();
    const rowsBefore = runtimeSessionCount();

    const followUp = await sessionContext(original, headers);
    expect(followUp.status).toBe(409);
    expect(followUp.body?.error?.message).toMatch(/^SESSION_DECK_MISSING/);
    expect(followUp.data).toBeUndefined();

    const reinit = await initialize(headers, original);
    expect(reinit.status).toBe(409);
    expect(reinit.sessionHeader).toBeNull();
    expect(reinit.body?.error?.message).toMatch(/^SESSION_DECK_MISSING/);

    // No runtime authority was minted for the failed recoveries.
    expect(runtimeSessionCount()).toBe(rowsBefore);
  });

  it('initialize without an old id is unchanged and ignores other sessions\' approvals', async () => {
    const [deckA, deckB] = await createDecks('alpha', 'beta');
    useDefaultDeck(deckA);
    await startDaemon();
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace() };
    const original = await openSession(headers);
    await switchAndResolve(original, headers, deckB, 'session');

    await restartDaemon();
    const fresh = await openSession(headers);
    const context = await sessionContext(fresh, headers);
    expect(context.data?.effective_deck_id).toBe(deckA.id);
    expect(context.data?.active_source).toBe('default-deck');
  });

  it('a workspace-default approval drops the session override (and is the only use.json writer)', async () => {
    const [deckA, deckB, deckC] = await createDecks('alpha', 'beta', 'gamma');
    await startDaemon();
    const workspace = makeWorkspace();
    writePin(workspace, deckA);
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: workspace };
    const original = await openSession(headers);
    await switchAndResolve(original, headers, deckB, 'session');
    expect(store.findSessionDeckOverride(original)?.deckId).toBe(deckB.id);
    await switchAndResolve(original, headers, deckC, 'workspace-default');
    expect(store.findSessionDeckOverride(original)).toBeNull();

    await restartDaemon();
    const after = await sessionContext(original, headers);
    expect(after.data?.effective_deck_id).toBe(deckC.id);
    expect(after.data?.active_source).toBe('workspace');
  });

  it('never hands a grant session\'s approved deck to a bearer-free or revoked caller', async () => {
    const [deckA, deckB, deckC] = await createDecks('alpha', 'beta', 'gamma');
    db ??= new DatabaseManager(':memory:');
    grantStore = new ClientGrantStore(db.getSqliteDatabase());
    const issued = grantStore.issueGrant({
      label: 'remote',
      defaultDeck: deckA.id,
      allowedDecks: [deckA.id, deckB.id],
    });
    const bearer = { authorization: `Bearer ${issued.token}` };
    await startDaemon();

    const grantSession = await openSession(bearer);
    await switchAndResolve(grantSession, bearer, deckB, 'session');
    expect(store.findSessionDeckOverride(grantSession)?.grantId).toBe(issued.grant.id);

    grantStore.revokeGrant(issued.grant.id);
    await restartDaemon();
    const rowsBefore = runtimeSessionCount();

    // Revoked bearer: initialize is denied, follow-up is not recovered.
    const revokedInit = await initialize(bearer, grantSession);
    expect(revokedInit.status).toBe(401);
    expect(revokedInit.sessionHeader).toBeNull();
    const revokedFollowUp = await sessionContext(grantSession, bearer);
    expect(revokedFollowUp.status).toBe(404);

    // Bearer-free caller presenting the grant session's id and no deck
    // headers: not recovered (404), never bound to B.
    const bearerFree = await sessionContext(grantSession, {});
    expect(bearerFree.status).toBe(404);
    expect(runtimeSessionCount()).toBe(rowsBefore);

    // Bearer-free with a deck header: plain header recovery, not the grant's deck.
    const headerOnly = { [AGENT_DECK_DECK_ID_HEADER]: deckA.id };
    const headered = await sessionContext(grantSession, headerOnly);
    expect(headered.data?.effective_deck_id).toBe(deckA.id);
    expect(headered.data?.active_source).not.toBe('session');

    // ...and that bearer-free session was not aliased into the grant's
    // lineage: approving a session switch on it leaves the grant's B alone.
    await switchAndResolve(grantSession, headerOnly, deckC, 'session');
    expect(store.findSessionDeckOverride(grantSession)).toMatchObject({
      deckId: deckB.id,
      grantId: issued.grant.id,
    });
  });

  it('a valid bearer grant recovers its own approved deck (follow-up, re-initialize, second restart)', async () => {
    const [deckA, deckB, deckC] = await createDecks('alpha', 'beta', 'gamma');
    db ??= new DatabaseManager(':memory:');
    grantStore = new ClientGrantStore(db.getSqliteDatabase());
    const issued = grantStore.issueGrant({
      label: 'remote',
      defaultDeck: deckA.id,
      allowedDecks: [deckA.id, deckB.id],
    });
    const other = grantStore.issueGrant({
      label: 'other',
      defaultDeck: deckA.id,
      allowedDecks: [deckA.id, deckB.id, deckC.id],
    });
    const bearer = { authorization: `Bearer ${issued.token}` };
    const otherBearer = { authorization: `Bearer ${other.token}` };
    await startDaemon();

    const grantSession = await openSession(bearer);
    await switchAndResolve(grantSession, bearer, deckB, 'session');
    const live = await sessionContext(grantSession, bearer);
    expect(live.data?.effective_deck_id).toBe(deckB.id);
    expect(live.data?.active_source).toBe('session');
    const liveRow = store.findActiveRuntimeSessionByMcpSessionId(grantSession)!;
    expect(store.elevateSessionToAdmin(liveRow.sessionId)?.mode).toBe('agent-admin');

    // Restart #1: follow-up on the old id with the same valid bearer.
    await restartDaemon();
    const followUp = await sessionContext(grantSession, bearer);
    expect(followUp.status).toBe(200);
    expect(followUp.sessionHeader).toBe(grantSession);
    expect(followUp.data?.effective_deck_id).toBe(deckB.id);
    expect(followUp.data?.active_source).toBe('session');

    // A different (valid) grant presenting that id gets nothing of it.
    await restartDaemon();
    const stranger = await sessionContext(grantSession, otherBearer);
    expect(stranger.status).toBe(404);
    const strangerInit = await initialize(otherBearer, grantSession);
    expect(strangerInit.status).toBe(200);
    const strangerCtx = await sessionContext(strangerInit.sessionHeader!, otherBearer);
    expect(strangerCtx.data?.effective_deck_id).toBe(deckA.id);
    // Not aliased: a switch on the stranger session leaves the lineage alone.
    await switchAndResolve(strangerInit.sessionHeader!, otherBearer, deckC, 'session');
    expect(store.findSessionDeckOverride(grantSession)).toMatchObject({
      deckId: deckB.id,
      grantId: issued.grant.id,
    });

    // Restart #2: re-initialize presenting the original id.
    await restartDaemon();
    const reinit = await initialize(bearer, grantSession);
    expect(reinit.status).toBe(200);
    const recovered = reinit.sessionHeader!;
    expect(recovered).not.toBe(grantSession);
    const viaRecovered = await sessionContext(recovered, bearer);
    expect(viaRecovered.data?.effective_deck_id).toBe(deckB.id);
    expect(viaRecovered.data?.active_source).toBe('session');

    // Restart #3: the recovered id is presented on a follow-up.
    await restartDaemon();
    const byRecovered = await sessionContext(recovered, bearer);
    expect(byRecovered.data?.effective_deck_id).toBe(deckB.id);
    expect(byRecovered.data?.active_source).toBe('session');

    // Recovered authority is normal mode and still grant-linked.
    const rows = db!
      .getSqliteDatabase()
      .prepare(
        `SELECT mode, grant_id FROM runtime_sessions
         WHERE revoked_at IS NULL AND deck_id = ? AND mcp_session_id != ?`,
      )
      .all(deckB.id, grantSession) as Array<{ mode: string; grant_id: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toEqual({ mode: 'normal', grant_id: issued.grant.id });
    }
  });

  it('a grant whose allowlist no longer contains the approved deck is refused, not fallen back', async () => {
    const [deckA, deckB] = await createDecks('alpha', 'beta');
    db ??= new DatabaseManager(':memory:');
    grantStore = new ClientGrantStore(db.getSqliteDatabase());
    const issued = grantStore.issueGrant({
      label: 'remote',
      defaultDeck: deckA.id,
      allowedDecks: [deckA.id, deckB.id],
    });
    const bearer = { authorization: `Bearer ${issued.token}` };
    await startDaemon();
    const grantSession = await openSession(bearer);
    await switchAndResolve(grantSession, bearer, deckB, 'session');

    await stopDaemon();
    db!
      .getSqliteDatabase()
      .prepare(`UPDATE agent_grants SET allowed_decks = ? WHERE id = ?`)
      .run(JSON.stringify([deckA.id]), issued.grant.id);
    await startDaemon();
    const rowsBefore = runtimeSessionCount();

    const followUp = await sessionContext(grantSession, bearer);
    expect(followUp.status).toBe(403);
    const reinit = await initialize(bearer, grantSession);
    expect(reinit.status).toBe(403);
    expect(reinit.sessionHeader).toBeNull();
    expect(runtimeSessionCount()).toBe(rowsBefore);
  });

  it('an approved session deck equal to the folder pin still reports session after recovery', async () => {
    const [deckA, deckB] = await createDecks('alpha', 'beta');
    await startDaemon();
    const workspace = makeWorkspace();
    writePin(workspace, deckA);
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: workspace };
    const original = await openSession(headers);
    await switchAndResolve(original, headers, deckB, 'session');
    // The folder pin is edited (outside agent-deck) to the same deck.
    writePin(workspace, deckB);
    const live = await sessionContext(original, headers);
    expect(live.data?.active_source).toBe('session');

    await restartDaemon();
    const after = await sessionContext(original, headers);
    expect(after.data?.effective_deck_id).toBe(deckB.id);
    expect(after.data?.active_source).toBe('session');
  });

  /** The database as an earlier version left it: no override tables. */
  function downgradeToPreOverrideSchema(): void {
    db!
      .getSqliteDatabase()
      .exec(`DROP TABLE session_deck_overrides; DROP TABLE session_deck_override_aliases;`);
  }

  it('recovers a provably session-only switch approved by a version without durable overrides', async () => {
    const [deckA, deckB] = await createDecks('alpha', 'beta');
    await startDaemon();
    // No workspace on the session, so the request could not have been a
    // workspace-default approval.
    const headers = { [AGENT_DECK_DECK_ID_HEADER]: deckA.id };
    const original = await openSession(headers);
    await switchAndResolve(original, headers, deckB, 'session');
    await stopDaemon();
    downgradeToPreOverrideSchema();

    await startDaemon();
    const after = await sessionContext(original, headers);
    expect(after.data?.effective_deck_id).toBe(deckB.id);
    expect(after.data?.active_source).toBe('session');
  });

  it.each([
    ['session', 'pin later set to the approved deck', 'same'],
    ['session', 'pin later changed to another deck', 'other'],
    ['workspace-default', 'pin later changed to another deck', 'other'],
    ['workspace-default', 'pin later removed', 'none'],
  ] as const)(
    'a legacy %s approval carrying a workspace (%s) is not migrated and resolves as before',
    async (decision, _label, pinAfter) => {
      const [deckA, deckB, deckC] = await createDecks('alpha', 'beta', 'gamma');
      useDefaultDeck(deckA);
      await startDaemon();
      const workspace = makeWorkspace();
      const headers = { [AGENT_DECK_WORKSPACE_HEADER]: workspace };
      const original = await openSession(headers);
      await switchAndResolve(original, headers, deckB, decision);
      await stopDaemon();
      if (pinAfter === 'same') {
        writePin(workspace, deckB);
      } else if (pinAfter === 'other') {
        writePin(workspace, deckC);
      } else {
        fs.rmSync(path.join(workspace, '.agent-deck'), { recursive: true, force: true });
      }
      downgradeToPreOverrideSchema();

      await startDaemon();
      expect(store.findSessionDeckOverride(original)).toBeNull();
      const after = await sessionContext(original, headers);
      // Plain header → folder pin → default deck resolution.
      const expected = pinAfter === 'same' ? deckB : pinAfter === 'other' ? deckC : deckA;
      expect(after.data?.effective_deck_id).toBe(expected.id);
      expect(after.data?.active_source).toBe(pinAfter === 'none' ? 'default-deck' : 'workspace');
    },
  );

  describe('live recovery aliases are scoped to the presenting principal', () => {
    async function grantLineage() {
      const [deckA, deckB] = await createDecks('alpha', 'beta');
      db ??= new DatabaseManager(':memory:');
      grantStore = new ClientGrantStore(db.getSqliteDatabase());
      const issued = grantStore.issueGrant({
        label: 'remote',
        defaultDeck: deckA.id,
        allowedDecks: [deckA.id, deckB.id],
      });
      const bearer = { authorization: `Bearer ${issued.token}` };
      await startDaemon();
      const grantSession = await openSession(bearer);
      await switchAndResolve(grantSession, bearer, deckB, 'session');
      await restartDaemon();
      return { deckA, deckB, bearer, grantSession };
    }

    it('a bearer-free header recovery first does not capture the grant owner\'s next request', async () => {
      const { deckA, deckB, bearer, grantSession } = await grantLineage();
      const headerOnly = { [AGENT_DECK_DECK_ID_HEADER]: deckA.id };

      const bearerFree = await sessionContext(grantSession, headerOnly);
      expect(bearerFree.status).toBe(200);
      expect(bearerFree.data?.effective_deck_id).toBe(deckA.id);
      expect(bearerFree.data?.active_source).not.toBe('session');

      // No restart in between: the owner still gets its approved deck, on
      // a grant-bound session (the bearer is honoured, not ignored).
      const owner = await sessionContext(grantSession, bearer);
      expect(owner.status).toBe(200);
      expect(owner.data?.effective_deck_id).toBe(deckB.id);
      expect(owner.data?.active_source).toBe('session');

      // Both aliases keep serving their own principal.
      expect((await sessionContext(grantSession, headerOnly)).data?.effective_deck_id).toBe(deckA.id);
      expect((await sessionContext(grantSession, bearer)).data?.effective_deck_id).toBe(deckB.id);
      // A bearer-free request without deck headers never reaches the grant alias.
      expect((await sessionContext(grantSession, {})).data?.effective_deck_id).not.toBe(deckB.id);
    });

    it('a grant recovery first is not served to a later bearer-free request', async () => {
      const { deckA, deckB, bearer, grantSession } = await grantLineage();
      const headerOnly = { [AGENT_DECK_DECK_ID_HEADER]: deckA.id };

      const owner = await sessionContext(grantSession, bearer);
      expect(owner.data?.effective_deck_id).toBe(deckB.id);
      expect(owner.data?.active_source).toBe('session');

      // Bearer-free with no deck headers: 404, not the grant's live session.
      expect((await sessionContext(grantSession, {})).status).toBe(404);
      // Bearer-free with a deck header: its own header recovery.
      const bearerFree = await sessionContext(grantSession, headerOnly);
      expect(bearerFree.data?.effective_deck_id).toBe(deckA.id);
      expect(bearerFree.data?.active_source).not.toBe('session');

      // The owner's alias is untouched.
      const ownerAgain = await sessionContext(grantSession, bearer);
      expect(ownerAgain.data?.effective_deck_id).toBe(deckB.id);
      expect(ownerAgain.data?.active_source).toBe('session');
    });
  });

  it('hosted mode (bearer required) never recovers an approved deck without auth', async () => {
    const [deckA, deckB] = await createDecks('alpha', 'beta');
    useDefaultDeck(deckA);
    await startDaemon();
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace() };
    const original = await openSession(headers);
    await switchAndResolve(original, headers, deckB, 'session');

    process.env[MCP_REQUIRE_BEARER_ENV_VAR] = '1';
    await restartDaemon();
    const rowsBefore = runtimeSessionCount();
    expect((await sessionContext(original, headers)).status).toBe(401);
    const init = await initialize(headers, original);
    expect(init.status).toBe(401);
    expect(init.sessionHeader).toBeNull();
    expect(runtimeSessionCount()).toBe(rowsBefore);
  });
});
