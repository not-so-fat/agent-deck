/**
 * The ports a real `agent-deck start` uses. Mirrored here because the vitest
 * setup is plain ESM and cannot import the CLI's TypeScript source; kept in
 * sync with packages/cli/src/defaults.ts, which a test asserts.
 */
export const CLI_DEFAULT_BACKEND_PORT = 1111;
export const CLI_DEFAULT_MCP_PORT = 1110;
