/**
 * NOT-47: OS-assigned MCP harness ports + parallel bind stability.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { AgentDeckMCPServer } from '../mcp-server';
import {
  installStrictConsoleCapture,
  startMcpServer,
  waitForMcpHealth,
} from './test-harness';

describe('MCP test harness port allocation (NOT-47)', () => {
  const servers: AgentDeckMCPServer[] = [];
  const captures: Array<ReturnType<typeof installStrictConsoleCapture>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.stop();
    }
    while (captures.length) {
      const capture = captures.pop()!;
      capture.restore();
      capture.assertClean();
    }
  });

  it('AgentDeckMCPServer with port 0 exposes the OS-assigned listening port', async () => {
    const capture = installStrictConsoleCapture();
    captures.push(capture);

    const server = new AgentDeckMCPServer(0, 'http://127.0.0.1:1');
    servers.push(server);
    await server.start();

    const port = server.getPort();
    expect(port).toBeGreaterThan(0);
    await waitForMcpHealth(port);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.ok).toBe(true);
  });

  it('startMcpServer returns the listening port from the server (no random 36k pool)', async () => {
    const capture = installStrictConsoleCapture();
    captures.push(capture);

    const started = await startMcpServer('http://127.0.0.1:1');
    servers.push(started.server);

    expect(started.port).toBe(started.server.getPort());
    expect(started.port).toBeGreaterThan(0);
    await waitForMcpHealth(started.port);
  });

  it('parallel startMcpServer calls bind distinct ports without EADDRINUSE', async () => {
    const capture = installStrictConsoleCapture();
    captures.push(capture);

    const started = await Promise.all(
      Array.from({ length: 24 }, () => startMcpServer('http://127.0.0.1:1')),
    );
    for (const item of started) {
      servers.push(item.server);
    }

    const ports = started.map((item) => item.port);
    expect(new Set(ports).size).toBe(ports.length);
    await Promise.all(ports.map((port) => waitForMcpHealth(port)));
  });
});
