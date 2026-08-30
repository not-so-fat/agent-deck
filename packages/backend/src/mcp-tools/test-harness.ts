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
  grantSecret?: string,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: MCP_ACCEPT,
  };
  if (grantSecret) {
    headers.Authorization = `Bearer ${grantSecret}`;
  }
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(initializePayload(id, clientName)),
  });
}

export async function listTools(port: number, sessionId: string, id: number) {
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
): Promise<McpToolCallResult> {
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
) {
  const result = await callToolMcpResult(port, sessionId, name, args, id);
  if (result.isError) {
    throw new Error(JSON.stringify(result.data));
  }
  return result.data;
}

export async function startMcpServer(
  backendUrl: string,
  profile: McpToolProfile = 'standard',
): Promise<{ port: number; server: AgentDeckMCPServer }> {
  const port = 36_000 + Math.floor(Math.random() * 3_000);
  const server = new AgentDeckMCPServer(port, backendUrl, profile);
  await server.start();
  await waitForMcpHealth(port);
  return { port, server };
}

async function waitForTrustedSession(
  port: number,
  sessionId: string,
  id: number,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await callToolMcpResult(port, sessionId, 'get_bound_deck', {}, id + 100 + attempt);
    if (!result.isError || result.data.error_code !== 'GRANT_REQUIRED') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Trusted MCP session not ready after initialize');
}

export async function openSession(port: number, id = 1, grantSecret?: string): Promise<string> {
  const init = await postInitialize(port, id, 'vitest', grantSecret);
  const sessionId = init.headers.get('mcp-session-id');
  if (!sessionId) {
    throw new Error('Missing mcp-session-id');
  }
  if (grantSecret) {
    await waitForTrustedSession(port, sessionId, id);
  }
  return sessionId;
}
