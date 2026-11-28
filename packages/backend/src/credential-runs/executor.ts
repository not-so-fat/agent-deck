/**
 * Daemon-side credential-run executor.
 *
 * Spawns the approved `argv` directly (`shell: false`) with a minimal
 * allowlist env plus the resolved credentials, kills the child at the
 * timeout, redacts every secret value (raw, base64, and URL-encoded) from
 * the outputs, then caps both streams. Nothing here logs: callers audit
 * metadata only, never secret values.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import { CREDENTIAL_RUN_OUTPUT_MAX_BYTES } from '@agent-deck/shared';

import { buildCredentialRunRedactor, maxCredentialRunNeedleLength } from './redact';

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

/**
 * Truncate to at most `maxBytes` UTF-8 bytes, backing up to a character
 * boundary so the cut never splits a multi-byte sequence (no replacement
 * characters, no partial code points). Pure ASCII truncates exactly.
 */
export function truncateUtf8ToBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString('utf8');
}

export async function executeCredentialRun(input: {
  argv: string[];
  cwd: string;
  timeoutSec: number;
  /** Target env name → resolved secret value. */
  secrets: Record<string, string>;
}): Promise<CredentialRunResult> {
  const secretValues = Object.values(input.secrets);
  const redact = buildCredentialRunRedactor(secretValues);
  // Redact before the final cap: buffer the cap plus one max-needle overlap
  // so a secret crossing the boundary is fully present for redaction. Any
  // secret starting before the cap ends inside the buffer by construction.
  // All accounting is UTF-8 bytes (the contract's unit); the +4 slack keeps
  // the overlap intact when the buffer cut backs up to a char boundary.
  const bufferLimit =
    CREDENTIAL_RUN_OUTPUT_MAX_BYTES + maxCredentialRunNeedleLength(secretValues) + 4;
  const child = spawn(input.argv[0], input.argv.slice(1), {
    cwd: input.cwd,
    env: buildCredentialRunEnv(input.secrets),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let stdoutBufferedBytes = 0;
  let stderrBufferedBytes = 0;
  let stdoutTotal = 0;
  let stderrTotal = 0;
  const append = (which: 'out' | 'err', chunk: string): void => {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (which === 'out') {
      stdoutTotal += chunkBytes;
      if (stdoutBufferedBytes < bufferLimit) {
        stdout += chunk;
        stdoutBufferedBytes += chunkBytes;
        if (stdoutBufferedBytes > bufferLimit) {
          stdout = truncateUtf8ToBytes(stdout, bufferLimit);
          stdoutBufferedBytes = Buffer.byteLength(stdout, 'utf8');
        }
      }
      return;
    }
    stderrTotal += chunkBytes;
    if (stderrBufferedBytes < bufferLimit) {
      stderr += chunk;
      stderrBufferedBytes += chunkBytes;
      if (stderrBufferedBytes > bufferLimit) {
        stderr = truncateUtf8ToBytes(stderr, bufferLimit);
        stderrBufferedBytes = Buffer.byteLength(stderr, 'utf8');
      }
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
    // Redact the overlap buffer first, then apply the final cap. The cut can
    // only split the [REDACTED] marker itself — never a secret — because every
    // needle crossing the cap was fully present for redaction. The cut lands
    // on a character boundary, so no partial code point survives either.
    const finalize = (buffered: string, total: number): { text: string; truncated: boolean } => {
      const redacted = redact(buffered);
      if (
        total > CREDENTIAL_RUN_OUTPUT_MAX_BYTES ||
        Buffer.byteLength(redacted, 'utf8') > CREDENTIAL_RUN_OUTPUT_MAX_BYTES
      ) {
        return {
          text: truncateUtf8ToBytes(redacted, CREDENTIAL_RUN_OUTPUT_MAX_BYTES),
          truncated: true,
        };
      }
      return { text: redacted, truncated: false };
    };
    const out = finalize(stdout, stdoutTotal);
    const err = finalize(stderr, stderrTotal);
    return {
      exitCode: timedOut ? null : exitCode,
      timedOut,
      stdout: out.text,
      stdoutTruncated: out.truncated,
      stderr: err.text,
      stderrTruncated: err.truncated,
    };
  } catch (error) {
    throw new Error(
      `credential run spawn failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
