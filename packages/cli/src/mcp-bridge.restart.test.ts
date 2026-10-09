/**
 * NOT-101 repro, automated: a real MCP server restart under a live bridge.
 *
 * Before this change the bridge stayed wedged — every tool call came back
 * "Bad Request: No valid session ID provided" until the host was restarted by
 * hand. The test drives the real `AgentDeckMCPServer` on a fixed port, stops it,
 * starts a fresh instance on the same port, and asserts the stdio client above
 * the bridge never has to do anything.
 */
import { PassThrough } from 'node:stream';
import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AgentDeckMCPServer } from '../../backend/src/mcp-server';
import { McpStdioHttpBridge } from './mcp-bridge';
import { formatMcpSessionStatus, readMcpSessionHealth } from './ports';

type JsonRpcMessage = {
  id?: string | number | null;
  method?: string;
  result?: any;
  error?: any;
};

/** Backend URL that refuses connections — deck lookups are not under test here. */
const UNREACHABLE_BACKEND = 'http://127.0.0.1:1';

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === 'EADDRINUSE';
}

/**
 * Bind this exact port, which the restart half of the test depends on. A parallel
 * vitest worker can hold it for a moment, so retry briefly before giving up.
 */
async function startServer(
  port: number,
  backendUrl: string = UNREACHABLE_BACKEND,
  serverOptions?: ConstructorParameters<typeof AgentDeckMCPServer>[4],
): Promise<AgentDeckMCPServer> {
  for (let attempt = 0; ; attempt += 1) {
    const server = new AgentDeckMCPServer(port, backendUrl, undefined, '127.0.0.1', serverOptions);
    try {
      await server.start();
      return server;
    } catch (error) {
      if (!isAddressInUse(error) || attempt >= 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/**
 * A free port is only free until someone else takes it — `findFreePort` closes its
 * probe socket before we listen. Take the next candidate when that happens.
 */
async function startServerOnFreePort(
  backendUrl: string = UNREACHABLE_BACKEND,
  serverOptions?: ConstructorParameters<typeof AgentDeckMCPServer>[4],
): Promise<{ server: AgentDeckMCPServer; port: number }> {
  for (let attempt = 0; ; attempt += 1) {
    const port = await findFreePort();
    try {
      return { server: await startServer(port, backendUrl, serverOptions), port };
    } catch (error) {
      if (!isAddressInUse(error) || attempt >= 4) {
        throw error;
      }
    }
  }
}

/** Collects NDJSON written by the bridge and hands back messages by JSON-RPC id. */
class ClientChannel {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  private buffer = '';
  private readonly received: JsonRpcMessage[] = [];

  constructor() {
    this.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let index = this.buffer.indexOf('\n');
      while (index !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) {
          this.received.push(JSON.parse(line) as JsonRpcMessage);
        }
        index = this.buffer.indexOf('\n');
      }
    });
  }

  send(message: Record<string, unknown>): void {
    this.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async waitFor(id: number, timeoutMs = 5_000): Promise<JsonRpcMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.received.find((message) => message.id === id);
      if (match) {
        return match;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No response for id ${id} within ${timeoutMs}ms`);
  }
}

function initializeMessage(id: number) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest-bridge', version: '1.0.0' },
    },
  };
}

describe('MCP bridge survives a server restart', () => {
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(() => {
    // The bridge sends no launch-deck header; the deck launch path is tested elsewhere.
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = '1';
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('re-initializes transparently when the server restarts under it', async () => {
    const started = await startServerOnFreePort();
    const port = started.port;
    let server = started.server;
    cleanups.push(async () => {
      await server.stop();
    });

    const channel = new ClientChannel();
    const bridge = new McpStdioHttpBridge({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: {},
      stdin: channel.stdin,
      stdout: channel.stdout,
      log: () => {},
      streamRetryDelayMs: 25,
    });
    const running = bridge.run();
    cleanups.push(async () => {
      channel.stdin.end();
      bridge.close();
      await running;
    });

    channel.send(initializeMessage(1));
    const initResult = await channel.waitFor(1);
    expect(initResult.result?.serverInfo?.name).toBe('agent-deck-server');

    channel.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    channel.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const beforeRestart = await channel.waitFor(2);
    expect(beforeRestart.result?.tools?.length).toBeGreaterThan(0);

    const sessionBefore = bridge.getSessionId();
    expect(sessionBefore).toBeTruthy();

    // The restart: same port, brand new process state — exactly what an upgrade does.
    await server.stop();
    server = await startServer(port);
    // Wait until the replacement accepts HTTP. A tools/list that races the listen
    // surfaces as a transport error instead of the 404→re-init path under test.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`);
        if (health.ok) {
          break;
        }
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    channel.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const afterRestart = await channel.waitFor(3);

    expect(afterRestart.error).toBeUndefined();
    expect(afterRestart.result?.tools?.length).toBeGreaterThan(0);
    expect(bridge.getRecoveryCount()).toBeGreaterThanOrEqual(1);
    expect(bridge.getSessionId()).not.toBe(sessionBefore);

    // ...and the restart is observable rather than silent.
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.staleSessions.count).toBeGreaterThan(0);
    expect(health.liveSessions).toBeGreaterThan(0);
    // The client did come back, so the tally must not keep calling it stranded.
    expect(health.staleSessions.recoveredSessions).toBe(1);
    expect(health.staleSessions.unresolvedSessions).toBe(0);
    expect(formatMcpSessionStatus(readMcpSessionHealth(health)).join('\n')).not.toContain(
      'still using',
    );
  });

  it('leaves a client that never reconnects counted as unresolved', async () => {
    const { server, port: wedgedPort } = await startServerOnFreePort();
    cleanups.push(async () => {
      await server.stop();
    });

    // Exactly what a wedged supergateway does: keep POSTing a session id from a
    // process that is gone, and never re-initialize.
    const response = await fetch(`http://127.0.0.1:${wedgedPort}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'session-from-a-previous-process',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(404);

    const health = await (await fetch(`http://127.0.0.1:${wedgedPort}/health`)).json();
    expect(health.staleSessions.unresolvedSessions).toBe(1);
    expect(formatMcpSessionStatus(readMcpSessionHealth(health)).join('\n')).toContain(
      '1 client still using',
    );
  });
});

const STUB_DECK_ID = '22222222-2222-4222-8222-222222222222';

type RestartStubBackend = {
  url: string;
  unregisters: string[];
  disconnects: any[];
  close: () => Promise<void>;
};

/**
 * NOT-191: just enough backend for the bridge↔server lifecycle — deck reads,
 * live-display register/touch/unregister, and the launch-deck trust
 * handshake — so the tests can watch every session-owned registry empty.
 */
async function startStubBackend(): Promise<RestartStubBackend> {
  const unregisters: string[] = [];
  const disconnects: any[] = [];
  const deck = {
    id: STUB_DECK_ID,
    name: 'Stub Deck',
    services: [],
    credentials: [],
    playbooks: [],
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
      if (req.method === 'POST' && url === '/api/scope/live-display') {
        respond({ success: true, data: { badge: 'fox' } });
        return;
      }
      if (req.method === 'POST' && /^\/api\/scope\/live-display\/.+\/touch$/.test(url)) {
        respond({ success: true, data: { found: true } });
        return;
      }
      if (req.method === 'DELETE' && /^\/api\/scope\/live-display\/[^/]+$/.test(url)) {
        unregisters.push(url);
        respond({ success: true });
        return;
      }
      if (req.method === 'POST' && url === '/api/trusted-session/mcp/connect-deck') {
        const parsed = JSON.parse(raw || '{}');
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
      respond({ success: false, error: `stub: unhandled ${req.method} ${url}` }, 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    unregisters,
    disconnects,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

async function waitForCondition(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('MCP bridge session lifecycle over real HTTP (NOT-191)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(() => {
    process.env.AGENT_DECK_MCP_SKIP_DECK_HEADER = '1';
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('clean stdin shutdown removes the session from every server registry', async () => {
    const stub = await startStubBackend();
    cleanups.push(() => stub.close());
    const { server, port } = await startServerOnFreePort(stub.url);
    cleanups.push(async () => {
      await server.stop();
    });

    const channel = new ClientChannel();
    const bridge = new McpStdioHttpBridge({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { 'x-agent-deck-deck-id': STUB_DECK_ID },
      stdin: channel.stdin,
      stdout: channel.stdout,
      log: () => {},
      streamRetryDelayMs: 25,
      heartbeatIntervalMs: 0,
    });
    const running = bridge.run();
    cleanups.push(async () => {
      channel.stdin.end();
      bridge.close();
      await running;
    });

    channel.send(initializeMessage(1));
    await channel.waitFor(1);
    channel.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    channel.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await channel.waitFor(2);

    const sessionId = bridge.getSessionId()!;
    expect(sessionId).toBeTruthy();
    const internals = server as unknown as {
      sessions: Map<string, unknown>;
      sessionBinding: { getBinding: (id: string) => { runtimeSessionId?: string } };
      badgeBySession: Map<string, string>;
      lastTouchAtMs: Map<string, number>;
      lastClientActivityAtMs: Map<string, number>;
    };
    expect(internals.sessions.has(sessionId)).toBe(true);
    expect(internals.sessionBinding.getBinding(sessionId).runtimeSessionId).toBe(
      `runtime-${sessionId}`,
    );
    await waitForCondition(
      () => internals.badgeBySession.has(sessionId),
      'live-display registration',
    );

    channel.stdin.end();
    await running;

    // The shutdown DELETE ran the unified cleanup: transport, binding,
    // badge, touch, activity, runtime session, and live-display row.
    await waitForCondition(() => !internals.sessions.has(sessionId), 'session cleanup');
    expect(internals.badgeBySession.has(sessionId)).toBe(false);
    expect(internals.lastTouchAtMs.has(sessionId)).toBe(false);
    expect(internals.lastClientActivityAtMs.has(sessionId)).toBe(false);
    expect(internals.sessionBinding.getBinding(sessionId).runtimeSessionId).toBeUndefined();
    expect(stub.unregisters.some((url) => url.includes(encodeURIComponent(sessionId)))).toBe(true);
    expect(stub.disconnects.some((body) => body.mcpSessionId === sessionId)).toBe(true);
  });

  it('re-initializes on the same deck after the transport TTL expires the session', async () => {
    const stub = await startStubBackend();
    cleanups.push(() => stub.close());
    const clock = { now: Date.now() };
    const { server, port } = await startServerOnFreePort(stub.url, {
      now: () => clock.now,
      transportIdleTtlMs: 1_000,
      transportSweepIntervalMs: 0,
    });
    cleanups.push(async () => {
      await server.stop();
    });

    const channel = new ClientChannel();
    const bridge = new McpStdioHttpBridge({
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { 'x-agent-deck-deck-id': STUB_DECK_ID },
      stdin: channel.stdin,
      stdout: channel.stdout,
      log: () => {},
      streamRetryDelayMs: 25,
      heartbeatIntervalMs: 0,
    });
    const running = bridge.run();
    cleanups.push(async () => {
      channel.stdin.end();
      bridge.close();
      await running;
    });

    channel.send(initializeMessage(1));
    await channel.waitFor(1);
    channel.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    channel.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await channel.waitFor(2);
    expect(bridge.getBoundDeckId()).toBe(STUB_DECK_ID);
    const sessionBefore = bridge.getSessionId()!;

    clock.now += 60_000;
    await (
      server as unknown as { sweepIdleTransports: () => Promise<void> }
    ).sweepIdleTransports();

    // The next host request takes the existing 404/session-expired recovery
    // path and lands back on the same effective deck.
    channel.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const afterExpiry = await channel.waitFor(3);
    expect(afterExpiry.error).toBeUndefined();
    expect(afterExpiry.result?.tools?.length).toBeGreaterThan(0);
    expect(bridge.getRecoveryCount()).toBe(1);
    expect(bridge.getSessionId()).not.toBe(sessionBefore);
    expect(bridge.getBoundDeckId()).toBe(STUB_DECK_ID);
  });
});
