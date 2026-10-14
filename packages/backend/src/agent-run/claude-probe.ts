/**
 * Claude Code client probe (NOT-405): the `claude` CLI must be installed and
 * signed in before any Claude run starts. Local only — no model call.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Outcome of the Claude Code client probe: installed and signed in, or why not. */
export type ClaudeClientStatus =
  | { ok: true }
  | { ok: false; reason: 'not-installed' | 'not-signed-in' };

export type ClaudeClientProbe = () => Promise<ClaudeClientStatus> | ClaudeClientStatus;

/** The one fix command both preflight remedies name. Verified against `claude auth --help`. */
export const CLAUDE_AUTH_LOGIN_COMMAND = 'claude auth login';

export const RUN_CLAUDE_NOT_INSTALLED_ERROR =
  `Claude Code is not installed (no \`claude\` on PATH). Install Claude Code, then run \`${CLAUDE_AUTH_LOGIN_COMMAND}\` to sign in, then retry.`;

export const RUN_CLAUDE_NOT_SIGNED_IN_ERROR =
  `Claude Code is not signed in. Run \`${CLAUDE_AUTH_LOGIN_COMMAND}\` to sign in with your own account, then retry.`;

/** First executable `name` on `pathEnv`, or null. Pure apart from the fs check. */
export function findExecutableOnPath(name: string, pathEnv = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep scanning.
    }
  }
  return null;
}

/**
 * True only when `claude auth status` JSON reports a login. Never throws:
 * garbage, an empty string, or a logged-out report all read as signed out.
 */
export function claudeAuthStatusShowsLogin(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Default Claude Code preflight: the `claude` CLI must be on PATH and
 * `claude auth status` must report a login. Local only — no model call.
 * An explicit ANTHROPIC_API_KEY passes without the OAuth check once the
 * `claude` CLI is found on PATH (API-key onboarding stays out of scope;
 * the friend path signs in via `claude auth login`). Any other failure —
 * logged out, unparseable output, a hung or crashed `claude` — reads as
 * not signed in; re-running the login is the remedy in every case.
 */
export async function defaultClaudeClientProbe(): Promise<ClaudeClientStatus> {
  const claudePath = findExecutableOnPath('claude');
  if (!claudePath) {
    return { ok: false, reason: 'not-installed' };
  }
  if ((process.env.ANTHROPIC_API_KEY ?? '').trim()) {
    return { ok: true };
  }
  try {
    const out = execFileSync(claudePath, ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return claudeAuthStatusShowsLogin(out)
      ? { ok: true }
      : { ok: false, reason: 'not-signed-in' };
  } catch (error) {
    // The binary vanished between the PATH scan and the exec.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: false, reason: 'not-installed' };
    }
    return { ok: false, reason: 'not-signed-in' };
  }
}
