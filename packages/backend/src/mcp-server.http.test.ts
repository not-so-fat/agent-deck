import Database from 'better-sqlite3';
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  AGENT_DECK_BRIDGE_LIVENESS_HEADER,
  AGENT_DECK_BRIDGE_LIVENESS_V1,
  AGENT_DECK_DECK_ID_HEADER,
  AGENT_DECK_PLAYBOOK_PIN_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
  generateId,
} from '@agent-deck/shared';
import {
  AgentDeckMCPServer,
  DEFAULT_LIVE_TOUCH_KEEPALIVE_MS,
  DEFAULT_TRANSPORT_IDLE_TTL_MS,
  DEFAULT_TRANSPORT_SWEEP_INTERVAL_MS,
  DEFAULT_UNREGISTER_CONCURRENCY,
  LIVE_TOUCH_KEEPALIVE_ENV_VAR,
  MCP_INITIALIZE_RATE_LIMIT,
  MCP_INITIALIZE_RATE_WINDOW_MS,
  MCP_REQUIRE_BEARER_ENV_VAR,
  resolveLiveTouchKeepAliveMs,
} from './mcp-server';
import type { McpSessionBindingStore } from './mcp-session-binding';
import {
  callToolMcpResult,
  installStrictConsoleCapture,
  openSession,
  startMcpServer,
} from './mcp-tools/test-harness';
import { AuditStore } from './audit/store';
import { ClientGrantStore } from './auth/client-grants';
import { DatabaseManager } from './models/database';
import { PatchManager } from './playbooks/patch-manager';
import { PlaybookManager } from './playbooks/playbook-manager';
import { registerPlaybookPatchRoutes } from './routes/playbook-patches';
import { registerPlaybookRoutes } from './routes/playbooks';
import { registerScopeRoutes } from './routes/scope';
import { registerTrustedSessionRoutes } from './routes/trusted-session';
import { registerHttpPolicyHook } from './trusted-session/policy-hook';
import { TrustedSessionStore } from './trusted-session/store';

const MCP_ACCEPT = 'application/json, text/event-stream';

function initializePayload(id = 1) {
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

async function postInitialize(port: number, id = 1) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
    },
    body: JSON.stringify(initializePayload(id)),
  });
}

async function listTools(port: number, sessionId: string, id: number) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/list',
      params: {},
    }),
  });
  const body = await response.json();
  return body.result.tools as Array<{ name: string; inputSchema?: { required?: string[] } }>;
}

async function readStaleSessions(
  port: number,
): Promise<{ recoveredSessions: number; unresolvedSessions: number }> {
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  return health.staleSessions;
}

describe('AgentDeckMCPServer streamable HTTP', () => {
  let port: number;
  let mcpServer: AgentDeckMCPServer;
  let consoleCapture: ReturnType<typeof installStrictConsoleCapture>;

  beforeAll(async () => {
    // Backend is intentionally unreachable (`:1`); allow expected unregister noise on stop.
    consoleCapture = installStrictConsoleCapture({
      allowPrefixes: ['Failed to call backend API'],
    });
    mcpServer = new AgentDeckMCPServer(0, 'http://127.0.0.1:1');
    await mcpServer.start();
    port = mcpServer.getPort();
    await waitForMcpHealth(port);
  });

  afterAll(async () => {
    await mcpServer.stop();
    consoleCapture.restore();
    consoleCapture.assertClean();
  });

  it('returns health metadata', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await response.json();
    expect(body.service).toBe('agent-deck-mcp-server');
  });

  it('allows multiple POST initialize sessions (regression: single global session)', async () => {
    const first = await postInitialize(port, 1);
    expect(first.status).toBe(200);
    const sessionOne = first.headers.get('mcp-session-id');
    expect(sessionOne).toBeTruthy();

    const second = await postInitialize(port, 2);
    expect(second.status).toBe(200);
    const sessionTwo = second.headers.get('mcp-session-id');
    expect(sessionTwo).toBeTruthy();
    expect(sessionTwo).not.toBe(sessionOne);
  });

  it('serves GET /mcp for an initialized session (Claude Code SSE stream)', async () => {
    const init = await postInitialize(port, 10);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'GET',
      headers: {
        'mcp-session-id': sessionId!,
        Accept: 'text/event-stream',
      },
    });

    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    await stream.body?.cancel();
  });

  it('limits hosted initialize floods, recovers, and never cuts an existing stream', async () => {
    const previousHostedMode = process.env.AGENT_DECK_HOSTED_MODE;
    process.env.AGENT_DECK_HOSTED_MODE = '1';
    let now = 25_000;
    // Reachable stub backend (same shape as the badge-flow stub below): the
    // rate limit under test never touches the backend, but every initialize
    // fire-and-forgets registerLiveDisplay and stop() drains unregister —
    // against an unreachable URL those are dozens of failing fetches whose
    // console noise and timing variance made this test fragile in CI.
    const stub = await startStubBackend();
    const server = new AgentDeckMCPServer(
      0,
      `http://127.0.0.1:${stub.port}`,
      undefined,
      '127.0.0.1',
      { now: () => now },
    );
    const capture = installStrictConsoleCapture({
      allowPrefixes: ['Failed to call backend API'],
    });
    await server.start();
    try {
      const limitedPort = server.getPort();
      const initialized: Response[] = [];
      for (let attempt = 0; attempt < MCP_INITIALIZE_RATE_LIMIT; attempt += 1) {
        initialized.push(await postInitialize(limitedPort, 1_000 + attempt));
      }
      expect(initialized.every((response) => response.status === 200)).toBe(true);
      await Promise.all(initialized.map((response) => response.arrayBuffer()));

      const limited = await postInitialize(limitedPort, 2_000);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      await limited.arrayBuffer();

      const sessionId = initialized[0].headers.get('mcp-session-id')!;
      const stream = await fetch(`http://127.0.0.1:${limitedPort}/mcp`, {
        method: 'GET',
        headers: { 'mcp-session-id': sessionId, Accept: 'text/event-stream' },
      });
      expect(stream.status).toBe(200);

      now += MCP_INITIALIZE_RATE_WINDOW_MS;
      const recovered = await postInitialize(limitedPort, 2_001);
      expect(recovered.status).toBe(200);
      await recovered.arrayBuffer();
      await expect(listTools(limitedPort, sessionId, 2_002)).resolves.toEqual(expect.any(Array));
      expect(stream.body).not.toBeNull();
      await stream.body?.cancel();
      expect(stub.unhandled).toEqual([]);
    } finally {
      await server.stop();
      await stub.close();
      capture.restore();
      capture.assertClean();
      if (previousHostedMode === undefined) delete process.env.AGENT_DECK_HOSTED_MODE;
      else process.env.AGENT_DECK_HOSTED_MODE = previousHostedMode;
    }
  });

  it('rejects GET /mcp without a session id', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    });
    expect(response.status).toBe(400);
  });

  it('rejects non-initialize POST without a session id', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(response.status).toBe(400);
  });

  it('does not expose removed repo-deck MCP tools', async () => {
    const init = await postInitialize(port, 50);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const tools = await listTools(port, sessionId!, 51);
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain('setup_repo_deck');
    expect(names).not.toContain('get_repo_deck_status');

    const bindWorkspace = tools.find((tool) => tool.name === 'bind_workspace');
    expect(bindWorkspace?.inputSchema?.required).toEqual(
      expect.arrayContaining(['workspaceRoot', 'deckId']),
    );

    expect(names).toContain('manage_deck_card');
    expect(names).toContain('list_collection');
    expect(names).toContain('get_bound_deck');
    expect(names).toContain('create_deck');
    expect(names).not.toContain('delete_service');
    expect(names).not.toContain('delete_playbook');
    expect(names).not.toContain('add_service_to_bound_deck');
    expect(names).not.toContain('list_playbooks');
  });

  // NOT-101: a restart wipes in-memory sessions. Clients must be able to tell
  // "your session is gone, re-initialize" apart from "your request was malformed".
  it('answers an unknown session id with 404 so the client re-initializes', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': 'session-from-a-previous-process',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 60, method: 'tools/list', params: {} }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('mcp-session-status')).toBe('expired');
    const body = await response.json();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('Session not found');
    expect(body.error.message).toContain('re-initialize');
  });

  it('answers GET /mcp for an unknown session with the same 404 signal', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'mcp-session-id': 'gone-with-the-restart' },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('mcp-session-status')).toBe('expired');
    const body = await response.json();
    expect(body.error.code).toBe(-32001);
  });

  it('accepts an initialize that still carries a stale session id', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': 'stale-but-re-initializing',
      },
      body: JSON.stringify(initializePayload(61)),
    });

    expect(response.status).toBe(200);
    const fresh = response.headers.get('mcp-session-id');
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe('stale-but-re-initializing');
  });

  it('reports instance identity and the stale-session tally on /health', async () => {
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': 'another-orphan',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 70, method: 'tools/list', params: {} }),
    });

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.instanceId).toBeTruthy();
    expect(typeof health.startedAt).toBe('string');
    expect(typeof health.liveSessions).toBe('number');
    expect(health.staleSessions.count).toBeGreaterThan(0);
    expect(health.staleSessions.distinctSessions).toBeGreaterThan(0);
    expect(typeof health.staleSessions.lastAt).toBe('string');
  });

  // A handshake that names the session it lost only counts as recovery once the
  // replacement session exists — a rejected replay leaves the client stranded.
  it('keeps a stale session unresolved when its replayed handshake is rejected', async () => {
    const lost = 'session-whose-replay-gets-rejected';
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': lost,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 80, method: 'tools/list', params: {} }),
    });
    const stranded = await readStaleSessions(port);

    // The replay arrives with a launch deck the (unreachable) backend cannot
    // confirm, so it is rejected before any session is established.
    const rejected = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'x-agent-deck-deck-id': STUB_DECK_ID,
        'x-agent-deck-recovered-session': lost,
      },
      body: JSON.stringify(initializePayload(81)),
    });
    expect(rejected.status).toBe(401);

    const afterRejection = await readStaleSessions(port);
    expect(afterRejection.unresolvedSessions).toBe(stranded.unresolvedSessions);
    expect(afterRejection.recoveredSessions).toBe(stranded.recoveredSessions);

    // The same client succeeding on a later attempt does clear the warning.
    const accepted = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'x-agent-deck-recovered-session': lost,
      },
      body: JSON.stringify(initializePayload(82)),
    });
    expect(accepted.status).toBe(200);

    const afterRecovery = await readStaleSessions(port);
    expect(afterRecovery.unresolvedSessions).toBe(stranded.unresolvedSessions - 1);
    expect(afterRecovery.recoveredSessions).toBe(stranded.recoveredSessions + 1);
  });

  // A request that was already on the wire when the restart hit lands on the old
  // session id after its client has reconnected. The bridge answers it from the
  // replacement session and never handshakes again, so re-stranding the id here
  // would warn about a healthy client with nothing left to clear the warning.
  it('keeps a recovered client recovered when a straggler arrives on the old id', async () => {
    const lost = 'session-with-an-in-flight-request';
    const stale = async (id: number) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: MCP_ACCEPT,
          'mcp-session-id': lost,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
      });

    await stale(100);
    const stranded = await readStaleSessions(port);

    const recovered = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'x-agent-deck-recovered-session': lost,
      },
      body: JSON.stringify(initializePayload(101)),
    });
    expect(recovered.status).toBe(200);
    const afterRecovery = await readStaleSessions(port);
    expect(afterRecovery.unresolvedSessions).toBe(stranded.unresolvedSessions - 1);

    // The straggler: still a 404 so any client that did not recover re-initializes…
    expect((await stale(102)).status).toBe(404);

    // …but the tally still shows this client as one that came back. Only the
    // request counter moves, which is what it is: past activity.
    const afterStraggler = await readStaleSessions(port);
    expect(afterStraggler.unresolvedSessions).toBe(afterRecovery.unresolvedSessions);
    expect(afterStraggler.recoveredSessions).toBe(afterRecovery.recoveredSessions);
  });

  // A session this process ended is not a client left behind by a restart, so a
  // late request on it must not make `agent-deck status` warn about one.
  it('does not count a session it closed itself as a stranded client', async () => {
    const initialized = await postInitialize(port, 90);
    const sessionId = initialized.headers.get('mcp-session-id')!;
    expect(sessionId).toBeTruthy();
    const before = await readStaleSessions(port);

    const closed = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'DELETE',
      headers: { Accept: MCP_ACCEPT, 'mcp-session-id': sessionId },
    });
    expect(closed.status).toBeLessThan(400);

    // The straggler every client sends: an in-flight call, or the GET stream
    // reconnecting, after the session was terminated.
    const late = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/list', params: {} }),
    });

    // Still the spec answer, so the client re-initializes...
    expect(late.status).toBe(404);
    expect(late.headers.get('mcp-session-status')).toBe('expired');
    // ...but nothing is reported as stranded on a server that never restarted.
    const after = await readStaleSessions(port);
    expect(after).toEqual(before);
  });
});

import http from 'node:http';

const STUB_DECK_ID = '33333333-3333-4333-8333-333333333333';

type StubBackend = {
  port: number;
  liveDisplayBodies: any[];
  touches: string[];
  unregisters: string[];
  connects: any[];
  disconnects: any[];
  unhandled: string[];
  close: () => Promise<void>;
};

function startStubBackend(): Promise<StubBackend> {
  const liveDisplayBodies: any[] = [];
  const touches: string[] = [];
  const unregisters: string[] = [];
  const connects: any[] = [];
  const disconnects: any[] = [];
  const unhandled: string[] = [];
  const deck = {
    id: STUB_DECK_ID,
    name: 'Stub Deck',
    services: [{ type: 'mcp' }],
    credentials: [],
    playbooks: [{}],
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const respond = (body: unknown, status = 200) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      if (req.method === 'GET' && (url === '/api/scope/deck' || url === `/api/decks/${STUB_DECK_ID}`)) {
        respond({ success: true, data: deck });
        return;
      }
      if (req.method === 'GET' && url === '/api/playbooks/summaries') {
        respond({ success: true, data: [] });
        return;
      }
      if (req.method === 'POST' && url === '/api/scope/live-display') {
        liveDisplayBodies.push(JSON.parse(raw));
        respond({ success: true, data: { badge: 'fox' } });
        return;
      }
      if (req.method === 'POST' && /^\/api\/scope\/live-display\/.+\/touch$/.test(url)) {
        touches.push(url);
        respond({ success: true });
        return;
      }
      if (req.method === 'DELETE' && /^\/api\/scope\/live-display\/[^/]+$/.test(url)) {
        unregisters.push(url);
        respond({ success: true });
        return;
      }
      if (req.method === 'POST' && url === '/api/scope/deck-workspace') {
        respond({ success: true, data: { ok: true } });
        return;
      }
      // NOT-191: launch-deck trust handshake so cleanup tests can bind a
      // session with a runtime session id (existing tests never call these).
      if (req.method === 'POST' && url === '/api/trusted-session/mcp/connect-deck') {
        const parsed = JSON.parse(raw || '{}');
        connects.push(parsed);
        respond({
          success: true,
          data: { sessionId: `runtime-${parsed.mcpSessionId ?? 'x'}`, deckId: parsed.deckId, mode: 'normal' },
        });
        return;
      }
      if (req.method === 'POST' && url === '/api/trusted-session/mcp/disconnect-deck') {
        disconnects.push(JSON.parse(raw || '{}'));
        respond({ success: true, data: { revoked: true } });
        return;
      }
      if (req.method === 'GET' && url === '/api/trusted-session/runtime-session') {
        respond({ success: true, data: { mode: 'normal', deckId: STUB_DECK_ID } });
        return;
      }
      unhandled.push(`${req.method} ${url}`);
      respond({ success: false, error: `stub: unhandled ${req.method} ${url}` }, 500);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        liveDisplayBodies,
        touches,
        unregisters,
        connects,
        disconnects,
        unhandled,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function callTool(port: number, sessionId: string, name: string, args: unknown, id: number) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = await response.json();
  return JSON.parse(body.result.content[0].text);
}

describe('session badge flow (stub backend)', () => {
  let stub: StubBackend;
  let badgePort: number;
  let badgeServer: AgentDeckMCPServer;
  let consoleCapture: ReturnType<typeof installStrictConsoleCapture>;

  beforeAll(async () => {
    consoleCapture = installStrictConsoleCapture();
    stub = await startStubBackend();
    badgeServer = new AgentDeckMCPServer(0, `http://127.0.0.1:${stub.port}`);
    await badgeServer.start();
    badgePort = badgeServer.getPort();
    await waitForMcpHealth(badgePort);
  });

  afterAll(async () => {
    await badgeServer.stop();
    await stub.close();
    expect(stub.unhandled, `Unhandled stub routes: ${stub.unhandled.join(', ')}`).toEqual([]);
    consoleCapture.restore();
    consoleCapture.assertClean();
  });

  it('bind_workspace registers clientName and echoes display_summary with badge', async () => {
    const init = await postInitialize(badgePort, 100);
    const sessionId = init.headers.get('mcp-session-id')!;

    const bound = await callTool(badgePort, sessionId, 'bind_workspace', {
      workspaceRoot: '/tmp/badge-repo',
      deckId: STUB_DECK_ID,
    }, 101);

    expect(bound.badge).toBe('fox');
    expect(bound.display_summary).toContain('⌘fox');
    expect(bound.display_summary).toContain('Stub Deck');
    expect(stub.liveDisplayBodies[0].clientName).toBe('vitest');

    const binding = await callTool(badgePort, sessionId, 'get_session_binding', {}, 102);
    expect(binding.badge).toBe('fox');
    expect(binding.display_summary).toContain('⌘fox');
  });

  it('fires a debounced activity touch on subsequent requests', async () => {
    const init = await postInitialize(badgePort, 200);
    const sessionId = init.headers.get('mcp-session-id')!;
    await callTool(badgePort, sessionId, 'bind_workspace', {
      workspaceRoot: '/tmp/touch-repo',
      deckId: STUB_DECK_ID,
    }, 201);

    const before = stub.touches.length;
    await callTool(badgePort, sessionId, 'get_session_binding', {}, 202);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stub.touches.length).toBeGreaterThan(before);
  });

  it('NOT-191: a clean DELETE removes the transport, binding, badge, and live-display row', async () => {
    const internals = badgeServer as unknown as {
      sessions: Map<string, unknown>;
      sessionBinding: McpSessionBindingStore;
      badgeBySession: Map<string, string>;
      lastTouchAtMs: Map<string, number>;
      lastClientActivityAtMs: Map<string, number>;
    };
    const deckHeaders = { [AGENT_DECK_DECK_ID_HEADER]: STUB_DECK_ID };
    const init = await fetch(`http://127.0.0.1:${badgePort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        ...deckHeaders,
      },
      body: JSON.stringify(initializePayload(400)),
    });
    expect(init.status).toBe(200);
    await init.arrayBuffer();
    const sessionId = init.headers.get('mcp-session-id')!;
    expect(internals.sessions.has(sessionId)).toBe(true);
    // The launch handshake bound a trusted runtime session.
    expect(internals.sessionBinding.getBinding(sessionId).runtimeSessionId).toBe(
      `runtime-${sessionId}`,
    );
    // The fire-and-forget live-display registration lands the badge.
    for (let attempt = 0; attempt < 50 && !internals.badgeBySession.has(sessionId); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(internals.badgeBySession.get(sessionId)).toBe('fox');

    const closed = await fetch(`http://127.0.0.1:${badgePort}/mcp`, {
      method: 'DELETE',
      headers: { Accept: MCP_ACCEPT, 'mcp-session-id': sessionId, ...deckHeaders },
    });
    expect(closed.status).toBe(200);
    await closed.arrayBuffer();

    // The transport map clears in cleanup's synchronous prefix, but the badge,
    // binding, and backend calls clear after the disconnect/unregister
    // round-trips — poll for the fully-cleaned terminal state, not the map.
    const cleanedUp = () =>
      !internals.sessions.has(sessionId) &&
      !internals.badgeBySession.has(sessionId) &&
      internals.sessionBinding.getBinding(sessionId).runtimeSessionId === undefined &&
      stub.unregisters.some((url) => url.includes(encodeURIComponent(sessionId))) &&
      stub.disconnects.some((body) => body.mcpSessionId === sessionId);
    for (let attempt = 0; attempt < 100 && !cleanedUp(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(internals.sessions.has(sessionId)).toBe(false);
    expect(internals.badgeBySession.has(sessionId)).toBe(false);
    expect(internals.lastTouchAtMs.has(sessionId)).toBe(false);
    expect(internals.lastClientActivityAtMs.has(sessionId)).toBe(false);
    expect(internals.sessionBinding.getBinding(sessionId).runtimeSessionId).toBeUndefined();
    expect(internals.sessionBinding.hasSessionDeckOverride(sessionId)).toBe(false);
    expect(internals.sessionBinding.isLaunchSession(sessionId)).toBe(false);
    expect(
      stub.unregisters.some((url) => url.includes(encodeURIComponent(sessionId))),
    ).toBe(true);
    expect(stub.disconnects.some((body) => body.mcpSessionId === sessionId)).toBe(true);

    // And the closed session answers the spec expiry signal afterwards.
    const late = await fetch(`http://127.0.0.1:${badgePort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': sessionId,
        ...deckHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 401, method: 'tools/list', params: {} }),
    });
    expect(late.status).toBe(404);
    await late.arrayBuffer();
  });
});

describe('live-display keep-alive (NOT-309)', () => {
  it('resolveLiveTouchKeepAliveMs defaults, clamps, and parses', () => {
    // Default 5 minutes under the default 30-minute stale bound.
    expect(resolveLiveTouchKeepAliveMs(undefined, 30 * 60_000)).toBe(
      DEFAULT_LIVE_TOUCH_KEEPALIVE_MS,
    );
    expect(resolveLiveTouchKeepAliveMs('', 30 * 60_000)).toBe(DEFAULT_LIVE_TOUCH_KEEPALIVE_MS);
    // Shortened stale bound clamps the default under a third of the bound.
    expect(resolveLiveTouchKeepAliveMs(undefined, 6_000)).toBe(2_000);
    // Disabled expiry keeps the plain default.
    expect(resolveLiveTouchKeepAliveMs(undefined, 0)).toBe(DEFAULT_LIVE_TOUCH_KEEPALIVE_MS);
    // Explicit values win, including 0 to disable.
    expect(resolveLiveTouchKeepAliveMs('1000', 30 * 60_000)).toBe(1_000);
    expect(resolveLiveTouchKeepAliveMs('0', 30 * 60_000)).toBe(0);
    // Invalid values fall back.
    expect(resolveLiveTouchKeepAliveMs('nope', 30 * 60_000)).toBe(
      DEFAULT_LIVE_TOUCH_KEEPALIVE_MS,
    );
    expect(resolveLiveTouchKeepAliveMs('-3', 30 * 60_000)).toBe(DEFAULT_LIVE_TOUCH_KEEPALIVE_MS);
    // NOT-309 repair round 2: a tiny stale bound clamps to a 1ms floor instead
    // of rounding the keep-alive interval down to 0 (disabled).
    expect(resolveLiveTouchKeepAliveMs(undefined, 2)).toBe(1);
    expect(resolveLiveTouchKeepAliveMs(undefined, 1)).toBe(1);
  });

  it('a touch-miss (found:false) re-registers the still-connected session', async () => {
    // A live session swept during a host sleep must return to the registry
    // without a reconnect; an explicit found:false is the trigger, while an
    // older backend answering {} stays a quiet no-op.
    const server = new AgentDeckMCPServer(0, 'http://127.0.0.1:1');
    const internals = server as unknown as {
      sessions: Map<string, unknown>;
      badgeBySession: Map<string, string>;
      touchLiveDisplay: (id: string, force?: boolean) => void;
    };
    // Fake session mirrors the real McpSession shape closely enough for the
    // re-register path (`server.server.getClientVersion()`); a bare
    // `server: {}` throws there and the re-register POST never fires.
    internals.sessions.set('s1', {
      transport: {},
      server: { server: { getClientVersion: () => undefined } },
    });
    internals.badgeBySession.set('s1', 'fox');
    const liveDisplayPosts: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string }) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      if (target.endsWith('/api/scope/deck')) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            data: { id: STUB_DECK_ID, name: 'Stub Deck', services: [], credentials: [], playbooks: [] },
          }),
        };
      }
      if (target.endsWith('/touch')) {
        return { ok: true, json: async () => ({ success: true, data: { found: false } }) };
      }
      if (target.endsWith('/api/scope/live-display') && method === 'POST') {
        liveDisplayPosts.push(target);
        return { ok: true, json: async () => ({ success: true, data: { badge: 'fox' } }) };
      }
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    });
    try {
      internals.touchLiveDisplay('s1', true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(liveDisplayPosts.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a touch-miss after the transport closed does not resurrect the session', async () => {
    // Close race: a keep-alive touch in flight when transport.onclose sends
    // DELETE can answer found:false after the entry is gone. The session is
    // no longer in the open-transport map, so no re-register may fire.
    const server = new AgentDeckMCPServer(0, 'http://127.0.0.1:1');
    const internals = server as unknown as {
      sessions: Map<string, unknown>;
      badgeBySession: Map<string, string>;
      touchLiveDisplay: (id: string, force?: boolean) => void;
    };
    // Badge lingers (clearSession runs in the unregister .finally) but the
    // transport is gone — exactly the in-flight-touch ordering on close.
    internals.badgeBySession.set('s1', 'fox');
    const liveDisplayPosts: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string }) => {
      const target = String(url);
      if (target.endsWith('/touch')) {
        return { ok: true, json: async () => ({ success: true, data: { found: false } }) };
      }
      if (target.endsWith('/api/scope/live-display') && (init?.method ?? 'GET') === 'POST') {
        liveDisplayPosts.push(target);
      }
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    });
    try {
      internals.touchLiveDisplay('s1', true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(liveDisplayPosts).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a touch answered without found (older backend) does not re-register', async () => {
    const server = new AgentDeckMCPServer(0, 'http://127.0.0.1:1');
    const internals = server as unknown as {
      sessions: Map<string, unknown>;
      badgeBySession: Map<string, string>;
      touchLiveDisplay: (id: string, force?: boolean) => void;
    };
    internals.sessions.set('s1', { transport: {}, server: {} });
    internals.badgeBySession.set('s1', 'fox');
    const liveDisplayPosts: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string }) => {
      const target = String(url);
      if (target.endsWith('/touch')) {
        return { ok: true, json: async () => ({ success: true }) };
      }
      if (target.endsWith('/api/scope/live-display') && (init?.method ?? 'GET') === 'POST') {
        liveDisplayPosts.push(target);
      }
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    });
    try {
      internals.touchLiveDisplay('s1', true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(liveDisplayPosts).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keep-alive timer touches open sessions and stops with the server (no sockets)', async () => {
    vi.useFakeTimers();
    const previous = process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR];
    process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR] = '1000';
    try {
      const server = new AgentDeckMCPServer(0, 'http://127.0.0.1:1');
      const internals = server as unknown as {
        sessions: Map<string, unknown>;
        badgeBySession: Map<string, string>;
        startLiveDisplayKeepAlive: () => void;
        stopLiveDisplayKeepAlive: () => void;
      };
      internals.sessions.set('s1', { transport: {}, server: {} });
      internals.badgeBySession.set('s1', 'fox');
      const touched: string[] = [];
      vi.stubGlobal('fetch', async (url: unknown) => {
        touched.push(String(url));
        return { ok: true, json: async () => ({ success: true, data: {} }) };
      });

      internals.startLiveDisplayKeepAlive();
      await vi.advanceTimersByTimeAsync(3500);
      expect(touched.filter((url) => url.endsWith('/touch')).length).toBeGreaterThanOrEqual(3);

      internals.stopLiveDisplayKeepAlive();
      const frozen = touched.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(touched.length).toBe(frozen);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      if (previous === undefined) {
        delete process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR];
      } else {
        process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR] = previous;
      }
    }
  });

  it('skips heartbeat-capable sessions but keeps touching legacy ones', async () => {
    // NOT-191: the server-owned keep-alive is compatibility behavior for
    // legacy/unknown clients only. A capable bridge owns the pulse, so a
    // server touch for it would defeat the stale sweep after an abandon.
    const stub = await startStubBackend();
    const previous = process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR];
    process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR] = '50';
    const server = new AgentDeckMCPServer(0, `http://127.0.0.1:${stub.port}`);
    const consoleCapture = installStrictConsoleCapture();
    await server.start();
    try {
      const port = server.getPort();
      await waitForMcpHealth(port);

      const legacyInit = await postInitialize(port, 310);
      const legacyId = legacyInit.headers.get('mcp-session-id')!;
      await callTool(port, legacyId, 'bind_workspace', {
        workspaceRoot: '/tmp/keepalive-legacy',
        deckId: STUB_DECK_ID,
      }, 311);

      const capableInit = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: MCP_ACCEPT,
          [AGENT_DECK_BRIDGE_LIVENESS_HEADER]: AGENT_DECK_BRIDGE_LIVENESS_V1,
        },
        body: JSON.stringify(initializePayload(320)),
      });
      expect(capableInit.status).toBe(200);
      const capableId = capableInit.headers.get('mcp-session-id')!;
      await callTool(port, capableId, 'bind_workspace', {
        workspaceRoot: '/tmp/keepalive-capable',
        deckId: STUB_DECK_ID,
      }, 321);

      // Let the keep-alive fire several times with no further tool calls.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const touches = [...stub.touches];
      expect(touches.some((url) => url.includes(encodeURIComponent(legacyId)))).toBe(true);
      expect(touches.some((url) => url.includes(encodeURIComponent(capableId)))).toBe(false);

      // ...while a client pulse on the capable session still refreshes it.
      const before = stub.touches.length;
      await callTool(port, capableId, 'get_session_binding', {}, 322);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stub.touches.length).toBeGreaterThan(before);
      expect(stub.touches.some((url) => url.includes(encodeURIComponent(capableId)))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR];
      } else {
        process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR] = previous;
      }
      await server.stop();
      await stub.close();
      expect(stub.unhandled, `Unhandled stub routes: ${stub.unhandled.join(', ')}`).toEqual([]);
      consoleCapture.restore();
      consoleCapture.assertClean();
    }
  });

  it('an idle but connected session keeps touching with no tool calls', async () => {
    const stub = await startStubBackend();
    const previous = process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR];
    process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR] = '50';
    const server = new AgentDeckMCPServer(0, `http://127.0.0.1:${stub.port}`);
    const consoleCapture = installStrictConsoleCapture();
    await server.start();
    try {
      const port = server.getPort();
      await waitForMcpHealth(port);
      const init = await postInitialize(port, 300);
      const sessionId = init.headers.get('mcp-session-id')!;
      await callTool(port, sessionId, 'bind_workspace', {
        workspaceRoot: '/tmp/keepalive-repo',
        deckId: STUB_DECK_ID,
      }, 301);

      // No further tool calls: the keep-alive alone must prove life.
      const before = stub.touches.length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(stub.touches.length).toBeGreaterThan(before);
    } finally {
      if (previous === undefined) {
        delete process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR];
      } else {
        process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR] = previous;
      }
      await server.stop();
      await stub.close();
      expect(stub.unhandled, `Unhandled stub routes: ${stub.unhandled.join(', ')}`).toEqual([]);
      consoleCapture.restore();
      consoleCapture.assertClean();
    }
  });
});

type LifecycleInternals = {
  sessions: Map<string, { transport: { close: () => Promise<void>; handleRequest?: (...args: unknown[]) => Promise<void> } }>;
  sessionBinding: McpSessionBindingStore;
  badgeBySession: Map<string, string>;
  lastTouchAtMs: Map<string, number>;
  lastClientActivityAtMs: Map<string, number>;
  heartbeatCapableSessions: Set<string>;
  inFlightRequests: Map<string, number>;
  pendingSessionClose: Set<string>;
  cleanupTasks: Map<string, Promise<boolean>>;
  closedSessionIds: Set<string>;
  unregisterPeak: number;
  noteClientActivity: (id: string, req: { headers: Record<string, string> }) => void;
  touchAllLiveDisplays: () => void;
  sweepIdleTransports: () => Promise<void>;
  startCleanupSession: (id: string, opts: { closeTransport: boolean }) => Promise<boolean>;
  handleTransportPost: (id: string, req: unknown, res: unknown) => Promise<void>;
  handleMcpSessionRequest: (req: unknown, res: unknown) => Promise<void>;
  httpServer: { listening: boolean } | null;
};

type RecordedBackendCall = { url: string; method: string; body?: string };

function fakeTransport(extra?: {
  close?: () => Promise<void>;
  handleRequest?: (...args: unknown[]) => Promise<void>;
}) {
  return {
    close: extra?.close ?? (async () => {}),
    ...(extra?.handleRequest ? { handleRequest: extra.handleRequest } : {}),
  };
}

function lifecycleServer(clock: { now: number }, options?: { ttlMs?: number }) {
  const server = new AgentDeckMCPServer(0, 'http://127.0.0.1:1', undefined, '127.0.0.1', {
    now: () => clock.now,
    transportIdleTtlMs: options?.ttlMs ?? 1_000,
    transportSweepIntervalMs: 0,
    unregisterTimeoutMs: 50,
    liveTouchKeepAliveMs: 0,
  });
  return { server, internals: server as unknown as LifecycleInternals };
}

function okBackend(calls: RecordedBackendCall[]) {
  return async (url: unknown, init?: { method?: string; body?: unknown }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string });
    return { ok: true, json: async () => ({ success: true, data: {} }) };
  };
}

async function waitForGone(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for session cleanup');
}

describe('transport session lifecycle without sockets (NOT-191)', () => {
  it('pins the lifecycle defaults: 24h TTL, 60s sweep, 8 concurrent unregisters', () => {
    expect(DEFAULT_TRANSPORT_IDLE_TTL_MS).toBe(24 * 60 * 60_000);
    expect(DEFAULT_TRANSPORT_SWEEP_INTERVAL_MS).toBe(60_000);
    expect(DEFAULT_UNREGISTER_CONCURRENCY).toBe(8);
  });

  it('keeps a session at TTL - 1ms and removes it at the TTL', async () => {
    const clock = { now: 1_000_000 };
    const { internals } = lifecycleServer(clock, { ttlMs: DEFAULT_TRANSPORT_IDLE_TTL_MS });
    const calls: RecordedBackendCall[] = [];
    vi.stubGlobal('fetch', okBackend(calls));
    try {
      internals.sessions.set('s1', { transport: fakeTransport() });
      internals.lastClientActivityAtMs.set('s1', clock.now);

      clock.now += DEFAULT_TRANSPORT_IDLE_TTL_MS - 1;
      await internals.sweepIdleTransports();
      expect(internals.sessions.has('s1')).toBe(true);

      clock.now += 1;
      await internals.sweepIdleTransports();
      expect(internals.sessions.has('s1')).toBe(false);
      expect(internals.closedSessionIds.has('s1')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('server-generated legacy touches never reset transport activity', async () => {
    const clock = { now: 2_000_000 };
    const { internals } = lifecycleServer(clock, { ttlMs: 1_000 });
    const calls: RecordedBackendCall[] = [];
    vi.stubGlobal('fetch', okBackend(calls));
    try {
      internals.sessions.set('legacy', { transport: fakeTransport() });
      internals.badgeBySession.set('legacy', 'fox');
      internals.lastClientActivityAtMs.set('legacy', clock.now);

      // Compatibility touches keep firing for the legacy session...
      clock.now += 500;
      internals.touchAllLiveDisplays();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls.some((call) => call.url.includes('/touch'))).toBe(true);
      // ...but transport activity still reads the last real client traffic.
      expect(internals.lastClientActivityAtMs.get('legacy')).toBe(2_000_000);

      // So the TTL reclaims it on schedule despite the touches.
      clock.now += 600;
      await internals.sweepIdleTransports();
      expect(internals.sessions.has('legacy')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a capable-bridge pulse resets transport activity and skips server touches', async () => {
    const clock = { now: 3_000_000 };
    const { internals } = lifecycleServer(clock, { ttlMs: 1_000 });
    const calls: RecordedBackendCall[] = [];
    vi.stubGlobal('fetch', okBackend(calls));
    try {
      internals.sessions.set('capable', { transport: fakeTransport() });
      internals.sessions.set('legacy', { transport: fakeTransport() });
      internals.badgeBySession.set('capable', 'fox');
      internals.badgeBySession.set('legacy', 'owl');
      internals.lastClientActivityAtMs.set('capable', clock.now);
      internals.lastClientActivityAtMs.set('legacy', clock.now);

      // The capability marker on any client request adopts the session.
      internals.noteClientActivity('capable', {
        headers: { [AGENT_DECK_BRIDGE_LIVENESS_HEADER]: AGENT_DECK_BRIDGE_LIVENESS_V1 },
      });
      expect(internals.heartbeatCapableSessions.has('capable')).toBe(true);

      internals.touchAllLiveDisplays();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const touched = calls.filter((call) => call.url.includes('/touch')).map((call) => call.url);
      expect(touched.some((url) => url.includes('legacy'))).toBe(true);
      expect(touched.some((url) => url.includes('capable'))).toBe(false);

      // A later pulse moves transport activity forward; the legacy session
      // expires on its original activity while the capable one survives.
      clock.now += 900;
      internals.noteClientActivity('capable', {
        headers: { [AGENT_DECK_BRIDGE_LIVENESS_HEADER]: AGENT_DECK_BRIDGE_LIVENESS_V1 },
      });
      clock.now += 200;
      await internals.sweepIdleTransports();
      expect(internals.sessions.has('capable')).toBe(true);
      expect(internals.sessions.has('legacy')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('an in-flight host request blocks TTL expiry until it completes', async () => {
    const clock = { now: 4_000_000 };
    const { internals } = lifecycleServer(clock, { ttlMs: 1_000 });
    const calls: RecordedBackendCall[] = [];
    vi.stubGlobal('fetch', okBackend(calls));
    try {
      let releaseTool: () => void = () => {};
      const toolGate = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      internals.sessions.set(
        's1',
        {
          transport: fakeTransport({
            handleRequest: async () => {
              await toolGate;
            },
          }),
        },
      );
      internals.lastClientActivityAtMs.set('s1', clock.now);

      const inFlight = internals.handleTransportPost('s1', {}, {});
      clock.now += 5_000;
      await internals.sweepIdleTransports();
      expect(internals.sessions.has('s1')).toBe(true);

      releaseTool();
      await inFlight;
      await internals.sweepIdleTransports();
      expect(internals.sessions.has('s1')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a DELETE during an in-flight request defers until the request lands', async () => {
    const previousSkip = process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = '1';
    const clock = { now: 5_000_000 };
    const { internals } = lifecycleServer(clock, { ttlMs: 60_000 });
    const calls: RecordedBackendCall[] = [];
    vi.stubGlobal('fetch', okBackend(calls));
    try {
      let releaseTool: () => void = () => {};
      const toolGate = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      const closed: string[] = [];
      internals.sessions.set(
        's1',
        {
          transport: fakeTransport({
            handleRequest: async () => {
              await toolGate;
            },
            close: async () => {
              closed.push('s1');
            },
          }),
        },
      );
      internals.lastClientActivityAtMs.set('s1', clock.now);

      const inFlight = internals.handleTransportPost('s1', {}, {});
      let statusCode = 0;
      await internals.handleMcpSessionRequest(
        { method: 'DELETE', headers: { 'mcp-session-id': 's1' } },
        { status: (code: number) => ((statusCode = code), { end: () => {}, json: () => {}, send: () => {} }) },
      );
      expect(statusCode).toBe(200);
      expect(internals.pendingSessionClose.has('s1')).toBe(true);
      expect(internals.sessions.has('s1')).toBe(true);

      // The deferred close runs as soon as the last request lands — no sweep needed.
      releaseTool();
      await inFlight;
      await waitForGone(() => !internals.sessions.has('s1'));
      expect(closed).toEqual(['s1']);
    } finally {
      vi.unstubAllGlobals();
      if (previousSkip === undefined) {
        delete process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
      } else {
        process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = previousSkip;
      }
    }
  });

  it('cleanup removes every session-owned registry entry exactly once', async () => {
    const clock = { now: 6_000_000 };
    const { internals } = lifecycleServer(clock);
    const calls: RecordedBackendCall[] = [];
    vi.stubGlobal('fetch', okBackend(calls));
    try {
      let closes = 0;
      internals.sessions.set('s1', { transport: fakeTransport({ close: async () => { closes += 1; } }) });
      internals.sessionBinding.setGrantSession('s1', {
        grantId: 'grant-1',
        label: 'label',
        defaultDeck: 'deck-1',
        allowedDecks: ['deck-1'],
        runtimeSessionId: 'runtime-1',
        deckId: 'deck-1',
        workspaceRoot: '/tmp/repo',
        mode: 'normal',
      });
      internals.badgeBySession.set('s1', 'fox');
      internals.lastTouchAtMs.set('s1', clock.now);
      internals.lastClientActivityAtMs.set('s1', clock.now);
      internals.heartbeatCapableSessions.add('s1');

      // A sweep racing `transport.onclose` joins the same run — one close,
      // one unregister, one runtime disconnect.
      const [first, second] = await Promise.all([
        internals.startCleanupSession('s1', { closeTransport: true }),
        internals.startCleanupSession('s1', { closeTransport: false }),
      ]);
      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(closes).toBe(1);

      expect(internals.sessions.has('s1')).toBe(false);
      expect(internals.badgeBySession.has('s1')).toBe(false);
      expect(internals.lastTouchAtMs.has('s1')).toBe(false);
      expect(internals.lastClientActivityAtMs.has('s1')).toBe(false);
      expect(internals.heartbeatCapableSessions.has('s1')).toBe(false);
      expect(internals.sessionBinding.getBinding('s1').runtimeSessionId).toBeUndefined();
      expect(internals.sessionBinding.getGrantScope('s1')).toBeUndefined();
      expect(internals.sessionBinding.isGrantSession('s1')).toBe(false);

      const disconnects = calls.filter((call) =>
        call.url.endsWith('/api/trusted-session/mcp/disconnect-deck'),
      );
      expect(disconnects).toHaveLength(1);
      expect(disconnects[0].body).toContain('s1');
      const unregisters = calls.filter(
        (call) => call.method === 'DELETE' && call.url.includes('/api/scope/live-display/s1'),
      );
      expect(unregisters).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a 100-session sweep never exceeds eight concurrent unregisters', async () => {
    const clock = { now: 7_000_000 };
    const { internals } = lifecycleServer(clock, { ttlMs: 1_000 });
    let active = 0;
    let peak = 0;
    vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string }) => {
      if (String(url).includes('/api/scope/live-display/') && (init?.method ?? 'GET') === 'DELETE') {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    });
    try {
      for (let index = 0; index < 100; index += 1) {
        const id = `sweep-${index}`;
        internals.sessions.set(id, { transport: fakeTransport() });
        internals.lastClientActivityAtMs.set(id, clock.now);
      }
      clock.now += 60_000;
      await internals.sweepIdleTransports();
      expect(internals.sessions.size).toBe(0);
      expect(peak).toBeLessThanOrEqual(8);
      expect(peak).toBeGreaterThan(1);
      expect(internals.unregisterPeak).toBeLessThanOrEqual(8);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('failing unregisters collapse into one attempted/succeeded/failed summary', async () => {
    const clock = { now: 8_000_000 };
    const { server, internals } = lifecycleServer(clock, { ttlMs: 1_000 });
    vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string }) => {
      if (String(url).includes('/api/scope/live-display/') && (init?.method ?? 'GET') === 'DELETE') {
        return { ok: false, json: async () => ({}) as never, text: async () => 'nope' };
      }
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    });
    const warnings: string[] = [];
    const errors: unknown[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        const id = `fail-${index}`;
        internals.sessions.set(id, { transport: fakeTransport() });
        internals.lastClientActivityAtMs.set(id, clock.now);
      }
      clock.now += 60_000;
      await internals.sweepIdleTransports();
      expect(internals.sessions.size).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('transport-sweep');
      expect(warnings[0]).toContain('attempted=5');
      expect(warnings[0]).toContain('succeeded=0');
      expect(warnings[0]).toContain('failed=5');
      // Quiet teardown: no per-session stack traces through console.error.
      expect(errors).toHaveLength(0);
      expect(server).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('stop() without a listener still cleans sessions and reports one summary', async () => {
    const clock = { now: 9_000_000 };
    const { server, internals } = lifecycleServer(clock, { ttlMs: 1_000 });
    vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string }) => {
      if (String(url).includes('/api/scope/live-display/') && (init?.method ?? 'GET') === 'DELETE') {
        return { ok: false, json: async () => ({}) as never, text: async () => 'nope' };
      }
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    });
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (let index = 0; index < 3; index += 1) {
        const id = `stop-${index}`;
        internals.sessions.set(id, { transport: fakeTransport() });
        internals.lastClientActivityAtMs.set(id, clock.now);
      }
      await server.stop();
      expect(internals.sessions.size).toBe(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('server-shutdown');
      expect(warnings[0]).toContain('attempted=3');
    } finally {
      vi.unstubAllGlobals();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('stop() with a live listener bounds shutdown unregisters and releases the port', async () => {
    const clock = { now: 10_000_000 };
    const server = new AgentDeckMCPServer(0, 'http://127.0.0.1:1', undefined, '127.0.0.1', {
      now: () => clock.now,
      transportIdleTtlMs: 1_000,
      transportSweepIntervalMs: 0,
      unregisterTimeoutMs: 5_000,
      liveTouchKeepAliveMs: 0,
    });
    const internals = server as unknown as LifecycleInternals;
    let active = 0;
    let peak = 0;
    vi.stubGlobal('fetch', async (url: unknown, init?: { method?: string }) => {
      if (String(url).includes('/api/scope/live-display/') && (init?.method ?? 'GET') === 'DELETE') {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    });
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await server.start();
      const port = server.getPort();
      expect(port).toBeGreaterThan(0);
      const listener = internals.httpServer;
      expect(listener?.listening).toBe(true);

      // More sessions than the bound, so the shutdown path must serialize —
      // the same peak-concurrency evidence the sweep test records.
      for (let index = 0; index < 12; index += 1) {
        const id = `shutdown-${index}`;
        internals.sessions.set(id, { transport: fakeTransport() });
        internals.lastClientActivityAtMs.set(id, clock.now);
      }
      await server.stop();
      expect(internals.sessions.size).toBe(0);
      expect(peak).toBeLessThanOrEqual(8);
      expect(peak).toBeGreaterThan(1);
      expect(internals.unregisterPeak).toBeLessThanOrEqual(8);
      expect(warnings).toHaveLength(0);

      // The listener is closed and detached. Rebinding the same ephemeral port
      // is not asserted: a parallel test file may legitimately claim it first.
      expect(listener?.listening).toBe(false);
      expect(internals.httpServer).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      warnSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('pinned playbook version over MCP (NOT-537)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  let mcpServer: AgentDeckMCPServer | undefined;
  let previousSkipDeckHeader: string | undefined;
  let previousSkipAdmin: string | undefined;
  let previousStubSync: string | undefined;

  beforeEach(() => {
    previousSkipDeckHeader = process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    previousSkipAdmin = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    previousStubSync = process.env.AGENT_DECK_STUB_SYNC;
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = '0';
    process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = '0';
    delete process.env.AGENT_DECK_STUB_SYNC;
  });

  afterEach(async () => {
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = undefined;
    }
    while (servers.length) {
      await servers.pop()?.close();
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
  });

  async function buildListeningBackend() {
    const db = new DatabaseManager(':memory:');
    const deck = await db.createDeck({ name: 'eval' });

    const playbook = await db.createPlaybook({
      id: 'pb_baseline',
      title: 'current title',
      body: '## Gotchas\n- Current lesson.\n',
      triggers: ['current trigger'],
    });
    await db.addPlaybookToDeck({ deckId: deck.id, playbookId: playbook.id, position: 0 });
    const other = await db.createPlaybook({
      id: 'pb_other',
      title: 'other title',
      body: '## Gotchas\n- Other lesson.\n',
      triggers: ['other trigger'],
    });
    await db.addPlaybookToDeck({ deckId: deck.id, playbookId: other.id, position: 0 });

    const older = await db.createPlaybookVersion({
      id: generateId(),
      playbookId: playbook.id,
      title: 'older title',
      body: '## Gotchas\n- Older lesson.\n',
      triggers: ['older trigger'],
      patchId: null,
      actor: 'agent',
    });
    const newer = await db.createPlaybookVersion({
      id: generateId(),
      playbookId: playbook.id,
      title: 'current title',
      body: '## Gotchas\n- Current lesson.\n',
      triggers: ['current trigger'],
      patchId: null,
      actor: 'agent',
    });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const playbookManager = new PlaybookManager(db);
    const patchManager = new PatchManager(db, playbookManager);
    // One open lesson on the live playbook: the pinned session must not see it.
    await patchManager.propose(
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: '- Later lesson.' }],
        rationale: 'seeded open patch',
      },
      'ide',
      null,
      deck.id,
    );

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('credentialManager', {
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    fastify.decorate('playbookManager', playbookManager);
    fastify.decorate('patchManager', patchManager);

    registerHttpPolicyHook(fastify);
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.register(registerPlaybookPatchRoutes, { prefix: '/api/playbook-patches' });
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
      deck,
      playbook,
      other,
      older,
      newer,
    };
  }

  function headersFor(deckId: string, pin?: string) {
    return {
      [AGENT_DECK_DECK_ID_HEADER]: deckId,
      ...(pin ? { [AGENT_DECK_PLAYBOOK_PIN_HEADER]: pin } : {}),
    };
  }

  it('returns the pinned version in a pinned session and the live body otherwise', async () => {
    const { backendUrl, deck, playbook, other, older } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const pin = `${playbook.id}=${older.id}`;
    const pinnedHeaders = headersFor(deck.id, pin);
    const pinnedSession = await openSession(started.port, 1, pinnedHeaders);

    const pinned = await callToolMcpResult(
      started.port,
      pinnedSession,
      'get_playbook',
      { playbook_id: playbook.id },
      2,
      pinnedHeaders,
    );
    expect(pinned.isError).toBe(false);
    expect(pinned.data).toMatchObject({
      id: playbook.id,
      title: 'older title',
      body: '## Gotchas\n- Older lesson.\n',
      triggers: ['older trigger'],
      openPatches: [],
      pinnedVersionId: older.id,
    });

    // Any other id in the same pinned session is unchanged.
    const untouched = await callToolMcpResult(
      started.port,
      pinnedSession,
      'get_playbook',
      { playbook_id: other.id },
      3,
      pinnedHeaders,
    );
    expect(untouched.isError).toBe(false);
    expect(untouched.data).toMatchObject({ id: other.id, title: 'other title' });
    expect(untouched.data).not.toHaveProperty('pinnedVersionId');

    // A run without the flag sees the live body and its real openPatches.
    const plainHeaders = headersFor(deck.id);
    const plainSession = await openSession(started.port, 10, plainHeaders);
    const current = await callToolMcpResult(
      started.port,
      plainSession,
      'get_playbook',
      { playbook_id: playbook.id },
      11,
      plainHeaders,
    );
    expect(current.isError).toBe(false);
    expect(current.data).toMatchObject({
      id: playbook.id,
      title: 'current title',
      body: '## Gotchas\n- Current lesson.\n',
    });
    expect(current.data).not.toHaveProperty('pinnedVersionId');
    expect((current.data.openPatches as unknown[]).length).toBe(1);
  });

  it('keeps the first adopted pin when later headers change', async () => {
    const { backendUrl, deck, playbook, older, newer } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const pinnedHeaders = headersFor(deck.id, `${playbook.id}=${older.id}`);
    const sessionId = await openSession(started.port, 1, pinnedHeaders);

    // A later request carrying a different pin must not move the session.
    const movedHeaders = headersFor(deck.id, `${playbook.id}=${newer.id}`);
    const still = await callToolMcpResult(
      started.port,
      sessionId,
      'get_playbook',
      { playbook_id: playbook.id },
      2,
      movedHeaders,
    );
    expect(still.isError).toBe(false);
    expect(still.data).toMatchObject({ body: '## Gotchas\n- Older lesson.\n', pinnedVersionId: older.id });
  });

  it('shows the pinned title and triggers in session summaries', async () => {
    const { backendUrl, deck, playbook, older } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const pinnedHeaders = headersFor(deck.id, `${playbook.id}=${older.id}`);
    const sessionId = await openSession(started.port, 1, pinnedHeaders);

    const context = await callToolMcpResult(started.port, sessionId, 'get_session_context', {}, 2, pinnedHeaders);
    expect(context.isError).toBe(false);
    const summaries = context.data.playbooks as Array<{ id: string; title: string; triggers: string[] }>;
    expect(summaries.find((entry) => entry.id === playbook.id)).toEqual({
      id: playbook.id,
      title: 'older title',
      triggers: ['older trigger'],
    });

    const bound = await callToolMcpResult(started.port, sessionId, 'get_bound_deck', {}, 3, pinnedHeaders);
    expect(bound.isError).toBe(false);
    const deckPlaybooks = bound.data.playbooks as Array<{ id: string; title: string; triggers: string[] }>;
    expect(deckPlaybooks.find((entry) => entry.id === playbook.id)).toMatchObject({
      id: playbook.id,
      title: 'older title',
      triggers: ['older trigger'],
    });
  });

  it('blocks proposals in a pinned session and files them unpinned', async () => {
    const { backendUrl, db, deck, playbook, older } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const pinnedHeaders = headersFor(deck.id, `${playbook.id}=${older.id}`);
    const pinnedSession = await openSession(started.port, 1, pinnedHeaders);

    const patchesBefore = await db.listPlaybookPatches();
    const signalsBefore = await db.listFeedbackSignals();
    const blocked = await callToolMcpResult(
      started.port,
      pinnedSession,
      'propose_playbook_patch',
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: '- Pinned lesson.' }],
        rationale: 'an evaluation run must not file this',
      },
      2,
      pinnedHeaders,
    );
    expect(blocked.isError).toBe(true);
    expect(String(blocked.data.error)).toContain(`pinned to ${playbook.id}=${older.id}`);
    expect(await db.listPlaybookPatches()).toHaveLength(patchesBefore.length);
    expect(await db.listFeedbackSignals()).toHaveLength(signalsBefore.length);

    const plainHeaders = headersFor(deck.id);
    const plainSession = await openSession(started.port, 10, plainHeaders);
    const filed = await callToolMcpResult(
      started.port,
      plainSession,
      'propose_playbook_patch',
      {
        kind: 'update',
        playbook_id: playbook.id,
        ops: [{ op: 'add_item', section: 'Gotchas', text: '- Unpinned lesson.' }],
        rationale: 'a normal session files this',
      },
      11,
      plainHeaders,
    );
    expect(filed.isError).toBe(false);
    expect(await db.listPlaybookPatches()).toHaveLength(patchesBefore.length + 1);
    expect(await db.listFeedbackSignals()).toHaveLength(signalsBefore.length + 1);
  });

  it('never modifies the live playbook, and later sessions see the live body', async () => {
    const { backendUrl, db, deck, playbook, older } = await buildListeningBackend();
    const started = await startMcpServer(backendUrl, 'standard');
    mcpServer = started.server;

    const before = (await db.getPlaybook(playbook.id))?.body;
    const pinnedHeaders = headersFor(deck.id, `${playbook.id}=${older.id}`);
    const pinnedSession = await openSession(started.port, 1, pinnedHeaders);
    const pinned = await callToolMcpResult(
      started.port,
      pinnedSession,
      'get_playbook',
      { playbook_id: playbook.id },
      2,
      pinnedHeaders,
    );
    expect(pinned.isError).toBe(false);
    expect((await db.getPlaybook(playbook.id))?.body).toBe(before);

    const plainHeaders = headersFor(deck.id);
    const freshSession = await openSession(started.port, 10, plainHeaders);
    const current = await callToolMcpResult(
      started.port,
      freshSession,
      'get_playbook',
      { playbook_id: playbook.id },
      11,
      plainHeaders,
    );
    expect(current.isError).toBe(false);
    expect(current.data).toMatchObject({ body: before });
    expect(current.data).not.toHaveProperty('pinnedVersionId');
  });
});

describe('folder-assignment deck binding (NOT-562)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  const workspaces: string[] = [];
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
    // NOT-604: an ambient user default must not steer these folder-only cases.
    process.env.AGENT_DECK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'not562-nohome-'));
    workspaces.push(process.env.AGENT_DECK_HOME);
  });

  afterEach(async () => {
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = undefined;
    }
    while (servers.length) {
      await servers.pop()?.close();
    }
    while (workspaces.length) {
      fs.rmSync(workspaces.pop()!, { recursive: true, force: true });
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

  async function buildListeningBackend() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'alpha' });
    const deckB = await db.createDeck({ name: 'beta' });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const playbookManager = new PlaybookManager(db);

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('credentialManager', {
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    fastify.decorate('playbookManager', playbookManager);

    registerHttpPolicyHook(fastify);
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
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
    };
  }

  async function setup() {
    const backend = await buildListeningBackend();
    const started = await startMcpServer(backend.backendUrl, 'standard');
    mcpServer = started.server;
    return { ...backend, port: started.port };
  }

  function writeAssignment(dir: string, deckId: string, deckName: string): void {
    fs.mkdirSync(path.join(dir, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agent-deck', 'use.json'),
      JSON.stringify({ version: 3, deckId, deckName }),
    );
  }

  function makeWorkspace(assignment?: { deckId: string; deckName: string } | 'corrupt'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not562-'));
    workspaces.push(dir);
    if (assignment === 'corrupt') {
      fs.mkdirSync(path.join(dir, '.agent-deck'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.agent-deck', 'use.json'), '{not json');
    } else if (assignment) {
      writeAssignment(dir, assignment.deckId, assignment.deckName);
    }
    return dir;
  }

  function workspaceHeaders(dir: string, deckId?: string): Record<string, string> {
    return {
      [AGENT_DECK_WORKSPACE_HEADER]: dir,
      ...(deckId ? { [AGENT_DECK_DECK_ID_HEADER]: deckId } : {}),
    };
  }

  async function postInitializeWithHeaders(
    port: number,
    headers: Record<string, string>,
    id: number,
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        ...headers,
      },
      body: JSON.stringify(initializePayload(id)),
    });
  }

  async function listToolNames(
    port: number,
    sessionId: string,
    headers: Record<string, string>,
    id: number,
  ): Promise<string[]> {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': sessionId,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    return (body.result?.tools ?? []).map((tool) => tool.name);
  }

  function runtimeSessionCount(db: DatabaseManager): number {
    const row = db
      .getSqliteDatabase()
      .prepare('SELECT COUNT(*) AS n FROM runtime_sessions')
      .get() as { n: number };
    return row.n;
  }

  it('binds a workspace-header-only session to the use.json deck', async () => {
    const { deckA, port } = await setup();
    const dir = makeWorkspace({ deckId: deckA.id, deckName: deckA.name });
    const headers = workspaceHeaders(dir);

    const sessionId = await openSession(port, 1, headers);
    const context = await callToolMcpResult(port, sessionId, 'get_session_context', {}, 2, headers);
    expect(context.isError).toBe(false);
    expect(context.data.effective_deck_name).toBe('alpha');
    expect(String(context.data.display_summary)).toContain('alpha');

    const names = await listToolNames(port, sessionId, headers, 3);
    expect(names).toContain('get_bound_deck');
    expect(names.length).toBeGreaterThan(2);
  });

  it('stays unassigned when the folder has no use.json', async () => {
    const { port } = await setup();
    const headers = workspaceHeaders(makeWorkspace());

    const init = await postInitializeWithHeaders(port, headers, 1);
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await init.arrayBuffer();

    const names = await listToolNames(port, sessionId!, headers, 2);
    expect(names.sort()).toEqual([
      'get_session_binding',
      'get_session_context',
      'request_deck_assignment',
    ]);
    const context = await callToolMcpResult(port, sessionId!, 'get_session_context', {}, 3, headers);
    expect(context.isError).toBe(true);
    expect(context.data.error_code).toBe('GRANT_REQUIRED');
  });

  it('stays unassigned when use.json is corrupt', async () => {
    const { port } = await setup();
    const headers = workspaceHeaders(makeWorkspace('corrupt'));

    const init = await postInitializeWithHeaders(port, headers, 1);
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await init.arrayBuffer();

    const names = await listToolNames(port, sessionId!, headers, 2);
    expect(names.sort()).toEqual([
      'get_session_binding',
      'get_session_context',
      'request_deck_assignment',
    ]);
    const context = await callToolMcpResult(port, sessionId!, 'get_session_context', {}, 3, headers);
    expect(context.isError).toBe(true);
    expect(context.data.error_code).toBe('GRANT_REQUIRED');
  });

  it('stays unassigned when use.json names a deleted deck', async () => {
    const { db, port } = await setup();
    const headers = workspaceHeaders(
      makeWorkspace({ deckId: '99999999-9999-4999-8999-999999999999', deckName: 'gone' }),
    );

    const init = await postInitializeWithHeaders(port, headers, 1);
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await init.arrayBuffer();

    const names = await listToolNames(port, sessionId!, headers, 2);
    expect(names.sort()).toEqual([
      'get_session_binding',
      'get_session_context',
      'request_deck_assignment',
    ]);
    const context = await callToolMcpResult(port, sessionId!, 'get_session_context', {}, 3, headers);
    expect(context.isError).toBe(true);
    expect(context.data.error_code).toBe('GRANT_REQUIRED');
    // NOT-604: with no default deck to fall through to, the reply names the missing deck.
    expect(String(context.data.message ?? '')).toContain('gone');
    // The failed bind leaves no partial runtime session behind.
    expect(runtimeSessionCount(db)).toBe(0);
  });

  it('prefers an explicit deck header over use.json', async () => {
    const { deckA, deckB, port } = await setup();
    const dir = makeWorkspace({ deckId: deckA.id, deckName: deckA.name });
    const headers = workspaceHeaders(dir, deckB.id);

    const sessionId = await openSession(port, 1, headers);
    const context = await callToolMcpResult(port, sessionId, 'get_session_context', {}, 2, headers);
    expect(context.isError).toBe(false);
    expect(context.data.effective_deck_name).toBe('beta');
  });

  it('answers a session-less server/discover without breaking the following initialize', async () => {
    const { deckA, port } = await setup();
    const dir = makeWorkspace({ deckId: deckA.id, deckName: deckA.name });
    const headers = workspaceHeaders(dir);

    const probe = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
    });
    // Non-fatal: the existing no-session JSON-RPC answer, no session issued.
    expect(probe.status).toBe(400);
    expect(probe.headers.get('mcp-session-id')).toBeNull();
    const probeBody = (await probe.json()) as { jsonrpc?: string; error?: unknown };
    expect(probeBody.jsonrpc).toBe('2.0');
    expect(probeBody.error).toBeTruthy();

    const sessionId = await openSession(port, 2, headers);
    const context = await callToolMcpResult(port, sessionId, 'get_session_context', {}, 3, headers);
    expect(context.isError).toBe(false);
    expect(context.data.effective_deck_name).toBe('alpha');
  });

  it('serves two parallel initializes as independent bound sessions', async () => {
    const { deckA, port } = await setup();
    const dir = makeWorkspace({ deckId: deckA.id, deckName: deckA.name });
    const headers = workspaceHeaders(dir);

    const [first, second] = await Promise.all([
      postInitializeWithHeaders(port, headers, 1),
      postInitializeWithHeaders(port, headers, 2),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const sessionOne = first.headers.get('mcp-session-id');
    const sessionTwo = second.headers.get('mcp-session-id');
    expect(sessionOne).toBeTruthy();
    expect(sessionTwo).toBeTruthy();
    expect(sessionTwo).not.toBe(sessionOne);
    await Promise.all([first.arrayBuffer(), second.arrayBuffer()]);

    for (const [sessionId, id] of [[sessionOne!, 3], [sessionTwo!, 4]] as const) {
      const context = await callToolMcpResult(
        port,
        sessionId,
        'get_session_context',
        {},
        id,
        headers,
      );
      expect(context.isError).toBe(false);
      expect(context.data.effective_deck_name).toBe('alpha');
    }
  });

  it('picks up a use.json edit on the next session, not the current one', async () => {
    const { deckA, deckB, port } = await setup();
    const dir = makeWorkspace({ deckId: deckA.id, deckName: deckA.name });
    const headers = workspaceHeaders(dir);

    const sessionId = await openSession(port, 1, headers);
    const before = await callToolMcpResult(port, sessionId, 'get_session_context', {}, 2, headers);
    expect(before.isError).toBe(false);
    expect(before.data.effective_deck_name).toBe('alpha');

    writeAssignment(dir, deckB.id, deckB.name);

    // Sticky for the session lifetime (NOT-108 mirror): the live session
    // keeps serving its bound deck after the edit.
    const sticky = await callToolMcpResult(port, sessionId, 'get_session_context', {}, 3, headers);
    expect(sticky.isError).toBe(false);
    expect(sticky.data.effective_deck_name).toBe('alpha');

    // The edit takes effect when the client re-initializes.
    const fresh = await openSession(port, 10, headers);
    const after = await callToolMcpResult(port, fresh, 'get_session_context', {}, 11, headers);
    expect(after.isError).toBe(false);
    expect(after.data.effective_deck_name).toBe('beta');
  });
});

describe('stale session recovery (NOT-569)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  const workspaces: string[] = [];
  const dbs: Database.Database[] = [];
  let mcpServer: AgentDeckMCPServer | undefined;
  let previousSkipDeckHeader: string | undefined;
  let previousSkipAdmin: string | undefined;
  let previousStubSync: string | undefined;
  let previousBearerFlag: string | undefined;
  let previousHostedFlag: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousSkipDeckHeader = process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER;
    previousSkipAdmin = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    previousStubSync = process.env.AGENT_DECK_STUB_SYNC;
    previousBearerFlag = process.env[MCP_REQUIRE_BEARER_ENV_VAR];
    previousHostedFlag = process.env.AGENT_DECK_HOSTED_MODE;
    previousHome = process.env.AGENT_DECK_HOME;
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = '0';
    process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = '0';
    process.env.AGENT_DECK_STUB_SYNC = 'off';
    delete process.env[MCP_REQUIRE_BEARER_ENV_VAR];
    delete process.env.AGENT_DECK_HOSTED_MODE;
    // NOT-604: an ambient user default must not steer recovery 404 cases.
    process.env.AGENT_DECK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'not569-nohome-'));
    workspaces.push(process.env.AGENT_DECK_HOME);
  });

  afterEach(async () => {
    if (mcpServer) {
      await mcpServer.stop();
      mcpServer = undefined;
    }
    while (servers.length) {
      await servers.pop()?.close();
    }
    while (workspaces.length) {
      fs.rmSync(workspaces.pop()!, { recursive: true, force: true });
    }
    while (dbs.length) {
      dbs.pop()?.close();
    }
    vi.restoreAllMocks();
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
    if (previousBearerFlag === undefined) {
      delete process.env[MCP_REQUIRE_BEARER_ENV_VAR];
    } else {
      process.env[MCP_REQUIRE_BEARER_ENV_VAR] = previousBearerFlag;
    }
    if (previousHostedFlag === undefined) {
      delete process.env.AGENT_DECK_HOSTED_MODE;
    } else {
      process.env.AGENT_DECK_HOSTED_MODE = previousHostedFlag;
    }
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
  });

  async function buildListeningBackend() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'alpha' });
    const deckB = await db.createDeck({ name: 'beta' });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const playbookManager = new PlaybookManager(db);

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('credentialManager', {
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    fastify.decorate('playbookManager', playbookManager);

    registerHttpPolicyHook(fastify);
    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
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
    };
  }

  async function setup() {
    const backend = await buildListeningBackend();
    const started = await startMcpServer(backend.backendUrl, 'standard');
    mcpServer = started.server;
    return { ...backend, port: started.port, server: started.server };
  }

  function writeAssignment(dir: string, deckId: string, deckName: string): void {
    fs.mkdirSync(path.join(dir, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.agent-deck', 'use.json'),
      JSON.stringify({ version: 3, deckId, deckName }),
    );
  }

  function makeWorkspace(assignment?: { deckId: string; deckName: string } | 'corrupt'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not569-'));
    workspaces.push(dir);
    if (assignment === 'corrupt') {
      fs.mkdirSync(path.join(dir, '.agent-deck'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.agent-deck', 'use.json'), '{not json');
    } else if (assignment) {
      writeAssignment(dir, assignment.deckId, assignment.deckName);
    }
    return dir;
  }

  function workspaceHeaders(dir: string, deckId?: string): Record<string, string> {
    return {
      [AGENT_DECK_WORKSPACE_HEADER]: dir,
      ...(deckId ? { [AGENT_DECK_DECK_ID_HEADER]: deckId } : {}),
    };
  }

  type RawMcpResponse = {
    status: number;
    sessionHeader: string | null;
    sessionStatus: string | null;
    body: any;
  };

  async function postMcpRaw(
    port: number,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<RawMcpResponse> {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        ...headers,
      },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as any;
    return {
      status: response.status,
      sessionHeader: response.headers.get('mcp-session-id'),
      sessionStatus: response.headers.get('mcp-session-status'),
      body,
    };
  }

  function toolsCall(name: string, args: unknown, id: number) {
    return {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    };
  }

  function toolText(body: any): { isError: boolean; data: Record<string, unknown> } {
    const text = body?.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error(`Unexpected tools/call result: ${JSON.stringify(body)}`);
    }
    return {
      isError: Boolean(body.result?.isError),
      data: JSON.parse(text) as Record<string, unknown>,
    };
  }

  async function readTally(port: number) {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    return health.staleSessions as {
      count: number;
      distinctSessions: number;
      recoveredSessions: number;
      unresolvedSessions: number;
    };
  }

  type RecoveryInternals = {
    sessions: Map<string, unknown>;
    recoveredSessionAlias: Map<string, string>;
    staleSessionsById: Map<string, { recovered: boolean; lastAt: string }>;
    closedSessionIds: Set<string>;
  };

  function internalsOf(server: AgentDeckMCPServer): RecoveryInternals {
    return server as unknown as RecoveryInternals;
  }

  function recoveryWarnings(warnSpy: { mock: { calls: unknown[][] } }): unknown[][] {
    return warnSpy.mock.calls.filter((call) =>
      String(call[0] ?? '').includes('recovered from headers as'),
    );
  }

  async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (check()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('timed out waiting for expected server state');
  }

  it('recovers a tools/call with an unknown session id from the workspace header', async () => {
    const { deckA, port } = await setup();
    const headers = workspaceHeaders(
      makeWorkspace({ deckId: deckA.id, deckName: deckA.name }),
    );
    const staleId = 'stale-cursor-session-1';

    // No initialize is ever sent: the first post-restart tools/call heals.
    const first = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 1),
      { 'mcp-session-id': staleId, ...headers },
    );
    expect(first.status).toBe(200);
    // The response carries the id the client sent, so the client needs no change.
    expect(first.sessionHeader).toBe(staleId);
    const firstResult = toolText(first.body);
    expect(firstResult.isError).toBe(false);
    expect(firstResult.data.effective_deck_name).toBe('alpha');

    // A second request with the same stale id serves from the alias.
    const second = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 2),
      { 'mcp-session-id': staleId, ...headers },
    );
    expect(second.status).toBe(200);
    expect(second.sessionHeader).toBe(staleId);
    const secondResult = toolText(second.body);
    expect(secondResult.isError).toBe(false);
    expect(secondResult.data.effective_deck_name).toBe('alpha');
  });

  it('recovers from an explicit deck header', async () => {
    const { deckB, port } = await setup();
    const headers = { [AGENT_DECK_DECK_ID_HEADER]: deckB.id };
    const staleId = 'stale-deck-header-session';

    const recovered = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 1),
      { 'mcp-session-id': staleId, ...headers },
    );
    expect(recovered.status).toBe(200);
    expect(recovered.sessionHeader).toBe(staleId);
    const result = toolText(recovered.body);
    expect(result.isError).toBe(false);
    expect(result.data.effective_deck_name).toBe('beta');
  });

  it('prefers an explicit deck header over use.json on recovery', async () => {
    const { deckA, deckB, port } = await setup();
    const dir = makeWorkspace({ deckId: deckA.id, deckName: deckA.name });
    const headers = workspaceHeaders(dir, deckB.id);

    const recovered = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 1),
      { 'mcp-session-id': 'stale-header-wins', ...headers },
    );
    expect(recovered.status).toBe(200);
    expect(toolText(recovered.body).data.effective_deck_name).toBe('beta');
  });

  it('keeps the NOT-101 404 for requests that cannot rebind a deck', async () => {
    const { db, port } = await setup();
    const ghostDeck = '99999999-9999-4999-8999-999999999999';
    const cases: Array<{ name: string; staleId: string; headers: Record<string, string> }> = [
      {
        name: 'no deck-resolving header',
        staleId: 'not569-no-headers',
        headers: {},
      },
      {
        name: 'workspace with no use.json',
        staleId: 'not569-no-manifest',
        headers: workspaceHeaders(makeWorkspace()),
      },
      {
        name: 'workspace with a corrupt use.json',
        staleId: 'not569-corrupt-manifest',
        headers: workspaceHeaders(makeWorkspace('corrupt')),
      },
      {
        name: 'use.json naming a deleted deck',
        staleId: 'not569-deleted-manifest-deck',
        headers: workspaceHeaders(makeWorkspace({ deckId: ghostDeck, deckName: 'gone' })),
      },
      {
        name: 'deck header naming a deleted deck',
        staleId: 'not569-deleted-header-deck',
        headers: { [AGENT_DECK_DECK_ID_HEADER]: ghostDeck },
      },
      {
        name: 'unrelated headers only',
        staleId: 'not569-unrelated-headers',
        headers: { 'x-agent-deck-correlation-id': '00000000-0000-4000-8000-000000000000' },
      },
    ];
    for (const { name, staleId, headers } of cases) {
      const answered = await postMcpRaw(
        port,
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { 'mcp-session-id': staleId, ...headers },
      );
      expect(answered.status, name).toBe(404);
      expect(answered.sessionStatus, name).toBe('expired');
      expect(answered.body?.error?.code, name).toBe(-32001);
      expect(String(answered.body?.error?.message ?? ''), name).toContain('Session not found');
      expect(String(answered.body?.error?.message ?? ''), name).toContain('re-initialize');
    }
    // Failed binds leave no partial runtime session behind.
    const row = db
      .getSqliteDatabase()
      .prepare('SELECT COUNT(*) AS n FROM runtime_sessions')
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('never resurrects a session id the server closed itself', async () => {
    const { deckA, port, server } = await setup();
    const headers = workspaceHeaders(
      makeWorkspace({ deckId: deckA.id, deckName: deckA.name }),
    );
    const sessionId = await openSession(port, 1, headers);
    const before = await readTally(port);

    const closed = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'DELETE',
      headers: { Accept: MCP_ACCEPT, 'mcp-session-id': sessionId, ...headers },
    });
    expect(closed.status).toBe(200);
    await closed.arrayBuffer();
    await waitFor(() => internalsOf(server).closedSessionIds.has(sessionId));

    // Even with headers that could rebind the deck, a closed id stays 404.
    const late = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 2),
      { 'mcp-session-id': sessionId, ...headers },
    );
    expect(late.status).toBe(404);
    expect(late.sessionStatus).toBe('expired');
    expect(late.body?.error?.code).toBe(-32001);

    // ...and nothing is reported as stranded.
    expect(await readTally(port)).toEqual(before);
  });

  it('never recovers a request carrying a bearer token in local mode', async () => {
    const { deckA, port } = await setup();
    const headers = {
      ...workspaceHeaders(makeWorkspace({ deckId: deckA.id, deckName: deckA.name })),
      authorization: 'Bearer not-a-real-grant-token',
    };

    const answered = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 1),
      { 'mcp-session-id': 'not569-bearer-stale', ...headers },
    );
    expect(answered.status).toBe(404);
    expect(answered.sessionStatus).toBe('expired');
    expect(answered.body?.error?.code).toBe(-32001);
  });

  it('keeps hosted mode unchanged: 401 without a bearer, 404 for unknown ids with one', async () => {
    process.env[MCP_REQUIRE_BEARER_ENV_VAR] = '1';
    process.env.AGENT_DECK_HOSTED_MODE = '1';
    try {
      const backend = await buildListeningBackend();
      const db = new Database(':memory:');
      dbs.push(db);
      const grantStore = new ClientGrantStore(db);
      const auditStore = new AuditStore(db);
      const hosted = new AgentDeckMCPServer(0, backend.backendUrl, 'standard', '127.0.0.1', {
        grantStore,
        auditStore,
      });
      mcpServer = hosted;
      await hosted.start();
      const port = hosted.getPort();
      const issued = grantStore.issueGrant({ label: 'hosted', defaultDeck: backend.deckA.id });
      const headers = workspaceHeaders(
        makeWorkspace({ deckId: backend.deckA.id, deckName: backend.deckA.name }),
      );

      const unauthenticated = await postMcpRaw(
        port,
        toolsCall('get_session_context', {}, 1),
        { 'mcp-session-id': 'not569-hosted-no-bearer', ...headers },
      );
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.body?.error?.message).toBe('GRANT_REQUIRED');

      const authenticated = await postMcpRaw(
        port,
        toolsCall('get_session_context', {}, 2),
        {
          'mcp-session-id': 'not569-hosted-unknown-id',
          ...headers,
          authorization: `Bearer ${issued.token}`,
        },
      );
      expect(authenticated.status).toBe(404);
      expect(authenticated.sessionStatus).toBe('expired');
      expect(authenticated.body?.error?.code).toBe(-32001);
      expect(String(authenticated.body?.error?.message ?? '')).toContain('Session not found');
    } finally {
      delete process.env[MCP_REQUIRE_BEARER_ENV_VAR];
      delete process.env.AGENT_DECK_HOSTED_MODE;
    }
  });

  it('counts a recovered stale id as recovered and logs one line per id', async () => {
    const { deckA, port } = await setup();
    const headers = workspaceHeaders(
      makeWorkspace({ deckId: deckA.id, deckName: deckA.name }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const baseline = await readTally(port);

    // A first attempt without headers strands the id...
    const stranded = await postMcpRaw(
      port,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { 'mcp-session-id': 'not569-flip' },
    );
    expect(stranded.status).toBe(404);
    const afterStranded = await readTally(port);
    expect(afterStranded.unresolvedSessions).toBe(baseline.unresolvedSessions + 1);
    expect(afterStranded.recoveredSessions).toBe(baseline.recoveredSessions);

    // ...and the same id with headers flips it to recovered.
    const recovered = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 2),
      { 'mcp-session-id': 'not569-flip', ...headers },
    );
    expect(recovered.status).toBe(200);
    const afterRecovery = await readTally(port);
    expect(afterRecovery.unresolvedSessions).toBe(baseline.unresolvedSessions);
    expect(afterRecovery.recoveredSessions).toBe(baseline.recoveredSessions + 1);

    const lines = recoveryWarnings(warnSpy).filter((call) =>
      String(call[0]).includes('not569-flip'),
    );
    expect(lines).toHaveLength(1);

    // Later requests on the same stale id serve quietly from the alias.
    const again = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 3),
      { 'mcp-session-id': 'not569-flip', ...headers },
    );
    expect(again.status).toBe(200);
    expect(
      recoveryWarnings(warnSpy).filter((call) => String(call[0]).includes('not569-flip')),
    ).toHaveLength(1);
    const afterAgain = await readTally(port);
    expect(afterAgain.recoveredSessions).toBe(baseline.recoveredSessions + 1);
    expect(afterAgain.unresolvedSessions).toBe(baseline.unresolvedSessions);
  });

  it('keeps the alias map and the recovered tally bounded under a flood of stale ids', async () => {
    const { deckA, port, server } = await setup();
    const headers = workspaceHeaders(
      makeWorkspace({ deckId: deckA.id, deckName: deckA.name }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const FLOOD = 210;
    const staleIds = Array.from({ length: FLOOD }, (_, index) => `not569-flood-${index}`);

    for (let offset = 0; offset < staleIds.length; offset += 70) {
      const chunk = staleIds.slice(offset, offset + 70);
      const answers = await Promise.all(
        chunk.map((staleId, index) =>
          postMcpRaw(port, toolsCall('get_session_context', {}, offset + index), {
            'mcp-session-id': staleId,
            ...headers,
          }).then((answer) => ({ staleId, answer })),
        ),
      );
      for (const { staleId, answer } of answers) {
        expect(answer.status, staleId).toBe(200);
        expect(answer.sessionHeader, staleId).toBe(staleId);
        expect(toolText(answer.body).data.effective_deck_name, staleId).toBe('alpha');
      }
    }

    const internals = internalsOf(server);
    expect(internals.recoveredSessionAlias.size).toBe(200);
    expect(internals.staleSessionsById.size).toBe(200);

    const tally = await readTally(port);
    expect(tally.recoveredSessions).toBe(200);
    expect(tally.unresolvedSessions).toBe(0);
    // Served requests are not stale-request 404s, so the counter never moved.
    expect(tally.count).toBe(0);

    expect(recoveryWarnings(warnSpy)).toHaveLength(FLOOD);
  }, 60000);

  it('recovers once when parallel requests share one stale id', async () => {
    const { deckA, port, server } = await setup();
    const headers = workspaceHeaders(
      makeWorkspace({ deckId: deckA.id, deckName: deckA.name }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const staleId = 'not569-race';

    const [first, second] = await Promise.all([
      postMcpRaw(port, toolsCall('get_session_context', {}, 1), {
        'mcp-session-id': staleId,
        ...headers,
      }),
      postMcpRaw(port, toolsCall('get_session_context', {}, 2), {
        'mcp-session-id': staleId,
        ...headers,
      }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.sessionHeader).toBe(staleId);
    expect(second.sessionHeader).toBe(staleId);

    const internals = internalsOf(server);
    expect(internals.sessions.size).toBe(1);
    expect(internals.recoveredSessionAlias.size).toBe(1);
    expect(
      recoveryWarnings(warnSpy).filter((call) => String(call[0]).includes(staleId)),
    ).toHaveLength(1);
  });

  it('serves GET through an installed alias but never mints one from GET alone', async () => {
    const { deckA, port } = await setup();
    const headers = workspaceHeaders(
      makeWorkspace({ deckId: deckA.id, deckName: deckA.name }),
    );
    const staleId = 'not569-get';

    const recovered = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 1),
      { 'mcp-session-id': staleId, ...headers },
    );
    expect(recovered.status).toBe(200);

    const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'mcp-session-id': staleId,
        ...headers,
      },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('mcp-session-id')).toBe(staleId);
    await stream.body?.cancel();

    // GET alone — without a prior POST recovery — keeps the NOT-101 404.
    const cold = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'mcp-session-id': 'not569-get-cold',
        ...headers,
      },
    });
    expect(cold.status).toBe(404);
    expect(cold.headers.get('mcp-session-status')).toBe('expired');
    await cold.arrayBuffer();
  });

  it('closes a recovered session through DELETE and re-recovers on the next call', async () => {
    const { deckA, port, server } = await setup();
    const headers = workspaceHeaders(
      makeWorkspace({ deckId: deckA.id, deckName: deckA.name }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const staleId = 'not569-delete';

    const recovered = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 1),
      { 'mcp-session-id': staleId, ...headers },
    );
    expect(recovered.status).toBe(200);
    const internals = internalsOf(server);
    expect(internals.recoveredSessionAlias.has(staleId)).toBe(true);

    const closed = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'DELETE',
      headers: { Accept: MCP_ACCEPT, 'mcp-session-id': staleId, ...headers },
    });
    expect(closed.status).toBe(200);
    await closed.arrayBuffer();
    await waitFor(() => !internals.recoveredSessionAlias.has(staleId));

    // The stale id was never issued here, so the next call recovers again.
    const rerecovered = await postMcpRaw(
      port,
      toolsCall('get_session_context', {}, 2),
      { 'mcp-session-id': staleId, ...headers },
    );
    expect(rerecovered.status).toBe(200);
    expect(rerecovered.sessionHeader).toBe(staleId);
    expect(toolText(rerecovered.body).data.effective_deck_name).toBe('alpha');
    expect(
      recoveryWarnings(warnSpy).filter((call) => String(call[0]).includes(staleId)),
    ).toHaveLength(2);
  });
});
