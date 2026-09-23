/**
 * Canonical Agent Deck MCP connection endpoint for MCP client configuration
 * (NOT-257).
 *
 * The endpoint is the backend's canonical connection configuration
 * (`GET /api/mcp/endpoint`), built from AGENT_DECK_HOST / AGENT_DECK_MCP_PORT
 * — the MCP server origin. It is never derived from the dashboard/browser
 * origin: the dashboard is served from a different port and nothing proxies
 * /mcp there. Copy this value verbatim: no labels, no surrounding text.
 */

export const MCP_PATH = '/mcp';

/** Backend route serving the canonical MCP connection endpoint. */
export const MCP_ENDPOINT_API_PATH = '/api/mcp/endpoint';

export interface McpEndpoint {
  host: string;
  mcpPort: number;
}

/** Same scheme/host/port-then-path construction as the backend canonical source. */
export function buildMcpEndpointUrl(host: string, mcpPort: number): string {
  return `http://${host.trim()}:${mcpPort}${MCP_PATH}`;
}

export interface McpEndpointResponse {
  success: boolean;
  data?: { url?: unknown };
  error?: string;
}

/** Fetch the canonical MCP connection endpoint for the current environment. */
export async function fetchMcpEndpointUrl(): Promise<string> {
  const response = await fetch(MCP_ENDPOINT_API_PATH, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`MCP endpoint request failed: ${response.status}`);
  }
  const body = (await response.json()) as McpEndpointResponse;
  const url = body?.data?.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('MCP endpoint response did not include a URL');
  }
  return url;
}

type ToastFn = (args: { title: string; description: string; variant?: 'destructive' }) => void;

/**
 * Copy interaction for "Get MCP URL" (NOT-257).
 *
 * Copies the canonical endpoint verbatim — no labels, no surrounding text —
 * then shows that same value in the success feedback so the displayed URL
 * always agrees with the clipboard.
 */
export async function copyMcpEndpointToClipboard(showToast: ToastFn): Promise<void> {
  try {
    const mcpUrl = await fetchMcpEndpointUrl();
    await navigator.clipboard.writeText(mcpUrl);
    showToast({
      title: 'MCP URL copied!',
      description: mcpUrl,
    });
  } catch (error) {
    showToast({
      title: 'Failed to copy MCP URL',
      description: error instanceof Error ? error.message : 'Unknown error',
      variant: 'destructive',
    });
  }
}
