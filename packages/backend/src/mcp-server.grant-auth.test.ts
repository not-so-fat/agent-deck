/**
 * NOT-318: deck authorization enforced before MCP initialize.
 *
 * These tests drive the real `AgentDeckMCPServer` HTTP routing
 * (`handleMcpPost` / `handleMcpSessionRequest`) with mocked express
 * req/res objects — no TCP listen is required, so they run anywhere.
 * The backend is stubbed at `globalThis.fetch`; only the transport
 * handshake itself is faked, since it needs a real Node req/res pair
 * (covered for the local path by the TCP suites in CI).
 *
 * Evidence map:
 * - unauthenticated initialize rejected before transport/session creation
 * - valid grant binds its default deck and an explicitly allowed deck
 * - out-of-grant decks denied at init and on follow-up (forged header),
 *   without changing the binding
 * - expired/revoked grants fail; revocation invalidates a live session
 * - loopback launcher initialize still works with no bearer
 * - logs/responses carry grant ids but never secrets or Authorization values
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_DECK_DECK_ID_HEADER } from '@agent-deck/shared';

import { ClientGrantStore, parseGrantToken } from './auth/client-grants';
import { AuditStore } from './audit/store';
import {
  AgentDeckMCPServer,
  MCP_INITIALIZE_RATE_LIMIT,
  MCP_INITIALIZE_RATE_WINDOW_MS,
  MCP_REQUIRE_BEARER_ENV_VAR,
} from './mcp-server';

const SKIP_HEADER_ENV_VAR = 'AGENT_DECK_MCP_SKIP_DECK_HEADER';

function initializeBody(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1.0.0' },
    },
  };
}

type SentResponse = {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
};

function mockRes() {
  const sent: SentResponse = { headers: {} };
  const res: Record<string, (...args: never[]) => unknown> = {};
  res.status = ((code: number) => {
    sent.status = code;
    return res;
  }) as never;
  res.set = ((key: string, value: string) => {
    sent.headers[key] = value;
    return res;
  }) as never;
  res.json = ((body: unknown) => {
    sent.body = body;
    return res;
  }) as never;
  res.send = ((body: unknown) => {
    sent.body = body;
    return res;
  }) as never;
  return { res: res as never, sent };
}

function mockReq(body: unknown, headers: Record<string, string> = {}) {
  return { body, headers, socket: { remoteAddress: '127.0.0.1' } } as never;
}

type McpServerInternals = {
  sessions: Map<string, { transport: { handleRequest: (...args: unknown[]) => Promise<void> } }>;
  sessionBinding: {
    getBinding(sessionId: string): { deckId?: string };
    getGrantScope(sessionId: string): { grantId: string } | undefined;
  };
  handleMcpPost(req: never, res: never): Promise<void>;
  handleMcpSessionRequest(req: never, res: never): Promise<void>;
};

describe('MCP remote grant authorization (NOT-318)', () => {
  const dbs: Database.Database[] = [];
  let savedBearerFlag: string | undefined;
  let savedSkipFlag: string | undefined;
  let savedHostedFlag: string | undefined;
  let fetchStub: ReturnType<typeof vi.fn> | null = null;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    savedBearerFlag = process.env[MCP_REQUIRE_BEARER_ENV_VAR];
    savedSkipFlag = process.env[SKIP_HEADER_ENV_VAR];
    savedHostedFlag = process.env.AGENT_DECK_HOSTED_MODE;
    process.env[MCP_REQUIRE_BEARER_ENV_VAR] = '1';
    delete process.env[SKIP_HEADER_ENV_VAR];
  });

  afterEach(() => {
    if (savedBearerFlag === undefined) {
      delete process.env[MCP_REQUIRE_BEARER_ENV_VAR];
    } else {
      process.env[MCP_REQUIRE_BEARER_ENV_VAR] = savedBearerFlag;
    }
    if (savedSkipFlag === undefined) {
      delete process.env[SKIP_HEADER_ENV_VAR];
    } else {
      process.env[SKIP_HEADER_ENV_VAR] = savedSkipFlag;
    }
    if (savedHostedFlag === undefined) {
      delete process.env.AGENT_DECK_HOSTED_MODE;
    } else {
      process.env.AGENT_DECK_HOSTED_MODE = savedHostedFlag;
    }
    if (fetchStub) {
      fetchStub.mockRestore();
      fetchStub = null;
    } else {
      globalThis.fetch = originalFetch;
    }
    while (dbs.length) {
      dbs.pop()?.close();
    }
    vi.restoreAllMocks();
  });

  function buildServer(now?: () => number) {
    const db = new Database(':memory:');
    dbs.push(db);
    const grantStore = new ClientGrantStore(db);
    const auditStore = new AuditStore(db);
    const server = new AgentDeckMCPServer(0, 'http://127.0.0.1:1', undefined, '127.0.0.1', {
      grantStore,
      auditStore,
      now,
    });
    return {
      server: server as unknown as McpServerInternals & { [k: string]: unknown },
      grantStore,
      auditStore,
    };
  }

  /** Stub the backend connect-deck + runtime-session endpoints. */
  function stubBackend(deckIdFor?: (requested: string) => string) {
    fetchStub = vi.fn(async (url: unknown, init?: { body?: string }) => {
      const target = String(url);
      if (target.endsWith('/api/trusted-session/mcp/connect-deck')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { deckId: string };
        const deckId = deckIdFor ? deckIdFor(payload.deckId) : payload.deckId;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { sessionId: 'ses_stub', deckId, mode: 'normal' },
          }),
          text: async () => '{}',
        };
      }
      if (target.endsWith('/api/trusted-session/runtime-session')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { sessionId: 'ses_stub', deckId: 'deck-a', mode: 'normal' },
          }),
          text: async () => '{}',
        };
      }
      throw new Error(`unexpected backend call: ${target}`);
    });
    globalThis.fetch = fetchStub as unknown as typeof fetch;
  }

  /**
   * Fake the transport handshake tail only: record the minted session and
   * make follow-up delivery observable, without needing a real socket.
   */
  function fakeTransport(server: McpServerInternals & { [k: string]: unknown }) {
    const established: string[] = [];
    const delivered: unknown[] = [];
    (server as { establishTransportSession: unknown }).establishTransportSession = async (
      _req: unknown,
      _res: unknown,
      sessionId: string,
    ) => {
      established.push(sessionId);
      server.sessions.set(sessionId, {
        transport: {
          handleRequest: async (...args: unknown[]) => {
            delivered.push(args[2] ?? args[0]);
          },
        },
      });
    };
    return { established, delivered };
  }

  async function postMcp(
    server: McpServerInternals,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<SentResponse> {
    const { res, sent } = mockRes();
    await server.handleMcpPost(mockReq(body, headers), res);
    return sent;
  }

  it('rejects unauthenticated initialize before transport/session creation', async () => {
    const { server } = buildServer();
    stubBackend();

    for (const authorization of [
      undefined,
      'Basic abcdef',
      'Bearer',
      'Bearer   ',
      'Bearer adg_no-such-grant_secret',
    ]) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (authorization !== undefined) {
        headers.authorization = authorization;
      }
      const sent = await postMcp(server, initializeBody(), headers);
      expect(sent.status).toBe(401);
      expect(sent.body).toMatchObject({ error: { message: 'GRANT_REQUIRED' } });
      expect(sent.headers['WWW-Authenticate']).toBe('Bearer');
    }
    expect(server.sessions.size).toBe(0);
  });

  it('returns byte-identical 401 bodies for every credential failure (no oracle)', async () => {
    const { server, grantStore, auditStore } = buildServer();
    stubBackend();
    const issued = grantStore.issueGrant({ label: 'oracle', defaultDeck: 'deck-a' });
    const grantId = parseGrantToken(issued.token)!.grantId;
    const expired = grantStore.issueGrant({
      label: 'expired',
      defaultDeck: 'deck-a',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const revoked = grantStore.issueGrant({ label: 'revoked', defaultDeck: 'deck-a' });
    grantStore.revokeGrant(revoked.grant.id);

    const attempts = [
      {},
      { authorization: 'Bearer malformed' },
      { authorization: 'Bearer adg_unknown_x' },
      { authorization: `Bearer adg_${grantId}_wrongsecret` },
      { authorization: `Bearer ${expired.token}` },
      { authorization: `Bearer ${revoked.token}` },
    ];
    const bodies = [];
    for (const extra of attempts) {
      const sent = await postMcp(server, initializeBody(), {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...extra,
      });
      expect(sent.status).toBe(401);
      bodies.push(JSON.stringify(sent.body));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(server.sessions.size).toBe(0);
  });

  it('a valid grant initializes on its default deck, then on an allowed deck', async () => {
    const { server, grantStore, auditStore } = buildServer();
    stubBackend();
    const { established } = fakeTransport(server as McpServerInternals & { [k: string]: unknown });
    const issued = grantStore.issueGrant({
      label: 'two-decks',
      defaultDeck: 'deck-a',
      allowedDecks: ['deck-a', 'deck-b'],
    });
    const auth = { authorization: `Bearer ${issued.token}` };

    const onDefault = await postMcp(server, initializeBody(1), { ...auth });
    expect(established).toHaveLength(1);
    expect(server.sessionBinding.getBinding(established[0]).deckId).toBe('deck-a');
    expect(server.sessionBinding.getGrantScope(established[0])?.grantId).toBe(issued.grant.id);

    const onAllowed = await postMcp(server, initializeBody(2), {
      ...auth,
      [AGENT_DECK_DECK_ID_HEADER]: 'deck-b',
    });
    expect(established).toHaveLength(2);
    expect(server.sessionBinding.getBinding(established[1]).deckId).toBe('deck-b');
    expect(auditStore.list({ limit: 10 })).toMatchObject([
      { actor: issued.grant.id, event: 'grant.used', targetId: 'invalid-deck-id', outcome: 'succeeded' },
      { actor: issued.grant.id, event: 'grant.used', targetId: 'invalid-deck-id', outcome: 'succeeded' },
    ]);
    void onDefault;
    void onAllowed;
  });

  it('limits initialize per authenticated grant, recovers, and leaves live traffic alone', async () => {
    process.env.AGENT_DECK_HOSTED_MODE = '1';
    let now = 50_000;
    const { server, grantStore } = buildServer(() => now);
    stubBackend();
    const { established, delivered } = fakeTransport(
      server as McpServerInternals & { [k: string]: unknown },
    );
    const issued = grantStore.issueGrant({ label: 'rate-limited', defaultDeck: 'deck-a' });
    const otherGrant = grantStore.issueGrant({ label: 'independent', defaultDeck: 'deck-b' });
    const auth = { authorization: `Bearer ${issued.token}` };

    for (let attempt = 0; attempt < MCP_INITIALIZE_RATE_LIMIT; attempt += 1) {
      await postMcp(server, initializeBody(attempt + 1), auth);
    }
    expect(established).toHaveLength(MCP_INITIALIZE_RATE_LIMIT);

    const limited = await postMcp(server, initializeBody(100), auth);
    expect(limited.status).toBe(429);
    expect(limited.headers['Retry-After']).toBe('60');

    await postMcp(server, initializeBody(101), {
      authorization: `Bearer ${otherGrant.token}`,
    });
    expect(established).toHaveLength(MCP_INITIALIZE_RATE_LIMIT + 1);

    const existingSession = established[0];
    await postMcp(
      server,
      { jsonrpc: '2.0', id: 102, method: 'tools/list', params: {} },
      { ...auth, 'mcp-session-id': existingSession },
    );
    expect(delivered).toHaveLength(1);

    now += MCP_INITIALIZE_RATE_WINDOW_MS;
    await postMcp(server, initializeBody(103), auth);
    expect(established).toHaveLength(MCP_INITIALIZE_RATE_LIMIT + 2);
  });

  it('two grants with different scopes each bind only their own decks', async () => {
    const { server, grantStore, auditStore } = buildServer();
    stubBackend();
    const { established } = fakeTransport(server as McpServerInternals & { [k: string]: unknown });
    const grantA = grantStore.issueGrant({ label: 'a', defaultDeck: 'deck-a' });
    const grantB = grantStore.issueGrant({
      label: 'b',
      defaultDeck: 'deck-b',
      allowedDecks: ['deck-b', 'deck-c'],
    });

    // A cannot reach B's deck, even though that deck exists.
    const denied = await postMcp(server, initializeBody(1), {
      authorization: `Bearer ${grantA.token}`,
      [AGENT_DECK_DECK_ID_HEADER]: 'deck-b',
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { message: 'RESOURCE_OUT_OF_SCOPE' } });
    expect(auditStore.list({ limit: 10 })).toMatchObject([
      {
        actor: grantA.grant.id,
        event: 'deck.selection_denied',
        targetId: 'invalid-deck-id',
        outcome: 'denied',
        reasonCode: 'resource_out_of_scope',
      },
    ]);

    const allowed = await postMcp(server, initializeBody(2), {
      authorization: `Bearer ${grantB.token}`,
      [AGENT_DECK_DECK_ID_HEADER]: 'deck-c',
    });
    expect(established).toHaveLength(1);
    expect(server.sessionBinding.getBinding(established[0]).deckId).toBe('deck-c');
    expect(server.sessionBinding.getGrantScope(established[0])?.grantId).toBe(grantB.grant.id);
    expect(server.sessions.size).toBe(1);
    void denied;
    void allowed;
  });

  it('a forged deck header on follow-up is denied without moving the binding', async () => {
    const { server, grantStore } = buildServer();
    stubBackend();
    const { established, delivered } = fakeTransport(
      server as McpServerInternals & { [k: string]: unknown },
    );
    const issued = grantStore.issueGrant({
      label: 'forged',
      defaultDeck: 'deck-a',
      allowedDecks: ['deck-a', 'deck-b'],
    });
    const auth = { authorization: `Bearer ${issued.token}` };
    await postMcp(server, initializeBody(1), { ...auth });
    const sessionId = established[0];

    const forged = await postMcp(
      server,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { ...auth, 'mcp-session-id': sessionId, [AGENT_DECK_DECK_ID_HEADER]: 'deck-evil' },
    );
    expect(forged.status).toBe(403);
    expect(delivered).toHaveLength(0);
    expect(server.sessionBinding.getBinding(sessionId).deckId).toBe('deck-a');

    const legit = await postMcp(
      server,
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { ...auth, 'mcp-session-id': sessionId },
    );
    expect(delivered).toHaveLength(1);
    expect(server.sessionBinding.getBinding(sessionId).deckId).toBe('deck-a');
    void forged;
    void legit;
  });

  it('never copies bearer or tool-payload sentinels into audit rows', async () => {
    const { server, grantStore, auditStore } = buildServer();
    stubBackend();
    const { established } = fakeTransport(server as McpServerInternals & { [k: string]: unknown });
    const issued = grantStore.issueGrant({ label: 'redaction', defaultDeck: 'deck-a' });
    const payloadSentinel = 'SENTINEL_TOOL_PAYLOAD_DO_NOT_STORE';
    const headerSentinel = 'SENTINEL_HEADER_DO_NOT_STORE';
    const auth = { authorization: `Bearer ${issued.token}` };
    await postMcp(server, initializeBody(1), auth);
    await postMcp(
      server,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'probe', arguments: { secret: payloadSentinel } },
      },
      { ...auth, 'mcp-session-id': established[0] },
    );
    await postMcp(
      server,
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      {
        ...auth,
        'mcp-session-id': established[0],
        [AGENT_DECK_DECK_ID_HEADER]: headerSentinel,
      },
    );

    const serialized = JSON.stringify(auditStore.list({ limit: 10 }));
    expect(serialized).not.toContain(issued.token);
    expect(serialized).not.toContain(auth.authorization);
    expect(serialized).not.toContain(payloadSentinel);
    expect(serialized).not.toContain(headerSentinel);
    expect(auditStore.list({ limit: 10 }).filter((row) => row.event === 'grant.used')).toHaveLength(1);
  });

  it('revocation invalidates a live session on its next request', async () => {
    const { server, grantStore } = buildServer();
    stubBackend();
    const { established, delivered } = fakeTransport(
      server as McpServerInternals & { [k: string]: unknown },
    );
    const issued = grantStore.issueGrant({ label: 'live', defaultDeck: 'deck-a' });
    const auth = { authorization: `Bearer ${issued.token}` };
    await postMcp(server, initializeBody(1), { ...auth });
    const sessionId = established[0];

    const before = await postMcp(
      server,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { ...auth, 'mcp-session-id': sessionId },
    );
    expect(delivered).toHaveLength(1);

    grantStore.revokeGrant(issued.grant.id);
    const after = await postMcp(
      server,
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { ...auth, 'mcp-session-id': sessionId },
    );
    expect(after.status).toBe(401);
    expect(after.body).toMatchObject({ error: { message: 'GRANT_REQUIRED' } });
    expect(delivered).toHaveLength(1);

    // New sessions with the revoked secret fail too.
    const retry = await postMcp(server, initializeBody(4), { ...auth });
    expect(retry.status).toBe(401);
    expect(server.sessions.size).toBe(1);
    void before;
  });

  it('an expired grant fails on follow-up inside the promised window', async () => {
    const { server, grantStore } = buildServer();
    stubBackend();
    const { established, delivered } = fakeTransport(
      server as McpServerInternals & { [k: string]: unknown },
    );
    const issued = grantStore.issueGrant({
      label: 'short-lived',
      defaultDeck: 'deck-a',
      expiresAt: new Date(Date.now() + 400).toISOString(),
    });
    const auth = { authorization: `Bearer ${issued.token}` };
    await postMcp(server, initializeBody(1), { ...auth });
    const sessionId = established[0];
    expect(server.sessions.size).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = await postMcp(
      server,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { ...auth, 'mcp-session-id': sessionId },
    );
    expect(after.status).toBe(401);
    expect(delivered).toHaveLength(0);
  });

  it('a backend-revoked runtime session fails closed on follow-up', async () => {
    const { server, grantStore } = buildServer();
    stubBackend();
    // The grant is live but the backend lease is gone: fail closed anyway.
    fetchStub!.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/api/trusted-session/mcp/connect-deck')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { sessionId: 'ses_stub', deckId: 'deck-a', mode: 'normal' },
          }),
          text: async () => '{}',
        };
      }
      return { ok: false, status: 401, json: async () => ({}), text: async () => 'revoked' };
    });
    const { established } = fakeTransport(server as McpServerInternals & { [k: string]: unknown });
    const issued = grantStore.issueGrant({ label: 'lease', defaultDeck: 'deck-a' });
    const auth = { authorization: `Bearer ${issued.token}` };
    await postMcp(server, initializeBody(1), { ...auth });
    const followUp = await postMcp(
      server,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { ...auth, 'mcp-session-id': established[0] },
    );
    expect(followUp.status).toBe(401);
  });

  it('hosted GET/DELETE checks the Bearer [REDACTED] a session exists', async () => {
    const { server, grantStore } = buildServer();
    stubBackend();
    const issued = grantStore.issueGrant({ label: 'stream', defaultDeck: 'deck-a' });

    const unauthenticated = mockRes();
    await server.handleMcpSessionRequest(
      mockReq(undefined, { 'mcp-session-id': 'no-such-session' }),
      unauthenticated.res,
    );
    expect(unauthenticated.sent.status).toBe(401);

    const authenticated = mockRes();
    await server.handleMcpSessionRequest(
      mockReq(undefined, {
        'mcp-session-id': 'no-such-session',
        authorization: `Bearer ${issued.token}`,
      }),
      authenticated.res,
    );
    // Authenticated but unknown: the restart 404, never the 401 body.
    expect(authenticated.sent.status).toBe(404);
  });

  it('loopback launcher initialize needs no Bearer [REDACTED] local mode', async () => {
    delete process.env[MCP_REQUIRE_BEARER_ENV_VAR];
    const { server } = buildServer();
    stubBackend();
    const { established } = fakeTransport(server as McpServerInternals & { [k: string]: unknown });

    const sent = await postMcp(server, initializeBody(1), {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      [AGENT_DECK_DECK_ID_HEADER]: 'deck-local',
    });
    expect(established).toHaveLength(1);
    expect(server.sessionBinding.getBinding(established[0]).deckId).toBe('deck-local');
    expect(server.sessionBinding.getGrantScope(established[0])).toBeUndefined();
    void sent;
  });

  it('local mode still rejects session-less non-initialize posts with 400, not 401', async () => {
    delete process.env[MCP_REQUIRE_BEARER_ENV_VAR];
    const { server } = buildServer();
    stubBackend();
    const sent = await postMcp(
      server,
      { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} },
      { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    );
    expect(sent.status).toBe(400);
  });

  it('never logs Bearer [REDACTED] Authorization values on success or failure', async () => {
    const { server, grantStore } = buildServer();
    stubBackend();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    });
    try {
      const issued = grantStore.issueGrant({ label: 'SENTINEL-LABEL', defaultDeck: 'deck-a' });
      const grantId = parseGrantToken(issued.token)!.grantId;
      const wrongSecret = 'SENTINELWRONGSECRET_value_that_must_never_appear';
      const forged = `adg_${grantId}_${wrongSecret}`;
      const authorizationValue = `Bearer ${forged}`;

      const denied = await postMcp(server, initializeBody(1), {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        authorization: authorizationValue,
      });
      expect(denied.status).toBe(401);

      // Grant ids and labels may appear; the secret and full header never do.
      expect(lines.some((line) => line.includes(grantId))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain(wrongSecret);
        expect(line).not.toContain(authorizationValue);
      }
      expect(JSON.stringify(denied.body)).not.toContain(wrongSecret);
      expect(JSON.stringify(denied.body)).not.toContain(authorizationValue);
    } finally {
      spy.mockRestore();
    }
  });
});
