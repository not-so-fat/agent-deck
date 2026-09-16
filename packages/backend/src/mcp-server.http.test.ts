import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentDeckMCPServer } from './mcp-server';
import { installStrictConsoleCapture } from './mcp-tools/test-harness';

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
  unhandled: string[];
  close: () => Promise<void>;
};

function startStubBackend(): Promise<StubBackend> {
  const liveDisplayBodies: any[] = [];
  const touches: string[] = [];
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
        respond({ success: true });
        return;
      }
      if (req.method === 'POST' && url === '/api/scope/deck-workspace') {
        respond({ success: true, data: { ok: true } });
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
});
