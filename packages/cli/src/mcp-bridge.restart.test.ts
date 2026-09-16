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
import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AgentDeckMCPServer } from '../../backend/src/mcp-server';
import { McpStdioHttpBridge } from './mcp-bridge';

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

async function startServer(port: number): Promise<AgentDeckMCPServer> {
  const server = new AgentDeckMCPServer(port, UNREACHABLE_BACKEND);
  await server.start();
  return server;
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
  let port: number;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(() => {
    // The bridge sends no launch-deck header; the deck grant path is tested elsewhere.
    process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH = '1';
  });

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it('re-initializes transparently when the server restarts under it', async () => {
    port = await findFreePort();
    let server = await startServer(port);
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
  });
});
