import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RUN_CLAUDE_NOT_INSTALLED_ERROR,
  RUN_CLAUDE_NOT_SIGNED_IN_ERROR,
  claudeAuthStatusShowsLogin,
  defaultClaudeClientProbe,
  findExecutableOnPath,
  runRunCommand,
  type ClaudeClientStatus,
  type RunDeps,
  type RunQueryMessage,
} from './run';

const DECK = { id: 'deck-planner', name: 'planner' };

const tmpDirs: string[] = [];
let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    errors.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function successMessages(): RunQueryMessage[] {
  return [{ type: 'result', subtype: 'success', session_id: 'ses_1', result: 'done' }];
}

function makeDeps(
  cwd: string,
  homeDir: string,
  claudeProbe: () => Promise<ClaudeClientStatus>,
): RunDeps & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async function* (): AsyncGenerator<RunQueryMessage> {
    yield* successMessages();
  });
  return {
    query,
    resolveDeck: vi.fn(async (ref: string) =>
      ref === DECK.name || ref === DECK.id ? { ...DECK } : null,
    ),
    resolveLaunchPlan: vi.fn(async () => ({
      workspaceRoot: cwd,
      mcpUrl: 'http://127.0.0.1:1110/mcp',
      deckId: DECK.id,
      deckName: DECK.name,
      headers: [],
    })) as unknown as RunDeps['resolveLaunchPlan'],
    claudeProbe,
    homeDir,
  };
}

function baseArgs(cwd: string, extra: string[] = []): string[] {
  return ['planner', '--client', 'claude', '--cwd', cwd, '--prompt', 'one-line brief', ...extra];
}

/** Run `fn` with `process.env` overridden; every touched var is restored after. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    const value = vars[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** An executable `claude` stub in `dir` running `script` (proves PATH/exec behavior). */
function stubClaude(dir: string, script: string): void {
  const stub = path.join(dir, 'claude');
  fs.writeFileSync(stub, `#!/bin/sh\n${script}\n`, 'utf8');
  fs.chmodSync(stub, 0o755);
}

describe('run Claude Code preflight (NOT-405)', () => {
  it.each([
    ['not installed', { ok: false, reason: 'not-installed' } as const, RUN_CLAUDE_NOT_INSTALLED_ERROR],
    ['not signed in', { ok: false, reason: 'not-signed-in' } as const, RUN_CLAUDE_NOT_SIGNED_IN_ERROR],
  ])(
    'a %s client exits non-zero with the one-line remedy and no model call',
    async (_label, status, message) => {
      const cwd = makeDir('agent-deck-preflight-cwd-');
      const homeDir = makeDir('agent-deck-preflight-home-');
      const deps = makeDeps(cwd, homeDir, async () => status);

      const code = await runRunCommand(baseArgs(cwd), deps);

      expect(code).not.toBe(0);
      expect(deps.query).not.toHaveBeenCalled();
      expect(errors).toEqual([message]);
      expect(message).not.toContain('\n');
      expect(message).toContain('claude auth login');
      expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
    },
  );

  it('a failing probe fails the --detach starter before it spawns', async () => {
    const cwd = makeDir('agent-deck-preflight-cwd-');
    const homeDir = makeDir('agent-deck-preflight-home-');
    const spawnFn = vi.fn();
    const deps = {
      ...makeDeps(cwd, homeDir, async () => ({ ok: false as const, reason: 'not-signed-in' as const })),
      spawnFn,
      cliEntry: '/fake/bin.js',
    };

    const code = await runRunCommand(baseArgs(cwd, ['--detach']), deps);

    expect(code).not.toBe(0);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(errors).toEqual([RUN_CLAUDE_NOT_SIGNED_IN_ERROR]);
  });

  it('deck errors still win over the client probe (probe never runs)', async () => {
    const cwd = makeDir('agent-deck-preflight-cwd-');
    const homeDir = makeDir('agent-deck-preflight-home-');
    const claudeProbe = vi.fn(async (): Promise<ClaudeClientStatus> => ({ ok: true }));
    const deps = makeDeps(cwd, homeDir, claudeProbe);

    const code = await runRunCommand(
      baseArgs(cwd).map((arg) => (arg === 'planner' ? 'nope' : arg)),
      deps,
    );

    expect(code).not.toBe(0);
    expect(claudeProbe).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/Deck not found/);
  });

  it('a passing probe runs once on the happy path', async () => {
    const cwd = makeDir('agent-deck-preflight-cwd-');
    const homeDir = makeDir('agent-deck-preflight-home-');
    const claudeProbe = vi.fn(async (): Promise<ClaudeClientStatus> => ({ ok: true }));
    const deps = makeDeps(cwd, homeDir, claudeProbe);

    expect(await runRunCommand(baseArgs(cwd), deps)).toBe(0);

    expect(claudeProbe).toHaveBeenCalledTimes(1);
    expect(deps.query).toHaveBeenCalledTimes(1);
  });

  it('without an injected probe the default probe guards the run (missing binary)', async () => {
    const cwd = makeDir('agent-deck-preflight-cwd-');
    const homeDir = makeDir('agent-deck-preflight-home-');
    const empty = makeDir('agent-deck-preflight-empty-');
    const query = vi.fn(async function* (): AsyncGenerator<RunQueryMessage> {
      yield* successMessages();
    });
    const deps: RunDeps = {
      query,
      resolveDeck: async () => ({ ...DECK }),
      resolveLaunchPlan: (async () => ({
        workspaceRoot: cwd,
        mcpUrl: 'http://127.0.0.1:1110/mcp',
        deckId: DECK.id,
        deckName: DECK.name,
        headers: [],
      })) as unknown as RunDeps['resolveLaunchPlan'],
      homeDir,
    };

    await withEnv({ PATH: empty, ANTHROPIC_API_KEY: undefined }, async () => {
      expect(await runRunCommand(baseArgs(cwd), deps)).not.toBe(0);
    });

    expect(query).not.toHaveBeenCalled();
    expect(errors).toEqual([RUN_CLAUDE_NOT_INSTALLED_ERROR]);
  });
});

describe('claude auth status parsing (NOT-405)', () => {
  it('accepts only loggedIn: true', () => {
    expect(claudeAuthStatusShowsLogin('{"loggedIn": true}')).toBe(true);
    expect(claudeAuthStatusShowsLogin('{"loggedIn": true, "email": "a@b.c"}')).toBe(true);
  });

  it('reads logged-out, garbage, and empty output as signed out', () => {
    expect(claudeAuthStatusShowsLogin('{"loggedIn": false}')).toBe(false);
    expect(claudeAuthStatusShowsLogin('{}')).toBe(false);
    expect(claudeAuthStatusShowsLogin('')).toBe(false);
    expect(claudeAuthStatusShowsLogin('not json at all')).toBe(false);
  });
});

describe('findExecutableOnPath (NOT-405)', () => {
  it('finds an executable and skips empty PATH segments', () => {
    const bin = makeDir('agent-deck-preflight-bin-');
    stubClaude(bin, 'exit 0');

    expect(findExecutableOnPath('claude', `:${bin}:`)).toBe(path.join(bin, 'claude'));
    expect(findExecutableOnPath('claude', '')).toBeNull();
    expect(findExecutableOnPath('missing-tool', bin)).toBeNull();
  });
});

describe('defaultClaudeClientProbe (NOT-405)', () => {
  it('reports not-installed when no claude is on PATH', async () => {
    const empty = makeDir('agent-deck-preflight-empty-');

    await withEnv({ PATH: empty, ANTHROPIC_API_KEY: undefined }, async () => {
      expect(await defaultClaudeClientProbe()).toEqual({ ok: false, reason: 'not-installed' });
    });
  });

  it('passes logged-in stubs and fails logged-out ones', async () => {
    const bin = makeDir('agent-deck-preflight-bin-');

    stubClaude(bin, `echo '{"loggedIn": true}'`);
    await withEnv({ PATH: bin, ANTHROPIC_API_KEY: undefined }, async () => {
      expect(await defaultClaudeClientProbe()).toEqual({ ok: true });
    });

    stubClaude(bin, `echo '{"loggedIn": false}'`);
    await withEnv({ PATH: bin, ANTHROPIC_API_KEY: undefined }, async () => {
      expect(await defaultClaudeClientProbe()).toEqual({ ok: false, reason: 'not-signed-in' });
    });
  });

  it('reads a crashed or garbage-talking claude as not signed in', async () => {
    const bin = makeDir('agent-deck-preflight-bin-');

    stubClaude(bin, 'exit 3');
    await withEnv({ PATH: bin, ANTHROPIC_API_KEY: undefined }, async () => {
      expect(await defaultClaudeClientProbe()).toEqual({ ok: false, reason: 'not-signed-in' });
    });

    stubClaude(bin, `echo 'this is not json'`);
    await withEnv({ PATH: bin, ANTHROPIC_API_KEY: undefined }, async () => {
      expect(await defaultClaudeClientProbe()).toEqual({ ok: false, reason: 'not-signed-in' });
    });
  });

  it('passes with ANTHROPIC_API_KEY set without executing claude', async () => {
    const bin = makeDir('agent-deck-preflight-bin-');
    // If the probe executed the stub it would fail: passing proves it never ran.
    stubClaude(bin, 'exit 3');

    await withEnv({ PATH: bin, ANTHROPIC_API_KEY: 'test-key-not-a-secret' }, async () => {
      expect(await defaultClaudeClientProbe()).toEqual({ ok: true });
    });
  });
});
