/**
 * Daemon-side credential-run executor.
 *
 * Spawns the approved `argv` directly (`shell: false`) with a minimal
 * allowlist env plus the resolved credentials, kills the child at the
 * timeout, caps both output streams, and redacts every secret value (raw,
 * base64, and URL-encoded) from the outputs before they leave this module.
 * Nothing here logs: callers audit metadata only, never secret values.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import { CREDENTIAL_RUN_OUTPUT_MAX_BYTES } from '@agent-deck/shared';

import { buildCredentialRunRedactor } from './redact';

/**
 * The only daemon env vars a credential-run child ever sees. Everything
 * else — `AGENT_DECK_VAULT_KEY`, `AGENT_DECK_ADMIN_SECRET`, and every other
 * daemon-only variable — is never copied.
 */
export const CREDENTIAL_RUN_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TZ',
] as const;

/** Minimal child env: allowlisted daemon vars plus the resolved credentials. */
export function buildCredentialRunEnv(
  secrets: Record<string, string>,
  daemonEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CREDENTIAL_RUN_ENV_ALLOWLIST) {
    const value = daemonEnv[name];
    if (typeof value === 'string' && value.length > 0) {
      env[name] = value;
    }
  }
  if (!env.PATH) {
    env.PATH = '/usr/bin:/bin';
  }
  for (const [name, value] of Object.entries(secrets)) {
    env[name] = value;
  }
  // Belt and braces: a future allowlist edit must never leak daemon secrets.
  for (const name of Object.keys(env)) {
    if (name.startsWith('AGENT_DECK_')) {
      delete env[name];
    }
  }
  return env;
}

/**
 * Resolve the requested cwd against the session's bound workspace. The
 * workspace itself is the default; anything resolving outside it is rejected.
 */
export function resolveCredentialRunCwd(cwd: string | undefined, workspaceRoot: string): string {
  const base = path.resolve(workspaceRoot);
  if (cwd === undefined || cwd.trim() === '') {
    return base;
  }
  const resolved = path.resolve(base, cwd);
  const relative = path.relative(base, resolved);
  if (relative === '') {
    return resolved;
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('cwd must resolve inside the session workspace');
  }
  return resolved;
}

export type CredentialRunResult = {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
};

export async function executeCredentialRun(input: {
  argv: string[];
  cwd: string;
  timeoutSec: number;
  /** Target env name → resolved secret value. */
  secrets: Record<string, string>;
}): Promise<CredentialRunResult> {
  const redact = buildCredentialRunRedactor(Object.values(input.secrets));
  const child = spawn(input.argv[0], input.argv.slice(1), {
    cwd: input.cwd,
    env: buildCredentialRunEnv(input.secrets),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const append = (which: 'out' | 'err', chunk: string): void => {
    if (which === 'out') {
      if (stdoutTruncated) {
        return;
      }
      stdout += chunk;
      if (stdout.length > CREDENTIAL_RUN_OUTPUT_MAX_BYTES) {
        stdout = stdout.slice(0, CREDENTIAL_RUN_OUTPUT_MAX_BYTES);
        stdoutTruncated = true;
      }
      return;
    }
    if (stderrTruncated) {
      return;
    }
    stderr += chunk;
    if (stderr.length > CREDENTIAL_RUN_OUTPUT_MAX_BYTES) {
      stderr = stderr.slice(0, CREDENTIAL_RUN_OUTPUT_MAX_BYTES);
      stderrTruncated = true;
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => append('out', chunk));
  child.stderr?.on('data', (chunk: string) => append('err', chunk));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, input.timeoutSec * 1000);
  timer.unref?.();

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });
    return {
      exitCode: timedOut ? null : exitCode,
      timedOut,
      stdout: redact(stdout),
      stdoutTruncated,
      stderr: redact(stderr),
      stderrTruncated,
    };
  } catch (error) {
    throw new Error(
      `credential run spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
