/**
 * Host-side session id for status-line self-match (NOT-513).
 *
 * Claude Code sets `CLAUDE_CODE_SESSION_ID` for every child it spawns — MCP
 * servers (observed: fresh UUID per session, 2.1.307) as well as the status
 * line command — so the bridge and the status line can both read the same
 * id for the same Claude session. The value is display-routing metadata
 * only: it never selects a deck, grants access, or participates in auth.
 */

/** Environment variable Claude Code sets for its session children. */
export const CLAUDE_CODE_SESSION_ID_ENV_VAR = 'CLAUDE_CODE_SESSION_ID';

/** Trimmed non-empty host session id, or undefined when absent/blank. */
export function resolveHostSessionId(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[CLAUDE_CODE_SESSION_ID_ENV_VAR];
  const id = typeof raw === 'string' ? raw.trim() : '';
  return id || undefined;
}
