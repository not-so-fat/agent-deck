/**
 * Daemon-only secrets that must never reach a process the daemon launches on
 * an agent's behalf (start_run workers, client preflight probes, `exec`
 * children, local MCP servers). A short explicit denylist, not an allowlist:
 * every other inherited variable (PATH, HOME, client auth such as
 * ANTHROPIC_API_KEY / META_API_KEY, ...) still passes through unchanged.
 *
 * This only removes the secrets from the child's environment. It does not
 * stop a same-OS-user child from reading the files they came from.
 */
export const DAEMON_ONLY_SECRET_ENV_VARS = [
  // Vault master key (vault/encrypted-file-secret-store.ts VAULT_KEY_ENV_VAR).
  'AGENT_DECK_VAULT_KEY',
  // Owner admin secret (trusted-session/admin-secret.ts, cli/admin-secret.ts).
  'AGENT_DECK_ADMIN_SECRET',
  // Hosted owner bootstrap secret (server/index.ts).
  'AGENT_DECK_OWNER_BOOTSTRAP_SECRET',
  // Shared OAuth app client secret (config/shared-oauth-apps.ts).
  'AGENT_DECK_SLACK_CLIENT_SECRET',
] as const;

/**
 * A full copy of `base` (default `process.env`) minus the daemon-only
 * secrets. Always a complete env: callers pass it as `env`, which REPLACES
 * the child environment (node spawn and the Claude Agent SDK alike).
 */
export function workerEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const name of DAEMON_ONLY_SECRET_ENV_VARS) {
    delete env[name];
  }
  return env;
}
