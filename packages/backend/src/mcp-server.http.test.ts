import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AgentDeckMCPServer } from './mcp-server';

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

describe('AgentDeckMCPServer streamable HTTP', () => {
  let port: number;
  let mcpServer: AgentDeckMCPServer;

  beforeAll(async () => {
    port = 36_000 + Math.floor(Math.random() * 2_000);
    mcpServer = new AgentDeckMCPServer(port, 'http://127.0.0.1:1');
    await mcpServer.start();
    await waitForMcpHealth(port);
  });

  afterAll(async () => {
    await mcpServer.stop();
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
});

import http from 'node:http';

const STUB_DECK_ID = '33333333-3333-4333-8333-333333333333';

type StubBackend = {
  port: number;
  liveDisplayBodies: any[];
  touches: string[];
  close: () => Promise<void>;
};

function startStubBackend(): Promise<StubBackend> {
  const liveDisplayBodies: any[] = [];
  const touches: string[] = [];
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
      const respond = (body: unknown) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      if (req.method === 'GET' && (url === '/api/scope/deck' || url === `/api/decks/${STUB_DECK_ID}`)) {
        respond({ success: true, data: deck });
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
      respond({ success: false, error: `stub: unhandled ${req.method} ${url}` });
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

  beforeAll(async () => {
    stub = await startStubBackend();
    badgePort = 38_000 + Math.floor(Math.random() * 2_000);
    badgeServer = new AgentDeckMCPServer(badgePort, `http://127.0.0.1:${stub.port}`);
    await badgeServer.start();
    await waitForMcpHealth(badgePort);
  });

  afterAll(async () => {
    await badgeServer.stop();
    await stub.close();
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
