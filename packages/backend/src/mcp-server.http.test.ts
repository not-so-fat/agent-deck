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

type GrantStubBackend = {
  port: number;
  connectBodies: Array<{ grantSecret?: string; mcpSessionId?: string; claimedGrantId?: string }>;
  disconnectBodies: Array<{ grantSecret?: string; mcpSessionId?: string }>;
  revokedSecrets: Set<string>;
  close: () => Promise<void>;
};

function startGrantStubBackend(validSecret: string, validGrantId = 'wgr_validgrant00000000000000000001'): Promise<GrantStubBackend> {
  const connectBodies: GrantStubBackend['connectBodies'] = [];
  const disconnectBodies: GrantStubBackend['disconnectBodies'] = [];
  const revokedSecrets = new Set<string>();
  const sessionsByMcp = new Map<string, { sessionId: string; grantId: string }>();
  let sessionSeq = 0;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const respond = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/api/trusted-session/mcp/connect') {
        const body = JSON.parse(raw || '{}') as {
          grantSecret?: string;
          mcpSessionId?: string;
          claimedGrantId?: string;
        };
        connectBodies.push(body);
        if (!body.grantSecret || body.grantSecret !== validSecret || revokedSecrets.has(body.grantSecret)) {
          respond(401, { success: false, error: 'No valid workspace grant', error_code: 'GRANT_REQUIRED' });
          return;
        }
        if (body.claimedGrantId && body.claimedGrantId !== validGrantId) {
          respond(401, {
            success: false,
            error: 'Claimed grant id does not match secret',
            error_code: 'GRANT_REQUIRED',
          });
          return;
        }
        const mcpId = body.mcpSessionId?.trim();
        if (mcpId) {
          const existing = sessionsByMcp.get(mcpId);
          if (existing && existing.grantId !== validGrantId) {
            respond(401, {
              success: false,
              error: 'Grant does not own this MCP session',
              error_code: 'GRANT_REQUIRED',
            });
            return;
          }
          if (existing) {
            respond(200, {
              success: true,
              data: {
                sessionId: existing.sessionId,
                workspaceGrantId: validGrantId,
                deckId: STUB_DECK_ID,
                deckName: 'Stub Deck',
                mode: 'normal',
              },
            });
            return;
          }
        }
        sessionSeq += 1;
        const sessionId = `ses_test_${sessionSeq}`;
        if (mcpId) {
          sessionsByMcp.set(mcpId, { sessionId, grantId: validGrantId });
        }
        respond(200, {
          success: true,
          data: {
            sessionId,
            workspaceGrantId: validGrantId,
            deckId: STUB_DECK_ID,
            deckName: 'Stub Deck',
            mode: 'normal',
          },
        });
        return;
      }
      if (req.method === 'POST' && url === '/api/trusted-session/mcp/disconnect') {
        const body = JSON.parse(raw || '{}') as { grantSecret?: string; mcpSessionId?: string };
        disconnectBodies.push(body);
        if (body.mcpSessionId) {
          sessionsByMcp.delete(body.mcpSessionId);
        }
        respond(200, { success: true, data: { revoked: true } });
        return;
      }
      if (req.method === 'POST' && url === '/api/scope/live-display') {
        respond(200, { success: true, data: { badge: 'fox' } });
        return;
      }
      respond(404, { success: false, error: `stub: unhandled ${req.method} ${url}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        connectBodies,
        disconnectBodies,
        revokedSecrets,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function listToolsWithAuth(port: number, sessionId: string, id: number, bearer: string) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      'mcp-session-id': sessionId,
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/list',
      params: {},
    }),
  });
  return response;
}

describe('MCP grant auth across HTTP session lifecycle (NOT-53)', () => {
  const validSecret = 'valid-grant-secret';
  const validGrantId = 'wgr_validgrant00000000000000000001';
  let stub: GrantStubBackend;
  let grantPort: number;
  let grantServer: AgentDeckMCPServer;
  let previousSkip: string | undefined;

  beforeAll(async () => {
    previousSkip = process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH;
    process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH = '0';
    stub = await startGrantStubBackend(validSecret, validGrantId);
    grantPort = 39_000 + Math.floor(Math.random() * 2_000);
    grantServer = new AgentDeckMCPServer(grantPort, `http://127.0.0.1:${stub.port}`);
    await grantServer.start();
    await waitForMcpHealth(grantPort);
  });

  afterAll(async () => {
    await grantServer.stop();
    await stub.close();
    if (previousSkip === undefined) {
      delete process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH;
    } else {
      process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH = previousSkip;
    }
  });

  it('rejects invalid initialize without advertising mcp-session-id', async () => {
    const response = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Authorization: 'Bearer bad-secret',
      },
      body: JSON.stringify(initializePayload(301)),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = await response.json();
    expect(body.error.message).toBe('GRANT_REQUIRED');
  });

  it('accepts valid initialize and serves follow-up tools/list', async () => {
    const init = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Authorization: `Bearer ${validSecret}`,
      },
      body: JSON.stringify(initializePayload(302)),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const tools = await listToolsWithAuth(grantPort, sessionId!, 303, validSecret);
    expect(tools.status).toBe(200);
    const body = await tools.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toContain('get_decks');
  });

  it('accepts grantId:secret Bearer when claimed id matches', async () => {
    const init = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Authorization: `Bearer ${validGrantId}:${validSecret}`,
      },
      body: JSON.stringify(initializePayload(304)),
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('rejects grantId:secret when claimed id mismatches', async () => {
    const init = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Authorization: 'Bearer wgr_wronggrant00000000000000000001:valid-grant-secret',
      },
      body: JSON.stringify(initializePayload(305)),
    });
    expect(init.status).toBe(401);
    expect(init.headers.get('mcp-session-id')).toBeNull();
  });

  it('returns 401 on missing/wrong follow-up Bearer without destroying the session', async () => {
    const init = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Authorization: `Bearer ${validSecret}`,
      },
      body: JSON.stringify(initializePayload(306)),
    });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const missingNoHeader = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 307, method: 'tools/list', params: {} }),
    });
    expect(missingNoHeader.status).toBe(401);

    const wrong = await listToolsWithAuth(grantPort, sessionId!, 308, 'wrong-secret');
    expect(wrong.status).toBe(401);

    const retry = await listToolsWithAuth(grantPort, sessionId!, 309, validSecret);
    expect(retry.status).toBe(200);

    // GET follow-up also requires Bearer
    const getMissing = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'GET',
      headers: {
        'mcp-session-id': sessionId!,
        Accept: 'text/event-stream',
      },
    });
    expect(getMissing.status).toBe(401);

    const getOk = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'GET',
      headers: {
        'mcp-session-id': sessionId!,
        Accept: 'text/event-stream',
        Authorization: `Bearer ${validSecret}`,
      },
    });
    expect(getOk.status).toBe(200);
    await getOk.body?.cancel();
  });

  it('fails follow-up after grant revocation', async () => {
    const init = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Authorization: `Bearer ${validSecret}`,
      },
      body: JSON.stringify(initializePayload(310)),
    });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    stub.revokedSecrets.add(validSecret);
    const afterRevoke = await listToolsWithAuth(grantPort, sessionId!, 311, validSecret);
    expect(afterRevoke.status).toBe(401);
    stub.revokedSecrets.delete(validSecret);
  });

  it('keeps concurrent sessions isolated', async () => {
    const initA = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Authorization: `Bearer ${validSecret}`,
      },
      body: JSON.stringify(initializePayload(312)),
    });
    const initB = await fetch(`http://127.0.0.1:${grantPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Authorization: `Bearer ${validSecret}`,
      },
      body: JSON.stringify(initializePayload(313)),
    });
    const sessionA = initA.headers.get('mcp-session-id');
    const sessionB = initB.headers.get('mcp-session-id');
    expect(sessionA).toBeTruthy();
    expect(sessionB).toBeTruthy();
    expect(sessionA).not.toBe(sessionB);

    const toolsA = await listToolsWithAuth(grantPort, sessionA!, 314, validSecret);
    const toolsB = await listToolsWithAuth(grantPort, sessionB!, 315, validSecret);
    expect(toolsA.status).toBe(200);
    expect(toolsB.status).toBe(200);
  });
});
