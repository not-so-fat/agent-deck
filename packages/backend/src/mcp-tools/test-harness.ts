import { AgentDeckMCPServer } from '../mcp-server';
import type { McpToolProfile } from './profile';

export const MCP_ACCEPT = 'application/json, text/event-stream';

export function initializePayload(id = 1, clientName = 'vitest') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' },
    },
  };
}

export async function waitForMcpHealth(port: number): Promise<void> {
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

export async function postInitialize(
  port: number,
  id = 1,
  clientName = 'vitest',
  extraHeaders?: Record<string, string>,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: MCP_ACCEPT,
    ...extraHeaders,
  };
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(initializePayload(id, clientName)),
  });
}

export async function listTools(
  port: number,
  sessionId: string,
  id: number,
  extraHeaders?: Record<string, string>,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: MCP_ACCEPT,
    'mcp-session-id': sessionId,
    ...extraHeaders,
  };
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/list',
      params: {},
    }),
  });
  const body = (await response.json()) as {
    result?: { tools?: Array<{ name: string; inputSchema?: { required?: string[] } }> };
  };
  return body.result?.tools ?? [];
}

export type McpToolCallResult = {
  isError: boolean;
  data: Record<string, unknown>;
};

export async function callToolMcpResult(
  port: number,
  sessionId: string,
  name: string,
  args: unknown,
  id: number,
  extraHeaders?: Record<string, string>,
): Promise<McpToolCallResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: MCP_ACCEPT,
    'mcp-session-id': sessionId,
    ...extraHeaders,
  };
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
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
    throw new Error(`MCP tools/call error: ${JSON.stringify(body.error)}`);
  }
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`Unexpected tools/call result: ${JSON.stringify(body)}`);
  }
  return {
    isError: Boolean(body.result?.isError),
    data: JSON.parse(text) as Record<string, unknown>,
  };
}

export async function callTool(
  port: number,
  sessionId: string,
  name: string,
  args: unknown,
  id: number,
  extraHeaders?: Record<string, string>,
) {
  const result = await callToolMcpResult(port, sessionId, name, args, id, extraHeaders);
  if (result.isError) {
    throw new Error(JSON.stringify(result.data));
  }
  return result.data;
}

/**
 * Capture console.error / connection-reset noise so a green suite cannot hide
 * unexpected backend failures. Call `assertClean()` in afterEach/afterAll.
 */
export function installStrictConsoleCapture(options?: {
  /** Prefixes that are expected and ignored (e.g. intentional negative-path logs). */
  allowPrefixes?: string[];
}) {
  const errors: string[] = [];
  const allowPrefixes = options?.allowPrefixes ?? [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    const line = args
      .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
      .join(' ');
    if (!allowPrefixes.some((prefix) => line.includes(prefix))) {
      errors.push(line);
    }
    originalError.apply(console, args as Parameters<typeof console.error>);
  };
  return {
    errors,
    restore() {
      console.error = originalError;
    },
    assertClean() {
      if (errors.length > 0) {
        throw new Error(
          `Unexpected error-level server output (${errors.length}):\n${errors.join('\n')}`,
        );
      }
    },
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Start an MCP server for tests.
 * Bind with `port: 0` (OS-assigned ephemeral) — do not pick a random port in a
 * fixed range; parallel Vitest workers collide there (CI EADDRINUSE / NOT-47).
 */
export async function startMcpServer(
  backendUrl: string,
  profile: McpToolProfile = 'standard',
): Promise<{ port: number; server: AgentDeckMCPServer }> {
  const server = new AgentDeckMCPServer(0, backendUrl, profile);
  await server.start();
  const port = server.getPort();
  if (!port || port <= 0) {
    await server.stop();
    throw new Error('MCP server started but did not expose a listening port');
  }
  await waitForMcpHealth(port);
  return { port, server };
}

async function waitForTrustedSession(
  port: number,
  sessionId: string,
  id: number,
  extraHeaders?: Record<string, string>,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await callToolMcpResult(
      port,
      sessionId,
      'get_bound_deck',
      {},
      id + 100 + attempt,
      extraHeaders,
    );
    if (!result.isError || result.data.error_code !== 'GRANT_REQUIRED') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Trusted MCP session not ready after initialize');
}

export async function openSession(
  port: number,
  id = 1,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const init = await postInitialize(port, id, 'vitest', extraHeaders);
  const sessionId = init.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new Error(`Missing mcp-session-id (status=${init.status})`);
  }
  if (extraHeaders) {
    await waitForTrustedSession(port, sessionId, id, extraHeaders);
  }
  return sessionId;
}
