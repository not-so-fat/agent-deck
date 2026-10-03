/**
 * NOT-318 repair round 2: real-TCP conformance for remote grant auth.
 *
 * `mcp-server.grant-auth.test.ts` drives the MCP handlers with mocked
 * express req/res and a faked transport tail, so the real
 * streamable-HTTP handshake, header normalization, and tool calls on a
 * grant-bound session were never exercised. Every case here runs the
 * real handshake over TCP: real sockets, a real
 * `StreamableHTTPServerTransport` session, and a real listening Fastify
 * backend with the full trusted-session + scope routes. The MCP server
 * runs with `AGENT_DECK_MCP_REQUIRE_BEARER=1` and an injected grant
 * store shared with the backend, so deck-switch creation/approval
 * enforces the same allowlist end to end.
 *
 * Evidence map:
 * - 401 for no/malformed/invalid Bearer, with no backend session row
 * - two grants with different deck scopes each initialize plus one
 *   tool call on their own deck
 * - out-of-scope deck header denied at init (403, no session); a
 *   forged switch_deck denied without moving the binding
 */
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_DECK_ID_HEADER, generateId } from '@agent-deck/shared';

import { ClientGrantStore } from './auth/client-grants';
import { AgentDeckMCPServer, MCP_REQUIRE_BEARER_ENV_VAR } from './mcp-server';
import { DatabaseManager } from './models/database';
import { registerCredentialRoutes } from './routes/credentials';
import { registerDeckRoutes } from './routes/decks';
import { registerPlaybookRoutes } from './routes/playbooks';
import { registerScopeRoutes } from './routes/scope';
import { registerServiceRoutes } from './routes/services';
import { registerTrustedSessionRoutes } from './routes/trusted-session';
import type { ServiceManager } from './services/service-manager';
import { TrustedSessionStore } from './trusted-session/store';
import { registerHttpPolicyHook } from './trusted-session/policy-hook';

const MCP_ACCEPT = 'application/json, text/event-stream';

function initializePayload(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest-grant-conformance', version: '1.0.0' },
    },
  };
}

async function waitForMcpHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`MCP server on :${port} did not become healthy`);
}

async function postInitialize(
  port: number,
  extraHeaders: Record<string, string> | undefined,
  id: number,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      ...extraHeaders,
    },
    body: JSON.stringify(initializePayload(id)),
  });
}

type McpToolCall = {
  status: number;
  isError: boolean;
  data: Record<string, unknown>;
};

async function callToolOverHttp(
  port: number,
  sessionId: string,
  extraHeaders: Record<string, string>,
  name: string,
  args: unknown,
  id: number,
): Promise<McpToolCall> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      'mcp-session-id': sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = (await response.json()) as {
    error?: unknown;
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  if (body.error) {
    throw new Error(`MCP tools/call transport error: ${JSON.stringify(body.error)}`);
  }
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`Unexpected tools/call result: ${JSON.stringify(body)}`);
  }
  return {
    status: response.status,
    isError: Boolean(body.result?.isError),
    data: JSON.parse(text) as Record<string, unknown>,
  };
}

type ConformanceBackend = {
  backendUrl: string;
  deckA: { id: string; name: string };
  deckB: { id: string; name: string };
  db: DatabaseManager;
  store: TrustedSessionStore;
  grantStore: ClientGrantStore;
  close: () => Promise<void>;
};

function runtimeSessionCount(db: DatabaseManager): number {
  const row = db
    .getSqliteDatabase()
    .prepare('SELECT COUNT(*) AS n FROM runtime_sessions')
    .get() as { n: number };
  return row.n;
}

async function buildListeningBackend(grantDb: Database.Database): Promise<ConformanceBackend> {
  const db = new DatabaseManager(':memory:');
  const deckA = await db.createDeck({ name: 'alpha' });
  const deckB = await db.createDeck({ name: 'beta' });

  const serviceOnA = await db.createService({
    name: 'svc-a',
    type: 'mcp',
    url: 'http://127.0.0.1:9/mcp-a',
  });
  const serviceOnB = await db.createService({
    name: 'svc-b',
    type: 'mcp',
    url: 'http://127.0.0.1:9/mcp-b',
  });
  await db.addServiceToDeck({ deckId: deckA.id, serviceId: serviceOnA.id, position: 0 });
  await db.addServiceToDeck({ deckId: deckB.id, serviceId: serviceOnB.id, position: 0 });

  const store = new TrustedSessionStore(db.getSqliteDatabase());
  // One shared grant store: the MCP server authenticates against it and
  // the backend deck-switch creation/approval enforces the same
  // allowlist through it.
  const grantStore = new ClientGrantStore(grantDb);

  const fastify = Fastify();
  fastify.decorate('db', db);
  fastify.decorate('trustedSessionStore', store);
  fastify.decorate('grantStore', grantStore);
  fastify.decorate('serviceManager', {
    discoverServiceTools: async () => [{ name: 'ping', description: 'Ping' }],
    callServiceTool: async () => ({ success: true, result: { ok: true } }),
    getAllServices: async () => [serviceOnA, serviceOnB],
    getService: async (id: string) =>
      id === serviceOnA.id ? serviceOnA : id === serviceOnB.id ? serviceOnB : null,
    updateToolSettings: async (id: string) => (id === serviceOnA.id ? serviceOnA : null),
  } as unknown as ServiceManager);
  fastify.decorate('credentialManager', {
    get: async (id: string) => ({ id, name: 'key', type: 'api_key' }),
    listForDeck: async () => [],
    isCredentialOnDeck: async () => false,
    applySecretStatus: async (credentials: unknown[]) => credentials,
  });
  fastify.decorate('playbookManager', {
    getWithDependencies: async () => null,
    listSummariesForDeck: async () => [],
    listForDeck: async () => [],
    isPlaybookOnDeck: async () => false,
    createWithDependencies: async () => ({
      id: generateId(),
      title: 'pb',
      body: 'body',
      triggers: ['t'],
    }),
    updateWithDependencies: async () => null,
    delete: async () => true,
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
  await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
  await fastify.register(registerScopeRoutes, { prefix: '/api/scope' });
  await fastify.listen({ port: 0, host: '127.0.0.1' });

  const address = fastify.server.address();
  const backendPort =
    typeof address === 'object' && address && 'port' in address ? address.port : 0;

  return {
    backendUrl: `http://127.0.0.1:${backendPort}`,
    deckA,
    deckB,
    db,
    store,
    grantStore,
    close: () => fastify.close(),
  };
}

async function startGrantMcpServer(
  backendUrl: string,
  grantStore: ClientGrantStore,
): Promise<{ port: number; server: AgentDeckMCPServer }> {
  const server = new AgentDeckMCPServer(0, backendUrl, 'standard', '127.0.0.1', {
    grantStore,
  });
  await server.start();
  const port = server.getPort();
  await waitForMcpHealth(port);
  return { port, server };
}

describe('MCP remote grant conformance over real HTTP (NOT-318)', () => {
  const grantDbs: Database.Database[] = [];
  const backends: ConformanceBackend[] = [];
  const mcpServers: AgentDeckMCPServer[] = [];
  let savedBearerFlag: string | undefined;
  let savedSkipDeckHeader: string | undefined;
  let savedSkipAdmin: string | undefined;
  let savedStubSync: string | undefined;

  beforeEach(() => {
    savedBearerFlag = process.env[MCP_REQUIRE_BEARER_ENV_VAR];
    savedSkipDeckHeader = process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    savedSkipAdmin = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    savedStubSync = process.env.AGENT_DECK_STUB_SYNC;
    process.env[MCP_REQUIRE_BEARER_ENV_VAR] = '1';
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = '0';
    process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = '0';
    process.env.AGENT_DECK_STUB_SYNC = 'off';
  });

  afterEach(async () => {
    while (mcpServers.length) {
      await mcpServers.pop()?.stop();
    }
    while (backends.length) {
      await backends.pop()?.close();
    }
    while (grantDbs.length) {
      grantDbs.pop()?.close();
    }
    if (savedBearerFlag === undefined) {
      delete process.env[MCP_REQUIRE_BEARER_ENV_VAR];
    } else {
      process.env[MCP_REQUIRE_BEARER_ENV_VAR] = savedBearerFlag;
    }
    if (savedSkipDeckHeader === undefined) {
      delete process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    } else {
      process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = savedSkipDeckHeader;
    }
    if (savedSkipAdmin === undefined) {
      delete process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    } else {
      process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = savedSkipAdmin;
    }
    if (savedStubSync === undefined) {
      delete process.env.AGENT_DECK_STUB_SYNC;
    } else {
      process.env.AGENT_DECK_STUB_SYNC = savedStubSync;
    }
  });

  async function setup() {
    const grantDb = new Database(':memory:');
    grantDbs.push(grantDb);
    const backend = await buildListeningBackend(grantDb);
    backends.push(backend);
    const mcp = await startGrantMcpServer(backend.backendUrl, backend.grantStore);
    mcpServers.push(mcp.server);
    return { backend, port: mcp.port };
  }

  it('rejects unauthenticated initialize over real HTTP with no backend session row', async () => {
    const { backend, port } = await setup();
    const probe = backend.grantStore.issueGrant({
      label: 'probe',
      defaultDeck: backend.deckA.id,
    });
    const attempts: Array<Record<string, string> | undefined> = [
      undefined,
      { authorization: 'Basic abcdef' },
      { authorization: 'Bearer' },
      { authorization: 'Bearer not-a-grant-token' },
      { authorization: `Bearer adg_${probe.grant.id}_wrong-secret-value` },
    ];
    const before = runtimeSessionCount(backend.db);
    const bodies: string[] = [];
    for (let index = 0; index < attempts.length; index += 1) {
      const response = await postInitialize(port, attempts[index], 100 + index);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(response.headers.get('mcp-session-id')).toBeNull();
      const body = (await response.json()) as {
        error?: { message?: string };
      };
      expect(body).toMatchObject({ error: { message: 'GRANT_REQUIRED' } });
      bodies.push(JSON.stringify(body));
    }
    // One stable envelope for every credential failure: no oracle.
    expect(new Set(bodies).size).toBe(1);
    expect(runtimeSessionCount(backend.db)).toBe(before);
  });

  it('authenticates two grants with different deck scopes, one tool call each', async () => {
    const { backend, port } = await setup();
    const grantA = backend.grantStore.issueGrant({
      label: 'agent-a',
      defaultDeck: backend.deckA.id,
      allowedDecks: [backend.deckA.id],
    });
    const grantB = backend.grantStore.issueGrant({
      label: 'agent-b',
      defaultDeck: backend.deckB.id,
      allowedDecks: [backend.deckB.id],
    });

    // Grant A: no deck header, so it lands on its default deck.
    const authA = { authorization: `Bearer ${grantA.token}` };
    const initA = await postInitialize(port, authA, 1);
    expect(initA.status).toBe(200);
    await initA.json();
    const sessionA = initA.headers.get('mcp-session-id');
    expect(sessionA).toBeTruthy();

    const boundA = await callToolOverHttp(port, sessionA!, authA, 'get_bound_deck', {}, 2);
    expect(boundA.status).toBe(200);
    expect(boundA.isError).toBe(false);
    expect(boundA.data.id).toBe(backend.deckA.id);

    // Grant B: explicit allowed deck header binds that deck.
    const authB = {
      authorization: `Bearer ${grantB.token}`,
      [AGENT_DECK_DECK_ID_HEADER]: backend.deckB.id,
    };
    const initB = await postInitialize(port, authB, 3);
    expect(initB.status).toBe(200);
    await initB.json();
    const sessionB = initB.headers.get('mcp-session-id');
    expect(sessionB).toBeTruthy();
    expect(sessionB).not.toBe(sessionA);

    const boundB = await callToolOverHttp(port, sessionB!, authB, 'get_bound_deck', {}, 4);
    expect(boundB.status).toBe(200);
    expect(boundB.isError).toBe(false);
    expect(boundB.data.id).toBe(backend.deckB.id);
  });

  it('denies an out-of-scope deck header and a forged switch without moving the binding', async () => {
    const { backend, port } = await setup();
    const grantA = backend.grantStore.issueGrant({
      label: 'agent-a',
      defaultDeck: backend.deckA.id,
      allowedDecks: [backend.deckA.id],
    });
    const authA = { authorization: `Bearer ${grantA.token}` };

    // A deck outside the allowlist is denied at init even though it exists.
    const before = runtimeSessionCount(backend.db);
    const denied = await postInitialize(
      port,
      { ...authA, [AGENT_DECK_DECK_ID_HEADER]: backend.deckB.id },
      1,
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('mcp-session-id')).toBeNull();
    const deniedBody = (await denied.json()) as {
      error?: { message?: string };
    };
    expect(deniedBody).toMatchObject({ error: { message: 'RESOURCE_OUT_OF_SCOPE' } });
    expect(runtimeSessionCount(backend.db)).toBe(before);

    // The same grant on its own deck cannot switch outside the allowlist.
    const init = await postInitialize(port, authA, 2);
    expect(init.status).toBe(200);
    await init.json();
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const forged = await callToolOverHttp(
      port,
      sessionId!,
      authA,
      'switch_deck',
      { target: 'beta' },
      3,
    );
    expect(forged.isError).toBe(true);
    expect(forged.data).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });

    const bound = await callToolOverHttp(port, sessionId!, authA, 'get_bound_deck', {}, 4);
    expect(bound.isError).toBe(false);
    expect(bound.data.id).toBe(backend.deckA.id);
  });
});
