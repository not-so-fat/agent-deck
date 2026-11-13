/**
 * NOT-600: user default deck set/clear surface and headerless-session fallback.
 *
 * The dashboard API block uses `inject` (no listener); the session-binding
 * block is HTTP end-to-end (initialize with no deck header binds the default).
 */
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_DECK_WORKSPACE_HEADER,
  readDefaultDeck,
} from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import type { AgentDeckMCPServer } from '../mcp-server';
import { unassignedDeckBinding } from '../mcp-unassigned';
import { registerCredentialRoutes } from '../routes/credentials';
import { registerDeckRoutes } from '../routes/decks';
import { registerDefaultDeckRoutes } from '../routes/default-deck';
import { registerPlaybookRoutes } from '../routes/playbooks';
import { registerScopeRoutes } from '../routes/scope';
import { registerServiceRoutes } from '../routes/services';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { agentSessionHeaders, dashboardAuthHeaders } from '../test/auth-fixtures';
import type { ServiceManager } from '../services/service-manager';
import {
  callToolMcpResult,
  listTools,
  openSession,
  postInitialize,
  startMcpServer,
} from './test-harness';

describe('user default deck API (NOT-600)', () => {
  const tmpDirs: string[] = [];
  let db: DatabaseManager;
  let dbPath: string;
  let store: TrustedSessionStore;
  let app: ReturnType<typeof Fastify>;
  let deckAlphaId: string;
  let previousHome: string | undefined;

  function useIsolatedHome(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-not600-home-'));
    tmpDirs.push(dir);
    process.env.AGENT_DECK_HOME = dir;
  }

  beforeEach(async () => {
    previousHome = process.env.AGENT_DECK_HOME;
    useIsolatedHome();

    dbPath = path.join(os.tmpdir(), `agent-deck-not600-${Date.now()}-${Math.random()}.db`);
    db = new DatabaseManager(dbPath);
    deckAlphaId = (await db.createDeck({ name: 'alpha' })).id;
    await db.createDeck({ name: 'beta' });
    store = new TrustedSessionStore(db.getSqliteDatabase());

    app = Fastify();
    app.decorate('db', db);
    app.decorate('trustedSessionStore', store);
    registerHttpPolicyHook(app);
    await app.register(registerDefaultDeckRoutes, { prefix: '/api' });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(dbPath, { force: true });
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
  });

  it('GET returns null when no default is set', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/default-deck',
      headers: dashboardAuthHeaders(store),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, data: null });
  });

  it('PUT sets the default; GET returns it; DELETE clears it', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/default-deck',
      headers: { ...dashboardAuthHeaders(store), 'Content-Type': 'application/json' },
      payload: { deckId: deckAlphaId },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data).toMatchObject({ deckId: deckAlphaId, deckName: 'alpha' });

    const get = await app.inject({
      method: 'GET',
      url: '/api/default-deck',
      headers: dashboardAuthHeaders(store),
    });
    expect(get.json().data).toMatchObject({ deckId: deckAlphaId, deckName: 'alpha' });
    expect(readDefaultDeck()?.deckId).toBe(deckAlphaId);

    const cleared = await app.inject({
      method: 'DELETE',
      url: '/api/default-deck',
      headers: dashboardAuthHeaders(store),
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ success: true, data: { cleared: true } });
    expect(readDefaultDeck()).toBeNull();

    const again = await app.inject({
      method: 'DELETE',
      url: '/api/default-deck',
      headers: dashboardAuthHeaders(store),
    });
    expect(again.json()).toEqual({ success: true, data: { cleared: false } });
  });

  it('PUT rejects a missing deck without touching the stored default', async () => {
    const missing = await app.inject({
      method: 'PUT',
      url: '/api/default-deck',
      headers: { ...dashboardAuthHeaders(store), 'Content-Type': 'application/json' },
      payload: { deckId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(missing.statusCode).toBe(404);
    expect(readDefaultDeck()).toBeNull();

    const empty = await app.inject({
      method: 'PUT',
      url: '/api/default-deck',
      headers: { ...dashboardAuthHeaders(store), 'Content-Type': 'application/json' },
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });

  it('requires dashboard auth', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/api/default-deck',
        headers: { 'Content-Type': 'application/json' },
        payload: method === 'PUT' ? { deckId: deckAlphaId } : undefined,
      });
      expect(response.statusCode, method).toBe(401);
    }
    // An agent session is authenticated but still not the dashboard.
    const agent = await app.inject({
      method: 'GET',
      url: '/api/default-deck',
      headers: agentSessionHeaders(db, deckAlphaId),
    });
    expect(agent.statusCode).toBe(403);
    expect(agent.json()).toMatchObject({ error_code: 'DASHBOARD_REQUIRED' });
    expect(readDefaultDeck()).toBeNull();
  });
});

describe('headerless sessions bind the user default deck (NOT-600)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  const tmpDirs: string[] = [];
  let mcpServer: AgentDeckMCPServer | undefined;
  let previousSkipDeckHeader: string | undefined;
  let previousSkipAdmin: string | undefined;
  let previousStubSync: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousSkipDeckHeader = process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    previousSkipAdmin = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    previousStubSync = process.env.AGENT_DECK_STUB_SYNC;
    previousHome = process.env.AGENT_DECK_HOME;
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
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
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
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
  });

  function useIsolatedHome(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-not600-home-'));
    tmpDirs.push(dir);
    process.env.AGENT_DECK_HOME = dir;
  }

  function makeWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-not600-ws-'));
    tmpDirs.push(dir);
    return dir;
  }

  async function buildListeningBackend() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'alpha' });
    const deckB = await db.createDeck({ name: 'beta' });

    const store = new TrustedSessionStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('serviceManager', {
      discoverServiceTools: async () => [],
      callServiceTool: async () => ({ success: true, result: {} }),
      getAllServices: async () => [],
      getService: async () => null,
      updateToolSettings: async () => null,
    } as unknown as ServiceManager);
    fastify.decorate('credentialManager', {
      get: async () => null,
      listForDeck: async () => [],
      isCredentialOnDeck: async () => false,
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    fastify.decorate('playbookManager', {
      getWithDependencies: async () => null,
      listSummariesForDeck: async () => [],
      listForDeck: async () => [],
      isPlaybookOnDeck: async () => false,
    });
    fastify.decorate('patchManager', {
      listOpenPatchSummaries: async () => [],
      snapshotVersion: async () => {},
    });
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });

    registerHttpPolicyHook(fastify);
    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.register(registerCredentialRoutes, { prefix: '/api/credentials' });
    await fastify.register(registerDeckRoutes, {
      prefix: '/api/decks',
      storeWriter: { writeDeck: async () => {} },
    });
    await fastify.register(registerDefaultDeckRoutes, { prefix: '/api' });
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
      deckA,
      deckB,
      store,
    };
  }

  async function setDefaultDeck(backendUrl: string, store: TrustedSessionStore, deckId: string) {
    const response = await fetch(`${backendUrl}/api/default-deck`, {
      method: 'PUT',
      headers: {
        ...dashboardAuthHeaders(store),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deckId }),
    });
    expect(response.status).toBe(200);
  }

  async function clearDefaultDeck(backendUrl: string, store: TrustedSessionStore) {
    const response = await fetch(`${backendUrl}/api/default-deck`, {
      method: 'DELETE',
      headers: dashboardAuthHeaders(store),
    });
    expect(response.status).toBe(200);
  }

  it('set via the API binds a headerless initialize; clear returns it to explain-only', async () => {
    const { backendUrl, deckA, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;
    useIsolatedHome();

    await setDefaultDeck(backendUrl, store, deckA.id);

    // Workspace header naming a folder with no use.json, no deck header.
    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace() };
    const sessionId = await openSession(started.port, 1, headers);
    const context = await callToolMcpResult(
      started.port,
      sessionId,
      'get_session_context',
      {},
      2,
      headers,
    );
    expect(context.isError).toBe(false);
    expect(context.data.effective_deck_id).toBe(deckA.id);
    expect(context.data.active_source).toBe('default-deck');

    // A default-bound session is bound: no assignment remedy on its tool list.
    const names = (await listTools(started.port, sessionId, 3, headers)).map(
      (tool) => tool.name,
    );
    expect(names).toContain('get_bound_deck');
    expect(names).not.toContain('request_deck_assignment');

    await clearDefaultDeck(backendUrl, store);

    const fresh = await postInitialize(started.port, 10, 'vitest', headers);
    expect(fresh.status).toBe(200);
    const freshId = fresh.headers.get('mcp-session-id');
    expect(freshId).toBeTruthy();
    const cleared = await callToolMcpResult(
      started.port,
      freshId!,
      'get_session_context',
      {},
      11,
      headers,
    );
    expect(cleared.isError).toBe(true);
    expect(cleared.data).toEqual(unassignedDeckBinding());
    expect(cleared.data.error_code).toBe('GRANT_REQUIRED');
  });

  it('pure headerless initialize (no headers at all) binds the default deck', async () => {
    const { backendUrl, deckA, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;
    useIsolatedHome();

    await setDefaultDeck(backendUrl, store, deckA.id);

    const init = await postInitialize(started.port, 1);
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const context = await callToolMcpResult(
      started.port,
      sessionId!,
      'get_session_context',
      {},
      2,
    );
    expect(context.isError).toBe(false);
    expect(context.data.effective_deck_id).toBe(deckA.id);
    expect(context.data.active_source).toBe('default-deck');
  });

  it('deleted default degrades to explain-only and leaves the file in place', async () => {
    const { backendUrl, db, deckA, store } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;
    useIsolatedHome();

    await setDefaultDeck(backendUrl, store, deckA.id);
    expect(await db.deleteDeck(deckA.id)).toBe(true);

    const headers = { [AGENT_DECK_WORKSPACE_HEADER]: makeWorkspace() };
    const init = await postInitialize(started.port, 1, 'vitest', headers);
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const context = await callToolMcpResult(
      started.port,
      sessionId!,
      'get_session_context',
      {},
      2,
      headers,
    );
    expect(context.isError).toBe(true);
    expect(context.data).toEqual(unassignedDeckBinding());
    expect(readDefaultDeck()?.deckId).toBe(deckA.id);
  });
});
