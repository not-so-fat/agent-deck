/**
 * Daemon-only secrets (vault master key, admin/bootstrap/OAuth client secrets)
 * must not reach any process launched for a run: adapter spawns, the Claude
 * SDK subprocess env, and client preflight probes. Uses a fake marker value
 * only — never a real secret.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClaudeAdapter, type RunQueryOptions } from './claude';
import { createCodexAdapter, defaultCodexProbe } from './codex';
import { createCursorAdapter, defaultCursorProbe } from './cursor';
import { createMuseAdapter, defaultMuseProbe } from './muse';
import { DAEMON_ONLY_SECRET_ENV_VARS, workerEnv } from './worker-env';

const MARKER = 'fake-marker-not-a-secret';
const KEPT = 'AGENT_DECK_TEST_KEPT_VAR';
// Fake worker token: start() requires one; never a real token.
const RUN_TOKEN = 't'.repeat(64);
const START = { cwd: '/tmp', prompt: 'hi', tools: 'readonly', runToken: RUN_TOKEN } as const;

function scratchDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function emptyLines(): AsyncIterable<string> {
  return (async function* (): AsyncGenerator<string> {})();
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _event of stream) {
      // consume
    }
  } catch {
    // Fake children carry no valid client output — expected here.
  }
}

function expectScrubbed(env: NodeJS.ProcessEnv | Record<string, string> | undefined): void {
  // An absent env would mean "inherit process.env" — i.e. the leak.
  // Assertions compare names/booleans only so a failure never prints values.
  expect(env === undefined).toBe(false);
  const names = Object.keys(env ?? {});
  expect(names.filter((n) => (DAEMON_ONLY_SECRET_ENV_VARS as readonly string[]).includes(n))).toEqual([]);
  expect(Object.values(env ?? {}).includes(MARKER)).toBe(false);
  // Full copy, not an allowlist: ordinary inherited vars survive.
  expect(env?.[KEPT] === 'kept').toBe(true);
  expect(env?.PATH === process.env.PATH).toBe(true);
}

describe('workerEnv strips daemon-only secrets from run children', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of [...DAEMON_ONLY_SECRET_ENV_VARS, KEPT]) {
      saved[name] = process.env[name];
      process.env[name] = name === KEPT ? 'kept' : MARKER;
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('denylists the vault key and returns a full copy otherwise', () => {
    expect(DAEMON_ONLY_SECRET_ENV_VARS).toContain('AGENT_DECK_VAULT_KEY');
    expectScrubbed(workerEnv());
    // The daemon's own env is untouched.
    expect(process.env.AGENT_DECK_VAULT_KEY).toBe(MARKER);
  });

  it('codex spawn gets the scrubbed env', async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const adapter = createCodexAdapter({
      spawn: (_bin, _argv, opts) => {
        seen.push(opts.env);
        return { stdout: emptyLines(), wait: async () => ({ code: 0, stderrTail: '' }) };
      },
      isGitRepo: () => true,
    });
    await drain(adapter.start({ ...START }));
    expect(seen).toHaveLength(1);
    expectScrubbed(seen[0]);
  });

  it('cursor spawn gets the scrubbed env', async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const fakeHome = scratchDir('worker-env-test-home-');
    const adapter = createCursorAdapter({
      homedir: () => fakeHome,
      makeWorkerHome: () => scratchDir('worker-env-test-cursor-'),
      readFile: () => null,
      spawn: (_bin, _argv, opts) => {
        seen.push(opts.env);
        return { stdout: emptyLines(), wait: async () => ({ code: 0, stderrTail: '' }) };
      },
    });
    await drain(adapter.start({ ...START }));
    expect(seen).toHaveLength(1);
    expectScrubbed(seen[0]);
  });

  it('muse spawn gets the scrubbed env', async () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const adapter = createMuseAdapter({
      makeWorkerConfig: () => scratchDir('worker-env-test-muse-'),
      readFile: () => null,
      spawn: (_bin, _argv, opts) => {
        seen.push(opts.env);
        return {
          stdout: emptyLines(),
          stderr: emptyLines(),
          wait: async () => ({ code: 0, stderrTail: '' }),
        };
      },
    });
    await drain(adapter.start({ ...START }));
    expect(seen).toHaveLength(1);
    expectScrubbed(seen[0]);
  });

  it('claude passes a full scrubbed options.env (the SDK replaces, not merges)', async () => {
    const seen: RunQueryOptions[] = [];
    const adapter = createClaudeAdapter({
      query: (params) => {
        seen.push(params.options);
        return (async function* () {
          yield { type: 'result', subtype: 'success', session_id: 'ses_1', result: 'ok' };
        })();
      },
    });
    await drain(adapter.start({ ...START }));
    expect(seen).toHaveLength(1);
    expectScrubbed(seen[0].env);
  });

  it.each([
    ['codex', defaultCodexProbe],
    ['cursor', defaultCursorProbe],
    ['muse', defaultMuseProbe],
  ] as const)('%s default preflight probe child does not see the secrets', (_name, probe) => {
    // Runs the current node binary as a stand-in client: it prints which
    // denylisted names it can see (names only, never values).
    const script = `process.stdout.write(JSON.stringify(${JSON.stringify(
      [...DAEMON_ONLY_SECRET_ENV_VARS, KEPT],
    )}.filter((n) => n in process.env)))`;
    const result = probe(process.execPath, ['-e', script]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([KEPT]);
  });
});
