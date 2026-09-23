/**
 * Canonical Agent Deck MCP connection endpoint for MCP client configuration.
 *
 * The endpoint is derived from the configured public/base origin of the
 * current environment (the origin serving the dashboard), plus the MCP path —
 * the same scheme/host/port-then-path construction used by Agent Deck
 * connection configuration (`http(s)://{host}[:port]/mcp`). Never hardcode a
 * localhost origin here: it goes stale outside local dev and is unreachable
 * from other machines.
 */
export const MCP_PATH = "/mcp";

export function buildMcpEndpointUrl(baseOrigin: string = window.location.origin): string {
  return `${baseOrigin.replace(/\/+$/, "")}${MCP_PATH}`;
}
