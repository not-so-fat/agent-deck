/**
 * Default ports for `agent-deck start` / npx install.
 *
 * Dev repo (`npm run dev:all`) keeps 8000 / 3001 so both can run on one machine.
 * Override with AGENT_DECK_PORT / AGENT_DECK_MCP_PORT.
 */
export const CLI_DEFAULT_BACKEND_PORT = 1111;
export const CLI_DEFAULT_MCP_PORT = 1110;

export function parseCliBackendPort(value: string | undefined): number {
  if (!value) {
    return CLI_DEFAULT_BACKEND_PORT;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : CLI_DEFAULT_BACKEND_PORT;
}

/** Env override for API/dashboard port (`AGENT_DECK_BACKEND_PORT` wins over `AGENT_DECK_PORT`). */
export function resolveCliBackendPortEnv(): string | undefined {
  return process.env.AGENT_DECK_BACKEND_PORT ?? process.env.AGENT_DECK_PORT;
}

export function readCliBackendPort(): number {
  return parseCliBackendPort(resolveCliBackendPortEnv());
}

export function parseCliMcpPort(value: string | undefined): number {
  if (!value) {
    return CLI_DEFAULT_MCP_PORT;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : CLI_DEFAULT_MCP_PORT;
}
