/**
 * Canonical Agent Deck MCP connection endpoint (NOT-257).
 *
 * The MCP server runs as a separate process on AGENT_DECK_MCP_PORT while the
 * dashboard/API is served from the backend port, so the client connection
 * endpoint is never derived from the dashboard origin. This module is the
 * single canonical source: `agent-deck status`, `agent-deck start`, and the
 * connection configuration all use `http://{AGENT_DECK_HOST}:{AGENT_DECK_MCP_PORT}/mcp`.
 */

export const MCP_PATH = '/mcp';
export const DEFAULT_MCP_HOST = '127.0.0.1';
export const DEFAULT_MCP_PORT = 1110;

export interface McpEndpoint {
  host: string;
  mcpPort: number;
  url: string;
}

export function resolveMcpHost(): string {
  return process.env.AGENT_DECK_HOST?.trim() || DEFAULT_MCP_HOST;
}

export function resolveMcpPort(): number {
  const parsed = Number.parseInt(process.env.AGENT_DECK_MCP_PORT ?? '', 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_MCP_PORT;
}

export function buildMcpEndpointUrl(host: string, mcpPort: number): string {
  return `http://${host}:${mcpPort}${MCP_PATH}`;
}

/** Canonical client connection endpoint for the current environment. */
export function resolveMcpEndpoint(): McpEndpoint {
  const host = resolveMcpHost();
  const mcpPort = resolveMcpPort();
  return { host, mcpPort, url: buildMcpEndpointUrl(host, mcpPort) };
}
