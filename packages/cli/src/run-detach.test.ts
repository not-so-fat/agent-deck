import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeAssignment } from './assignment';
import {
  CLI_ENTRY,
  CLI_PACKAGE,
  assertFreshBuild,
  isAlive,
  waitUntil,
} from './cli-integration-harness';
import {
  RUN_EDIT_TOOLS,
  RUN_READONLY_TOOLS,
  parseRunArgs,
  printRunHelp,
  runRunCommand,
  type RunDeps,
  type RunMeta,
  type RunOptions,
} from './run';
import {
  buildDetachedChildArgs,
  startDetachedRun,
  type DetachedStarterDeps,
} from './run-detach';

const DECK = { id: 'deck-detach', name: 'detach' };

const tmpDirs: string[] = [];
const childPids: number[] = [];
const starters: ChildProcess[] = [];
let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    errors.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const starter of starters.splice(0)) {
    try {
      starter.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const pid of childPids.splice(0)) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

describe('run --detach arg handling (NOT-401)', () => {
  it('parses --detach and defaults it to false', () => {
    const cwd = makeDir('agent-deck-detach-args-');
    const withDetach = parseRunArgs([
      'planner',
      '--client',
      'claude',
      '--cwd',
      cwd,
      '--prompt',
      'brief',
      '--detach',
    ]);
    expect(withDetach).toMatchObject({ detach: true });

    const without = parseRunArgs([
      'planner',
      '--client',
      'claude',
      '--cwd',
      cwd,
      '--prompt',
      'brief',
    ]);
    expect(without).toMatchObject({ detach: false });
  });

  it('parses the internal --_run-id override', () => {
    const cwd = makeDir('agent-deck-detach-args-');
    const parsed = parseRunArgs([
      'planner',
      '--client',
      'claude',
      '--cwd',
      cwd,
      '--prompt',
      'brief',
      '--_run-id',
      'run-abc',
    ]);
    expect(parsed).toMatchObject({ runIdOverride: 'run-abc' });
  });

  it('run --help names --detach', () => {
    printRunHelp();
    expect(logs.join('\n')).toContain('--detach');
  });

  it('run --help documents the ANTHROPIC_API_KEY preflight exception', () => {
    printRunHelp();
    expect(logs.join('\n')).toContain('ANTHROPIC_API_KEY');
  });

  it('forwards every starter flag verbatim, minus --detach, plus --log and --_run-id', () => {
    const child = buildDetachedChildArgs(
      ['planner', '--client', 'claude', '--cwd', '/w', '--prompt', 'hi', '--tools', 'edit', '--detach'],
      'run-1',
      '/home/runs/run-1/run.jsonl',
    );
    expect(child).toEqual([
      'planner',
      '--client',
      'claude',
      '--cwd',
      '/w',
      '--prompt',
      'hi',
      '--tools',
      'edit',
      '--log',
      '/home/runs/run-1/run.jsonl',
      '--_run-id',
      'run-1',
    ]);
    expect(child).not.toContain('--detach');
  });

  it('keeps an explicit --log instead of appending a second one', () => {
    const child = buildDetachedChildArgs(
      ['planner', '--client', 'claude', '--cwd', '/w', '--prompt', 'hi', '--log', '/custom/x.jsonl', '--detach'],
      'run-2',
      '/home/runs/run-2/run.jsonl',
    );
    expect(child.filter((arg) => arg === '--log')).toHaveLength(1);
    expect(child).toContain('/custom/x.jsonl');
    expect(child.slice(-2)).toEqual(['--_run-id', 'run-2']);
  });

  it('forwards --resume, --prompt-file, and --tools untouched', () => {
    const child = buildDetachedChildArgs(
      [
        'planner',
        '--client',
        'claude',
        '--cwd',
        '/w',
        '--prompt-file',
        '/w/brief.md',
        '--tools',
        'edit',
        '--resume',
        'ses_old',
        '--detach',
      ],
      'run-3',
      '/home/runs/run-3/run.jsonl',
    );
    expect(child).toContain('--prompt-file');
    expect(child).toContain('/w/brief.md');
    expect(child).toContain('--tools');
    expect(child).toContain('edit');
    expect(child).toContain('--resume');
    expect(child).toContain('ses_old');
  });

  it('does not mistake a --prompt value for the --detach flag', () => {
    const child = buildDetachedChildArgs(
      ['planner', '--client', 'claude', '--cwd', '/w', '--prompt', '--detach', '--detach'],
      'run-4',
      '/home/runs/run-4/run.jsonl',
    );
    // The value survives as the --prompt argument; only the real flag is gone.
    expect(child).toEqual([
      'planner',
      '--client',
      'claude',
      '--cwd',
      '/w',
      '--prompt',
      '--detach',
      '--log',
      '/home/runs/run-4/run.jsonl',
      '--_run-id',
      'run-4',
    ]);
  });

  it('replaces a stale --_run-id with the starter allocation', () => {
    const child = buildDetachedChildArgs(
      ['planner', '--client', 'claude', '--cwd', '/w', '--prompt', 'hi', '--_run-id', 'stale', '--detach'],
      'run-fresh',
      '/home/runs/run-fresh/run.jsonl',
    );
    expect(child).not.toContain('stale');
    expect(child.slice(-2)).toEqual(['--_run-id', 'run-fresh']);
  });
});

type FakeChild = EventEmitter & { pid: number | undefined; unref: ReturnType<typeof vi.fn> };

function fakeChild(pid: number | undefined = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

function starterDeps(
  cwd: string,
  homeDir: string,
  overrides: Partial<DetachedStarterDeps> = {},
): DetachedStarterDeps {
  return {
    resolveDeck: vi.fn(async () => ({ ...DECK })),
    resolveLaunchPlan: vi.fn(async () => ({
      workspaceRoot: cwd,
      mcpUrl: 'http://127.0.0.1:1110/mcp',
      deckId: DECK.id,
      deckName: DECK.name,
      headers: [],
    })) as unknown as RunDeps['resolveLaunchPlan'],
    claudeProbe: vi.fn(async () => ({ ok: true as const })),
    homeDir,
    cliEntry: '/fake/bin.js',
    ...overrides,
  };
}

function parsedDetach(cwd: string, extra: string[] = []): RunOptions {
  const parsed = parseRunArgs(
    ['detach', '--client', 'claude', '--cwd', cwd, '--prompt', 'brief', '--detach', ...extra],
  );
  if ('error' in parsed) {
    throw new Error(`test args did not parse: ${parsed.error}`);
  }
  return parsed;
}

function logOfSpawnArgs(spawnArgs: string[]): string {
  const at = spawnArgs.indexOf('--log');
  if (at === -1 || at + 1 >= spawnArgs.length) {
    throw new Error('mocked spawn did not receive --log');
  }
  return spawnArgs[at + 1];
}

describe('run --detach starter, mocked spawn (NOT-401)', () => {
  it('spawns detached with stdin ignored and file stdio, then reports runId/pid/log', async () => {
    const cwd = makeDir('agent-deck-detach-cwd-');
    const homeDir = makeDir('agent-deck-detach-home-');
    const spawnFn = vi.fn((command: string, spawnArgs: string[], _options: SpawnOptions) => {
      void command;
      // The child writes its first line; the starter should notice and return.
      fs.appendFileSync(logOfSpawnArgs(spawnArgs), '{"t":"text"}\n', 'utf8');
      return fakeChild(4242) as unknown as ChildProcess;
    });
    const deps = starterDeps(cwd, homeDir, { spawnFn });

    const code = await startDetachedRun(
      ['detach', '--client', 'claude', '--cwd', cwd, '--prompt', 'brief', '--detach'],
      parsedDetach(cwd),
      deps,
    );

    expect(code).toBe(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [command, spawnArgs, spawnOpts] = spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      SpawnOptions & { detached?: boolean; stdio?: unknown },
    ];
    expect(command).toBe(process.execPath);
    expect(spawnArgs[0]).toBe('/fake/bin.js');
    expect(spawnArgs[1]).toBe('run');
    expect(spawnArgs).not.toContain('--detach');
    expect(spawnOpts.detached).toBe(true);
    expect(Array.isArray(spawnOpts.stdio) ? spawnOpts.stdio[0] : undefined).toBe('ignore');
    const line = logs.at(-1) ?? '';
    const match = /run (\S+) detached: pid (\d+) log (\S+)/.exec(line);
    expect(match, `starter line: ${line}`).toBeTruthy();
    expect(match?.[2]).toBe('4242');
    const [, runId, , logPath] = match as unknown as [string, string, string, string];
    expect(logPath).toContain(path.join(homeDir, 'runs', runId));
    const meta = JSON.parse(
      fs.readFileSync(path.join(path.dirname(logPath), 'meta.json'), 'utf8'),
    ) as RunMeta;
    expect(meta).toMatchObject({ runId, pid: 4242, state: 'running', tools: 'readonly' });
  });

  it('a child that exits before its first log line fails with the stderr tail', async () => {
    const cwd = makeDir('agent-deck-detach-cwd-');
    const homeDir = makeDir('agent-deck-detach-home-');
    const spawnFn = vi.fn((command: string, spawnArgs: string[], _options: SpawnOptions) => {
      void command;
      const logPath = logOfSpawnArgs(spawnArgs);
      fs.appendFileSync(
        path.join(path.dirname(logPath), 'run.out'),
        'boom line one\nboom line two\n',
        'utf8',
      );
      const child = fakeChild(5150);
      process.nextTick(() => child.emit('exit', 1, null));
      return child as unknown as ChildProcess;
    });
    const deps = starterDeps(cwd, homeDir, { spawnFn });

    const code = await startDetachedRun(
      ['detach', '--client', 'claude', '--cwd', cwd, '--prompt', 'brief', '--detach'],
      parsedDetach(cwd),
      deps,
    );

    expect(code).not.toBe(0);
    const stderr = errors.join('\n');
    expect(stderr).toMatch(/died before its first log line/);
    expect(stderr).toContain('boom line one');
    expect(stderr).toContain('boom line two');
    expect(logs.join('\n')).not.toMatch(/detached: pid/);
    const runDir = fs.readdirSync(path.join(homeDir, 'runs'))[0];
    const meta = JSON.parse(
      fs.readFileSync(path.join(homeDir, 'runs', runDir, 'meta.json'), 'utf8'),
    ) as RunMeta;
    expect(meta.state).toBe('error');
  });

  it('a slow but living child still lets the starter return within its bound', async () => {
    const cwd = makeDir('agent-deck-detach-cwd-');
    const homeDir = makeDir('agent-deck-detach-home-');
    const spawnFn = vi.fn(() => fakeChild(6161) as unknown as ChildProcess);
    const deps = starterDeps(cwd, homeDir, { spawnFn, firstLineTimeoutMs: 150 });

    const startedAt = Date.now();
    const code = await startDetachedRun(
      ['detach', '--client', 'claude', '--cwd', cwd, '--prompt', 'brief', '--detach'],
      parsedDetach(cwd),
      deps,
    );

    expect(code).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(logs.at(-1)).toMatch(/run \S+ detached: pid 6161 log \S+/);
  });

  it('prereq failures exit before any spawn', async () => {
    const cwd = makeDir('agent-deck-detach-cwd-');
    const homeDir = makeDir('agent-deck-detach-home-');
    const spawnFn = vi.fn(() => fakeChild() as unknown as ChildProcess);
    const deps = starterDeps(cwd, homeDir, {
      spawnFn,
      resolveDeck: vi.fn(async () => null),
    });

    const code = await startDetachedRun(
      ['nope', '--client', 'claude', '--cwd', cwd, '--prompt', 'brief', '--detach'],
      {
        ...parsedDetach(cwd),
        deckRef: 'nope',
      },
      deps,
    );

    expect(code).not.toBe(0);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/Deck not found/);
  });

  it('runRunCommand --detach dispatches to the starter', async () => {
    const cwd = makeDir('agent-deck-detach-cwd-');
    const homeDir = makeDir('agent-deck-detach-home-');
    const spawnFn = vi.fn((command: string, spawnArgs: string[], _options: SpawnOptions) => {
      void command;
      fs.appendFileSync(logOfSpawnArgs(spawnArgs), '{"t":"text"}\n', 'utf8');
      return fakeChild(7171) as unknown as ChildProcess;
    });
    const deps = starterDeps(cwd, homeDir, { spawnFn }) as unknown as RunDeps;

    const code = await runRunCommand(
      ['detach', '--client', 'claude', '--cwd', cwd, '--prompt', 'brief', '--detach'],
      deps,
    );

    expect(code).toBe(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(logs.at(-1)).toMatch(/detached: pid 7171/);
  });
});

describe('run --detach against the built CLI (NOT-401)', () => {
  beforeEach(() => {
    assertFreshBuild(CLI_PACKAGE);
  });

  type StarterResult = { code: number | null; signal: string | null; stdout: string; stderr: string };

  function runStarter(
    args: string[],
    env: NodeJS.ProcessEnv,
    spawnOpts: { detached?: boolean } = {},
  ): { child: ChildProcess; done: Promise<StarterResult> } {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      ...(spawnOpts.detached ? { detached: true } : {}),
    });
    starters.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const done = new Promise<StarterResult>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { child, done };
  }

  async function setupFakeRun(options: {
    behavior: Record<string, unknown>;
    promptFile?: boolean;
  }): Promise<{
    home: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    recordPath: string;
    behaviorPath: string;
  }> {
    const home = makeDir('agent-deck-detach-home-');
    const cwd = makeDir('agent-deck-detach-ws-');
    await writeAssignment(cwd, { deckId: DECK.id, deckName: DECK.name });
    const recordPath = path.join(home, 'recorded-options.json');
    const behaviorPath = path.join(home, 'fake-behavior.json');
    fs.writeFileSync(
      behaviorPath,
      `${JSON.stringify({ deckId: DECK.id, deckName: DECK.name, recordOptionsPath: recordPath, ...options.behavior }, null, 2)}\n`,
      'utf8',
    );
    return {
      home,
      cwd,
      env: {
        ...process.env,
        AGENT_DECK_HOME: home,
        AGENT_DECK_RUN_FAKE: behaviorPath,
        AGENT_DECK_SECRET_STORE: 'memory',
        AGENT_DECK_NO_UPDATE_CHECK: '1',
      },
      recordPath,
      behaviorPath,
    };
  }

  function parseStarterLine(stdout: string): { runId: string; pid: number; logPath: string } {
    const match = /run (\S+) detached: pid (\d+) log (\S+)/.exec(stdout);
    expect(match, `starter stdout: ${stdout}`).toBeTruthy();
    const [, runId, pid, logPath] = match as unknown as [string, string, string, string];
    return { runId, pid: Number(pid), logPath };
  }

  function readLines(logPath: string): Array<Record<string, unknown>> {
    return fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function readMeta(logPath: string): RunMeta {
    return JSON.parse(
      fs.readFileSync(path.join(path.dirname(logPath), 'meta.json'), 'utf8'),
    ) as RunMeta;
  }

  async function waitForEnd(logPath: string, timeoutMs = 20_000): Promise<Array<Record<string, unknown>>> {
    const appeared = await waitUntil(() => {
      try {
        return readLines(logPath).some((line) => line.t === 'end');
      } catch {
        return false;
      }
    }, timeoutMs);
    expect(appeared, `no end line in ${logPath}`).toBe(true);
    return readLines(logPath);
  }

  it(
    'starter returns before the child finishes; default profile is readonly end to end',
    { timeout: 30_000 },
    async () => {
      const sessionId = 'ses_detach_readonly';
      const setup = await setupFakeRun({
        behavior: { mode: 'success', lineDelayMs: 300, endDelayMs: 2500, sessionId },
      });

      const startedAt = Date.now();
      const { done } = runStarter(
        ['run', DECK.name, '--client', 'claude', '--cwd', setup.cwd, '--prompt', 'detach brief', '--detach'],
        setup.env,
      );
      const result = await done;
      const starterMs = Date.now() - startedAt;

      expect(result.code, `starter stderr: ${result.stderr}`).toBe(0);
      const { runId, pid, logPath } = parseStarterLine(result.stdout);
      childPids.push(pid);

      // The starter is back while the run is still mid-flight.
      expect(starterMs).toBeLessThan(5000);
      expect(isAlive(pid), 'child died with the starter').toBe(true);
      expect(readLines(logPath).some((line) => line.t === 'end')).toBe(false);
      expect(readMeta(logPath)).toMatchObject({ runId, pid, state: 'running', tools: 'readonly' });

      const lines = await waitForEnd(logPath);
      expect(lines.map((line) => line.t)).toEqual(['text', 'result', 'end']);
      expect(lines.at(-1)).toMatchObject({ sessionId });
      expect(readMeta(logPath)).toMatchObject({ runId, pid, state: 'ended', sessionId });

      const recorded = JSON.parse(fs.readFileSync(setup.recordPath, 'utf8')) as {
        prompt: string;
        options: { allowedTools: string[]; permissionMode: string; resume?: string };
      };
      expect(recorded.prompt).toBe('detach brief');
      expect(recorded.options.allowedTools).toEqual([...RUN_READONLY_TOOLS]);
      expect(recorded.options.permissionMode).toBe('acceptEdits');
      expect(recorded.options.resume).toBeUndefined();
    },
  );

  it(
    'passes --tools edit, --prompt-file, --resume, --cwd, and --log through to the child',
    { timeout: 30_000 },
    async () => {
      const sessionId = 'ses_detach_edit';
      const setup = await setupFakeRun({
        behavior: { mode: 'success', lineDelayMs: 200, endDelayMs: 500, sessionId },
      });
      const promptFile = path.join(setup.cwd, 'brief.md');
      fs.writeFileSync(promptFile, 'file brief for edit run');
      const customLog = path.join(setup.home, 'custom', 'session.jsonl');

      const { done } = runStarter(
        [
          'run',
          DECK.name,
          '--client',
          'claude',
          '--cwd',
          setup.cwd,
          '--prompt-file',
          promptFile,
          '--tools',
          'edit',
          '--resume',
          'ses_old',
          '--log',
          customLog,
          '--detach',
        ],
        setup.env,
      );
      const result = await done;

      expect(result.code, `starter stderr: ${result.stderr}`).toBe(0);
      const { runId, pid, logPath } = parseStarterLine(result.stdout);
      childPids.push(pid);
      expect(logPath).toBe(customLog);
      expect(readMeta(logPath)).toMatchObject({ runId, pid, state: 'running', tools: 'edit' });

      const lines = await waitForEnd(logPath);
      expect(lines.at(-1)).toMatchObject({ t: 'end', sessionId });
      expect(readMeta(logPath)).toMatchObject({ state: 'ended', tools: 'edit' });

      const recorded = JSON.parse(fs.readFileSync(setup.recordPath, 'utf8')) as {
        prompt: string;
        options: { allowedTools: string[]; resume?: string; cwd: string };
      };
      expect(recorded.prompt).toBe('file brief for edit run');
      expect(recorded.options.allowedTools).toEqual([...RUN_EDIT_TOOLS]);
      expect(recorded.options.resume).toBe('ses_old');
      expect(recorded.options.cwd).toBe(setup.cwd);
    },
  );

  it(
    'the child survives its starter process group being killed and still reaches end',
    { timeout: 30_000 },
    async () => {
      if (process.platform === 'win32') {
        return;
      }
      const sessionId = 'ses_detach_survives';
      const setup = await setupFakeRun({
        behavior: { mode: 'success', lineDelayMs: 2500, endDelayMs: 500, sessionId },
      });
      const customLog = path.join(setup.home, 'survive', 'run.jsonl');
      const metaPath = path.join(path.dirname(customLog), 'meta.json');

      // Its own process group, like a remote shell session: killing the group
      // takes the starter with it, and the detached child must not notice.
      const { child: starter, done } = runStarter(
        [
          'run',
          DECK.name,
          '--client',
          'claude',
          '--cwd',
          setup.cwd,
          '--prompt',
          'survive me',
          '--log',
          customLog,
          '--detach',
        ],
        setup.env,
        { detached: true },
      );
      const starterPid = starter.pid;
      expect(starterPid).toBeTruthy();

      const metaAppeared = await waitUntil(() => fs.existsSync(metaPath), 10_000);
      expect(metaAppeared, 'starter never wrote meta.json').toBe(true);
      const childPid = (JSON.parse(fs.readFileSync(metaPath, 'utf8')) as RunMeta).pid;
      childPids.push(childPid);
      expect(childPid).not.toBe(starterPid);

      process.kill(-(starterPid as number), 'SIGKILL');
      const result = await done;
      expect(result.signal).toBe('SIGKILL');

      expect(isAlive(childPid), 'detached child died with its starter group').toBe(true);
      const lines = await waitForEnd(customLog);
      expect(lines.at(-1)).toMatchObject({ t: 'end', sessionId });
      expect(readMeta(customLog)).toMatchObject({ state: 'ended', sessionId });
    },
  );

  it(
    'a child that crashes before its first log line fails the starter with the tail',
    { timeout: 30_000 },
    async () => {
      const crashLine = 'fake-runner-crash-marker-7319';
      const setup = await setupFakeRun({
        behavior: { mode: 'crash', exitCode: 3, crashStderr: crashLine },
      });

      const { done } = runStarter(
        ['run', DECK.name, '--client', 'claude', '--cwd', setup.cwd, '--prompt', 'doomed', '--detach'],
        setup.env,
      );
      const result = await done;

      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toMatch(/detached: pid/);
      expect(result.stderr).toMatch(/died before its first log line/);
      expect(result.stderr).toContain(crashLine);

      const runDirs = fs.readdirSync(path.join(setup.home, 'runs'));
      expect(runDirs).toHaveLength(1);
      const runDir = path.join(setup.home, 'runs', runDirs[0]);
      const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8')) as RunMeta;
      expect(meta.state).toBe('error');
      let logText = '';
      try {
        logText = fs.readFileSync(path.join(runDir, 'run.jsonl'), 'utf8');
      } catch {
        logText = '';
      }
      expect(logText.trim()).toBe('');
    },
  );
});
