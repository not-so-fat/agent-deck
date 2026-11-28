import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CREDENTIAL_RUN_OUTPUT_MAX_BYTES } from '@agent-deck/shared';

import {
  buildCredentialRunEnv,
  executeCredentialRun,
  resolveCredentialRunCwd,
} from './executor';
import { CREDENTIAL_RUN_REDACTED } from './redact';

const NODE = process.execPath;

/** Fake executable: prints its argv and selected env as JSON on stdout. Secrets are checked inside the child (booleans) so delivery is proven without echoing values. */
const PRINT_ARGV_ENV = `console.log(JSON.stringify({ argv: process.argv.slice(1), env: { HF_OK: process.env.HF_TOKEN === 'fake-secret-1', DEFAULT_OK: process.env.DEFAULT_NAME === 'fake-secret-2', PATH: typeof process.env.PATH, VAULT: process.env.AGENT_DECK_VAULT_KEY, ADMIN: process.env.AGENT_DECK_ADMIN_SECRET, BOOTSTRAP: process.env.AGENT_DECK_OWNER_BOOTSTRAP_SECRET, SLACK: process.env.AGENT_DECK_SLACK_CLIENT_SECRET, MARKER: process.env.AGENT_DECK_TEST_MARKER } }))`;

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-credential-run-'));
}

describe('credential-run executor', () => {
  it('maps aliases, defaults to envName, and delivers argv exactly (no shell)', async () => {
    const workspace = makeWorkspace();
    const argv = [
      '-e',
      PRINT_ARGV_ENV,
      'plain',
      'a;b',
      '$(touch /tmp/pwned)',
      '*',
      'quote"inside',
      "--flag=value with space",
      '`backtick`',
    ];
    const result = await executeCredentialRun({
      argv: [NODE, ...argv],
      cwd: resolveCredentialRunCwd(undefined, workspace),
      timeoutSec: 30,
      secrets: { HF_TOKEN: 'fake-secret-1', DEFAULT_NAME: 'fake-secret-2' },
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    const printed = JSON.parse(result.stdout) as { argv: string[]; env: Record<string, unknown> };
    expect(printed.argv).toEqual(argv.slice(2));
    expect(printed.env.HF_OK).toBe(true);
    expect(printed.env.DEFAULT_OK).toBe(true);
  });

  it('redacts raw, base64, and URL-encoded secrets from stdout and stderr', async () => {
    const workspace = makeWorkspace();
    const secret = 's3cret v@lue/with?chars&more';
    const script =
      `const s = process.env.HF_TOKEN;` +
      `console.log('raw=' + s);` +
      `console.log('b64=' + Buffer.from(s, 'utf8').toString('base64'));` +
      `console.log('url=' + encodeURIComponent(s));` +
      `console.error('err-raw=' + s);` +
      `console.error('err-b64=' + Buffer.from(s, 'utf8').toString('base64'));`;
    const result = await executeCredentialRun({
      argv: [NODE, '-e', script],
      cwd: resolveCredentialRunCwd(undefined, workspace),
      timeoutSec: 30,
      secrets: { HF_TOKEN: secret },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    expect(result.stdout).not.toContain(Buffer.from(secret, 'utf8').toString('base64'));
    expect(result.stdout).not.toContain(encodeURIComponent(secret));
    expect(result.stdout).toContain(`raw=${CREDENTIAL_RUN_REDACTED}`);
    expect(result.stdout).toContain(`b64=${CREDENTIAL_RUN_REDACTED}`);
    expect(result.stdout).toContain(`url=${CREDENTIAL_RUN_REDACTED}`);
    expect(result.stderr).toContain(`err-raw=${CREDENTIAL_RUN_REDACTED}`);
    expect(result.stderr).toContain(`err-b64=${CREDENTIAL_RUN_REDACTED}`);
  });

  it('keeps daemon secrets and unrelated daemon env out of the child env', async () => {
    const workspace = makeWorkspace();
    const saved = new Map<string, string | undefined>();
    const daemonVars: Record<string, string> = {
      AGENT_DECK_VAULT_KEY: 'vault-key-value',
      AGENT_DECK_ADMIN_SECRET: 'admin-secret-value',
      AGENT_DECK_OWNER_BOOTSTRAP_SECRET: 'bootstrap-value',
      AGENT_DECK_SLACK_CLIENT_SECRET: 'slack-value',
      AGENT_DECK_TEST_MARKER: 'marker-value',
    };
    try {
      for (const [name, value] of Object.entries(daemonVars)) {
        saved.set(name, process.env[name]);
        process.env[name] = value;
      }
      const result = await executeCredentialRun({
        argv: [NODE, '-e', PRINT_ARGV_ENV],
        cwd: resolveCredentialRunCwd(undefined, workspace),
        timeoutSec: 30,
        secrets: { HF_TOKEN: 'fake-secret-1' },
      });
      expect(result.exitCode).toBe(0);
      const printed = JSON.parse(result.stdout) as { env: Record<string, unknown> };
      expect(printed.env.VAULT).toBeUndefined();
      expect(printed.env.ADMIN).toBeUndefined();
      expect(printed.env.BOOTSTRAP).toBeUndefined();
      expect(printed.env.SLACK).toBeUndefined();
      expect(printed.env.MARKER).toBeUndefined();
      // Allowlisted vars still pass through.
      expect(printed.env.PATH).toBe('string');
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it('buildCredentialRunEnv strips AGENT_DECK_* even when injected as secrets', () => {
    const env = buildCredentialRunEnv(
      { AGENT_DECK_VAULT_KEY: 'smuggled', HF_TOKEN: 'fake-secret-1' },
      { PATH: '/usr/bin', AGENT_DECK_ADMIN_SECRET: 'daemon' },
    );
    expect(env.HF_TOKEN).toBe('fake-secret-1');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.AGENT_DECK_VAULT_KEY).toBeUndefined();
    expect(env.AGENT_DECK_ADMIN_SECRET).toBeUndefined();
  });

  it('rejects a cwd outside the workspace', () => {
    const workspace = makeWorkspace();
    expect(resolveCredentialRunCwd(undefined, workspace)).toBe(path.resolve(workspace));
    expect(resolveCredentialRunCwd('.', workspace)).toBe(path.resolve(workspace));
    expect(() => resolveCredentialRunCwd('..', workspace)).toThrow(/inside the session workspace/);
    expect(() => resolveCredentialRunCwd('../escape', workspace)).toThrow(/inside the session workspace/);
    expect(() => resolveCredentialRunCwd('/etc', workspace)).toThrow(/inside the session workspace/);
    expect(() => resolveCredentialRunCwd('/tmp', workspace)).toThrow(/inside the session workspace/);
  });

  it('kills a long-running child at the timeout', async () => {
    const workspace = makeWorkspace();
    const startedAt = Date.now();
    const result = await executeCredentialRun({
      argv: [NODE, '-e', 'setTimeout(() => {}, 30000)'],
      cwd: resolveCredentialRunCwd(undefined, workspace),
      timeoutSec: 1,
      secrets: { HF_TOKEN: 'fake-secret-1' },
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(15000);
  });

  it('caps each stream at 64 KiB with a truncated flag', async () => {
    const workspace = makeWorkspace();
    const result = await executeCredentialRun({
      argv: [NODE, '-e', `console.log('x'.repeat(70000)); console.error('y'.repeat(70000))`],
      cwd: resolveCredentialRunCwd(undefined, workspace),
      timeoutSec: 30,
      secrets: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(result.stdout.length).toBe(CREDENTIAL_RUN_OUTPUT_MAX_BYTES);
    expect(result.stderr.length).toBe(CREDENTIAL_RUN_OUTPUT_MAX_BYTES);
  });

  it('passes the exit code through', async () => {
    const workspace = makeWorkspace();
    const result = await executeCredentialRun({
      argv: [NODE, '-e', 'process.exit(3)'],
      cwd: resolveCredentialRunCwd(undefined, workspace),
      timeoutSec: 30,
      secrets: {},
    });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });
});
