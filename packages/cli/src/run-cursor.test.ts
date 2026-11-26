/**
 * Cursor adapter tests (NOT-406): tool-profile argv mapping, resume, preflight,
 * workspace trust, empty-result fail-closed, and the session-receipt deck check.
 *
 * Fixture provenance: the owner's smoke test (cursor-agent 2026.10.01,
 * /tmp/smoke, 2026-10-11) verified that `cursor-agent -p --trust
 * --output-format json "<prompt>"` returns a result object with `session_id`
 * and that `--resume <session_id>` continues the session. No byte-identical
 * capture was available in this sandbox (cursor-agent needs ~/.cursor writes
 * and network for a model call), so run-cursor.fixture.json is reconstructed
 * from those two facts — `{"session_id","result"}` — not a verbatim capture.
 * The operator run on the owner's Mac attaches real logs to the PR; a
 * follow-up may swap in a byte-identical capture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpLaunchPlan } from './mcp-launcher';
import type { NormalizedEvent, RunToolsProfile } from '@agent-deck/backend/agent-run';
import {
  CURSOR_SANDBOX_FOR_PROFILE,
  CURSOR_SANDBOX_PROBE_ARGS,
  buildCursorArgv,
  buildCursorWorkerMcpDocument,
  buildCursorWorkerMcpEntry,
  cleanupCursorWorkerHome,
  createCursorAdapter,
  createRunAdapter,
  cursorDenialsFromResult,
  cursorEnforcementFlagsSupported,
  cursorEventsFromOutput,
  cursorHelpTextSupportsEnforcement,
  cursorSandboxHostSupport,
  defaultCursorFileReader,
  defaultCursorSandboxProbe,
  findCursorForeignProjectServers,
  findCursorProjectAgentDeckEntries,
  firstCursorProbeErrorLine,
  isCursorStatusAuthenticated,
  setupCursorWorkerHome,
  syncCursorWorkerHomeWrites,
  type CursorFileReader,
  type CursorProbe,
  type CursorSandboxProbe,
  type CursorSpawn,
} from '@agent-deck/backend/agent-run';
import { runRunCommand, type RunDeps, type RunMeta } from './run';

const DECK = { id: 'deck-planner', name: 'planner' };

// Reconstructed fixture: {"session_id","result"} per the smoke-test facts,
// with a planner receipt line so start-path successes pass the mandatory
// deck-receipt check (repair round 2).
const CURSOR_FIXTURE_TEXT = fs
  .readFileSync(fileURLToPath(new URL('./run-cursor.fixture.json', import.meta.url)), 'utf8')
  .trim();
const CURSOR_SESSION_ID = (JSON.parse(CURSOR_FIXTURE_TEXT) as { session_id: string }).session_id;
const CURSOR_RECEIPT = '◆ planner · 1 MCP · 0 keys · 1 playbooks';
const withReceipt = (text: string): string => `${text}\n${CURSOR_RECEIPT}`;

const tmpDirs: string[] = [];
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
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function matchingPlan(cwd: string): McpLaunchPlan {
  return {
    workspaceRoot: cwd,
    mcpUrl: 'http://127.0.0.1:1110/mcp',
    deckId: DECK.id,
    deckName: DECK.name,
    headers: [],
  };
}

export const CURSOR_ENFORCING_HELP =
  'Usage: agent [options]\n  --sandbox <mode>  Explicitly enable or disable sandbox mode\n  --approve-mcps  Automatically approve all MCP servers\n  --plan  Start in plan mode (shorthand for --mode=plan)\n';

type CursorSpawnCall = { bin: string; argv: string[]; cwd: string; env?: NodeJS.ProcessEnv };

function fakeCursorSpawn(
  stdout: string = CURSOR_FIXTURE_TEXT,
  code = 0,
  stderrTail = '',
): { spawn: CursorSpawn; calls: CursorSpawnCall[] } {
  const calls: CursorSpawnCall[] = [];
  const spawn = vi.fn(
    (bin: string, argv: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      calls.push({ bin, argv, cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) });
      return {
        stdout: (async function* (): AsyncGenerator<string> {
          yield* stdout.split('\n');
        })(),
        wait: async () => ({ code, stderrTail }),
      };
    },
  );
  return { spawn: spawn as unknown as CursorSpawn, calls };
}

function okCursorProbe(): CursorProbe {
  return (bin: string, argv: string[]) => {
    if (argv[0] === '--version') {
      return { code: 0, stdout: '2026.11.22-e9042b2\n', stderr: '' };
    }
    if (argv[0] === '--help') {
      return { code: 0, stdout: CURSOR_ENFORCING_HELP, stderr: '' };
    }
    return {
      code: 0,
      stdout: '{"status":"authenticated","isAuthenticated":true}\n',
      stderr: '',
    };
  };
}

/** Real file reads (the sandbox gate no longer reads host knobs). */
function supportingHostReadFile(): CursorFileReader {
  return defaultCursorFileReader;
}

/** Cursor's own sandbox preflight (`cursor-agent sandbox run true`) passes. */
function passingSandboxProbe(): CursorSandboxProbe {
  return () => ({ ok: true });
}

/** Cursor's own sandbox preflight fails, as on the AppArmor-restricted box. */
function failingSandboxProbe(): CursorSandboxProbe {
  return () => ({
    ok: false,
    detail: "SandboxUnsupportedError: Sandbox policy 'workspace_readwrite' is not supported on this system.",
  });
}

/** A fake `$HOME` for the worker-home overlay: a dotfile, a dir, and a `.cursor` dir. */
function makeOsHome(): string {
  const osHome = makeDir('agent-deck-cursor-oshome-');
  fs.writeFileSync(path.join(osHome, '.gitconfig'), '[user]\n', 'utf8');
  fs.mkdirSync(path.join(osHome, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(osHome, '.cursor', 'chats'), { recursive: true });
  fs.writeFileSync(
    path.join(osHome, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } } }),
    'utf8',
  );
  return osHome;
}

function makeDeps(
  cwd: string,
  homeDir: string,
  overrides: {
    stdout?: string;
    code?: number;
    stderrTail?: string;
    probe?: CursorProbe;
    plan?: McpLaunchPlan | null;
    readFile?: CursorFileReader;
    osHome?: string;
    sandboxProbe?: CursorSandboxProbe;
    /** When true the real NOT-671 profile gate runs instead of the bypass. */
    enforceProfile?: boolean;
  } = {},
): RunDeps & { calls: CursorSpawnCall[]; osHome: string } {
  const { spawn, calls } = fakeCursorSpawn(overrides.stdout, overrides.code, overrides.stderrTail);
  const osHome = overrides.osHome ?? makeOsHome();
  const cursor = {
    probe: overrides.probe ?? okCursorProbe(),
    spawn,
    ...(overrides.readFile ? { readFile: overrides.readFile } : {}),
    homedir: () => osHome,
    ...(overrides.sandboxProbe ? { sandboxProbe: overrides.sandboxProbe } : {}),
  };
  return {
    calls,
    osHome,
    cursor,
    // Real adapter behavior with the NOT-669 gate bypassed (unless the test
    // asks for enforcement): these tests exercise argv/event mapping.
    ...(overrides.enforceProfile
      ? {}
      : {
          createAdapter: (client: 'claude' | 'codex' | 'cursor' | 'muse') => ({
            ...createRunAdapter(client, { cursor }),
            profileEnforcement: () => ({ ok: true as const }),
          }),
        }),
    resolveDeck: async (ref: string) => (ref === DECK.name || ref === DECK.id ? { ...DECK } : null),
    resolveLaunchPlan: (async () => overrides.plan ?? matchingPlan(cwd)) as RunDeps['resolveLaunchPlan'],
    homeDir,
  };
}

function cursorArgs(cwd: string, extra: string[] = []): string[] {
  return ['planner', '--client', 'cursor', '--cwd', cwd, '--prompt', 'remember kiwi', ...extra];
}

function readJsonLines(logPath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function logPathFromStdout(): string {
  return (logs.at(-1)?.match(/log (\S+) sessionId/) ?? [])[1] ?? '';
}

function readMeta(logPath: string): RunMeta {
  return JSON.parse(
    fs.readFileSync(path.join(path.dirname(logPath), 'meta.json'), 'utf8'),
  ) as RunMeta;
}

const cursorLine = (value: unknown): string => JSON.stringify(value);

describe('cursor fixture mapping (NOT-406)', () => {
  it('the result object yields text then result and end with the session id', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(cursorArgs(cwd), deps);

    expect(code).toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['text', 'result', 'end']);
    expect(lines[0]).toMatchObject({ t: 'text' });
    expect(String(lines[0]['text'])).toContain('contract hello');
    expect(String(lines[0]['text'])).toContain(CURSOR_RECEIPT);
    expect(lines[1]).toMatchObject({ t: 'result', sessionId: CURSOR_SESSION_ID, subtype: 'success' });
    expect(lines[2]).toMatchObject({ t: 'end', sessionId: CURSOR_SESSION_ID });
    expect(readMeta(logPathFromStdout())).toMatchObject({
      client: 'cursor',
      state: 'ended',
      sessionId: CURSOR_SESSION_ID,
    });
  });

  it('a result object with warnings yields a notice and still ends ended', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      stdout: cursorLine({
        session_id: 'cursor_warned',
        result: withReceipt('done with warnings'),
        warnings: ['slow model, consider retrying'],
      }),
    });

    expect(await runRunCommand(cursorArgs(cwd), deps)).toBe(0);

    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['notice', 'text', 'result', 'end']);
    expect(String(lines[0]['message'])).toContain('slow model');
    expect(readMeta(logPathFromStdout()).state).toBe('ended');
  });

  it('tool arrays become tool lines (synthetic shape)', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      stdout: cursorLine({
        session_id: 'cursor_tools',
        result: withReceipt('used tools'),
        tool_calls: [{ name: 'get_session_context' }, 'Read'],
      }),
    });

    expect(await runRunCommand(cursorArgs(cwd), deps)).toBe(0);

    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['text', 'tool', 'tool', 'result', 'end']);
    expect(lines[1]).toMatchObject({ t: 'tool', name: 'get_session_context' });
    expect(lines[2]).toMatchObject({ t: 'tool', name: 'Read' });
  });

  it('a result object carrying error ends error with a failed result', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      stdout: cursorLine({ session_id: 'cursor_failed', error: 'model overloaded' }),
    });

    const code = await runRunCommand(cursorArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['result', 'end']);
    expect(lines[0]).toMatchObject({ t: 'result', subtype: 'failed', sessionId: 'cursor_failed' });
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error' });
  });

  it('a non-zero exit marks the run error with the stderr tail', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      stdout: CURSOR_FIXTURE_TEXT,
      code: 1,
      stderrTail: 'fatal: something broke',
    });

    const code = await runRunCommand(cursorArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['error']);
    expect(String(lines[0]['message'])).toContain('cursor-agent exited with code 1');
    expect(String(lines[0]['message'])).toContain('fatal: something broke');
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error' });
  });
});

describe('cursor argv and tool profiles (NOT-406, enforcement NOT-671)', () => {
  const PROMPT = 'remember kiwi';

  it('readonly passes --sandbox enabled --plan --approve-mcps and no --force or --yolo', () => {
    const argv = buildCursorArgv({ prompt: PROMPT, tools: 'readonly' });

    expect(argv).toEqual([
      '-p',
      '--trust',
      '--output-format',
      'json',
      '--sandbox',
      'enabled',
      '--plan',
      '--approve-mcps',
      '--',
      PROMPT,
    ]);
    expect(argv).not.toContain('--force');
    expect(argv).not.toContain('--yolo');
  });

  it('edit passes --sandbox disabled --force --approve-mcps and no --plan or --yolo', () => {
    expect(CURSOR_SANDBOX_FOR_PROFILE).toEqual({ readonly: 'enabled', edit: 'disabled' });
    const argv = buildCursorArgv({ prompt: PROMPT, tools: 'edit' });

    expect(argv).toEqual([
      '-p',
      '--trust',
      '--output-format',
      'json',
      '--sandbox',
      'disabled',
      '--force',
      '--approve-mcps',
      '--',
      PROMPT,
    ]);
    expect(argv).toContain('--force');
    expect(argv).not.toContain('--plan');
    expect(argv).not.toContain('--yolo');
  });

  it('start argv always includes --trust', async () => {
    for (const tools of ['readonly', 'edit'] as const) {
      const cwd = makeDir('agent-deck-cursor-cwd-');
      const homeDir = makeDir('agent-deck-cursor-home-');
      const deps = makeDeps(cwd, homeDir);

      expect(await runRunCommand(cursorArgs(cwd, ['--tools', tools]), deps)).toBe(0);

      expect(deps.calls).toHaveLength(1);
      expect(deps.calls[0].argv).toContain('--trust');
      expect(deps.calls[0].cwd).toBe(cwd);
      expect(readMeta(logPathFromStdout())).toMatchObject({ tools, trustOverride: true });
      logs = [];
    }
  });

  it('resume argv includes --resume <id> before the prompt', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      stdout: cursorLine({ session_id: CURSOR_SESSION_ID, result: 'kiwi' }),
    });

    const code = await runRunCommand(cursorArgs(cwd, ['--resume', CURSOR_SESSION_ID]), deps);

    expect(code).toBe(0);
    expect(deps.calls[0].argv).toEqual([
      '-p',
      '--trust',
      '--output-format',
      'json',
      '--sandbox',
      'enabled',
      '--plan',
      '--approve-mcps',
      '--resume',
      CURSOR_SESSION_ID,
      '--',
      'remember kiwi',
    ]);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.at(-1)).toMatchObject({ t: 'end', sessionId: CURSOR_SESSION_ID });
  });

  it('every generated argv selects its sandbox value and MCP preapproval and never --yolo', () => {
    const profiles: RunToolsProfile[] = ['readonly', 'edit'];
    for (const tools of profiles) {
      for (const resumeId of [undefined, 'abc123']) {
        const argv = buildCursorArgv({ prompt: 'p', tools, ...(resumeId ? { resumeId } : {}) });
        expect(argv).toContain('--sandbox');
        expect(argv).toContain('--approve-mcps');
        expect(argv).not.toContain('--yolo');
        expect(argv.join('\n')).not.toMatch(/yolo/i);
        // The --sandbox value is explicit per profile: readonly needs the
        // sandbox on, edit must not inherit an unstartable one.
        const sandboxIndex = argv.indexOf('--sandbox');
        expect(argv[sandboxIndex + 1]).toBe(CURSOR_SANDBOX_FOR_PROFILE[tools]);
        if (tools === 'readonly') {
          expect(argv).toContain('--plan');
          expect(argv).not.toContain('--force');
        } else {
          expect(argv).toContain('--force');
          expect(argv).not.toContain('--plan');
        }
      }
    }
  });

  it.each(['--yolo', '--approve-mcps', '--force', '--trust'])(
    'a dash-leading resume id %j is rejected before spawning',
    (resumeId) => {
      expect(() =>
        buildCursorArgv({ prompt: 'p', tools: 'readonly', resumeId }),
      ).toThrow(/never start with '-'/);
      const adapter = createCursorAdapter({
        probe: okCursorProbe(),
        spawn: fakeCursorSpawn().spawn,
      });
      const plan = adapter.planStart({ cwd: '/tmp/x', prompt: 'p', tools: 'readonly', resumeId });
      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.remedy).toMatch(/never start with '-'/);
      }
    },
  );

  it('a --resume spelling a cursor flag fails closed before spawning', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(cursorArgs(cwd, ['--resume', '--yolo']), deps);

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/never start with '-'/);
    expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
  });

  it.each(['- bullet brief', '---\nfrontmatter brief', '--yolo', '--approve-mcps'])(
    'a dash-leading prompt %j is passed after a -- terminator',
    (prompt) => {
      for (const resumeId of [undefined, 'abc123']) {
        const argv = buildCursorArgv({
          prompt,
          tools: 'readonly',
          ...(resumeId ? { resumeId } : {}),
        });
        expect(argv.at(-1)).toBe(prompt);
        const sep = argv.indexOf('--');
        expect(sep).toBeGreaterThan(0);
        expect(argv.filter((arg) => arg === '--')).toHaveLength(1);
        expect(argv.slice(sep + 1)).toEqual([prompt]);
      }
    },
  );
});

describe('cursor workspace trust and empty results (NOT-406)', () => {
  it('"Workspace Trust Required" at exit 0 ends error with a remedy', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, { stdout: 'Workspace Trust Required\n' });

    const code = await runRunCommand(cursorArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['error']);
    expect(String(lines[0]['message'])).toContain('Workspace Trust Required');
    expect(String(lines[0]['message'])).toMatch(/trust prompt, then retry/);
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error' });
  });

  it('empty stdout at exit 0 ends error with a remedy, never an empty success', async () => {
    for (const stdout of ['', '   \n  ']) {
      const cwd = makeDir('agent-deck-cursor-cwd-');
      const homeDir = makeDir('agent-deck-cursor-home-');
      const deps = makeDeps(cwd, homeDir, { stdout });

      expect(await runRunCommand(cursorArgs(cwd), deps)).not.toBe(0);

      const lines = readJsonLines(logPathFromStdout());
      expect(lines.map((line) => line.t)).toEqual(['error']);
      expect(String(lines[0]['message'])).toMatch(/empty result/);
      expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error' });
      logs = [];
    }
  });

  it('an empty result object ends error with a remedy', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, { stdout: cursorLine({}) });

    const code = await runRunCommand(cursorArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['error']);
    expect(String(lines[0]['message'])).toMatch(/empty result/);
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error' });
  });

  it('an empty-string result carrying a session id ends error, never success', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      stdout: cursorLine({ session_id: 'cursor_empty_string', result: '' }),
    });

    const code = await runRunCommand(cursorArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['error']);
    expect(String(lines[0]['message'])).toMatch(/empty result/);
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error' });
  });

  it('an empty result object on --resume ends error (resume id is not content)', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, { stdout: cursorLine({}) });

    const code = await runRunCommand(cursorArgs(cwd, ['--resume', 'resumed_chat_9']), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['error']);
    expect(String(lines[0]['message'])).toMatch(/empty result/);
    expect(readMeta(logPathFromStdout())).toMatchObject({
      state: 'error',
      sessionId: 'resumed_chat_9',
    });
  });

  it('non-JSON stdout ends error with the raw head', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, { stdout: 'Something went sideways' });

    const code = await runRunCommand(cursorArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['error']);
    expect(String(lines[0]['message'])).toContain('Something went sideways');
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error' });
  });
});

describe('cursor preflight (NOT-406)', () => {
  it('a missing binary fails preflight with a one-line remedy before any spawn', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      probe: () => ({ code: 127, stdout: '', stderr: '' }),
    });

    const code = await runRunCommand(cursorArgs(cwd), deps);

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/cursor-agent CLI not found/);
    expect(errors.join('\n')).toContain('CURSOR_BIN');
  });

  it('a signed-out cursor-agent fails preflight with the login remedy', async () => {
    const signedOut = [
      { code: 1, stdout: '', stderr: '' },
      {
        code: 0,
        stdout: '{"status":"unauthenticated","isAuthenticated":false,"message":"Not logged in"}\n',
        stderr: '',
      },
      { code: 0, stdout: 'Not logged in\n', stderr: '' },
    ];
    for (const login of signedOut) {
      const cwd = makeDir('agent-deck-cursor-cwd-');
      const homeDir = makeDir('agent-deck-cursor-home-');
      const deps = makeDeps(cwd, homeDir, {
        probe: (bin, argv) =>
          argv[0] === '--version'
            ? { code: 0, stdout: '2026.10.01-e373342\n', stderr: '' }
            : login,
      });

      expect(await runRunCommand(cursorArgs(cwd), deps)).not.toBe(0);
      expect(deps.calls).toHaveLength(0);
      expect(errors.join('\n')).toContain('cursor-agent login');
      logs = [];
      errors = [];
    }
  });

  it('status output decides sign-in even at exit 0', () => {
    expect(
      isCursorStatusAuthenticated('{"status":"authenticated","isAuthenticated":true}\n'),
    ).toBe(true);
    expect(
      isCursorStatusAuthenticated(
        '{"status":"unauthenticated","isAuthenticated":false,"message":"Not logged in"}\n',
      ),
    ).toBe(false);
    expect(isCursorStatusAuthenticated('{"status":"authenticated"}\n')).toBe(true);
    expect(isCursorStatusAuthenticated('{"status":"unauthenticated"}\n')).toBe(false);
    expect(isCursorStatusAuthenticated('Not logged in\n')).toBe(false);
    expect(isCursorStatusAuthenticated('')).toBe(false);
    expect(isCursorStatusAuthenticated('mystery output\n')).toBe(false);
  });
});

describe('cursor session receipt (NOT-406)', () => {
  it('a receipt naming another deck marks the run error', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      stdout: cursorLine({
        session_id: 'cursor_receipt',
        result: '◆ other · 1 MCP · 0 keys · 0 playbooks',
      }),
    });

    const code = await runRunCommand(cursorArgs(cwd), deps);

    expect(code).not.toBe(0);
    expect(errors.join('\n')).toContain('"other"');
    expect(readMeta(logPathFromStdout())).toMatchObject({
      state: 'error',
      sessionId: 'cursor_receipt',
    });
  });

  it('a receipt naming the requested deck ends ended', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      stdout: cursorLine({
        session_id: 'cursor_receipt_ok',
        result: '◆ planner · 1 MCP · 0 keys · 1 playbooks',
      }),
    });

    expect(await runRunCommand(cursorArgs(cwd), deps)).toBe(0);
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'ended' });
  });

  it('a success with no receipt line ends error with a remedy', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      stdout: cursorLine({ session_id: 'cursor_no_receipt', result: 'did work, no receipt' }),
    });

    const code = await runRunCommand(cursorArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['error']);
    expect(String(lines[0]['message'])).toMatch(/no deck receipt/);
    expect(String(lines[0]['message'])).toContain('get_session_context');
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error' });
  });

  it('a resume without a receipt still ends ended (first-turn receipt only)', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir, {
      stdout: cursorLine({ session_id: CURSOR_SESSION_ID, result: 'kiwi' }),
    });

    const code = await runRunCommand(cursorArgs(cwd, ['--resume', CURSOR_SESSION_ID]), deps);

    expect(code).toBe(0);
    expect(readMeta(logPathFromStdout())).toMatchObject({
      state: 'ended',
      sessionId: CURSOR_SESSION_ID,
    });
  });
});

describe('cursor output parser edges (NOT-406)', () => {
  function parse(stdout: string, resumeId?: string): NormalizedEvent[] {
    return cursorEventsFromOutput(stdout, resumeId ? { resumeId } : {});
  }

  it('accepts session id and answer aliases', () => {
    expect(parse(cursorLine({ chatId: 'c1', text: withReceipt('hi') }))).toEqual([
      { kind: 'text', text: withReceipt('hi'), sessionId: 'c1' },
      {
        kind: 'result',
        subtype: 'success',
        result: { chatId: 'c1', text: withReceipt('hi') },
        sessionId: 'c1',
      },
    ]);
    expect(parse(cursorLine({ sessionId: 'c2', message: withReceipt('yo') }))[0]).toMatchObject({
      kind: 'text',
      sessionId: 'c2',
    });
  });

  it('falls back to the resume id for the session when the object omits it', () => {
    const events = parse(cursorLine({ result: 'kiwi' }), 'resumed_chat_9');

    expect(events.at(-1)).toMatchObject({ kind: 'result', sessionId: 'resumed_chat_9' });
  });

  it('maps content blocks to text and tool events', () => {
    const events = parse(
      cursorLine({
        session_id: 'c3',
        content: [
          { type: 'text', text: withReceipt('working') },
          { type: 'tool_use', name: 'Read' },
        ],
      }),
    );

    expect(events.map((event) => event.kind)).toEqual(['text', 'tool', 'result']);
    expect(events[1]).toMatchObject({ kind: 'tool', name: 'Read', sessionId: 'c3' });
  });

  it('non-JSON lines around the result object become notices', () => {
    const events = parse(`starting up\n${cursorLine({ session_id: 'c4', result: withReceipt('ok') })}`);

    expect(events.map((event) => event.kind)).toEqual(['notice', 'text', 'result']);
    expect(events[0]).toMatchObject({ kind: 'notice', sessionId: 'c4' });
  });

  it('is_error true marks the run failed even with answer text', () => {
    const events = parse(
      cursorLine({ session_id: 'c5', result: withReceipt('partial'), is_error: true }),
    );

    expect(events.at(-1)).toMatchObject({
      kind: 'result',
      subtype: 'failed',
      sessionId: 'c5',
    });
  });

  it('a non-success subtype marks the run failed', () => {
    const events = parse(
      cursorLine({ session_id: 'c6', result: withReceipt('nope'), subtype: 'error' }),
    );

    expect(events.at(-1)).toMatchObject({ kind: 'result', sessionId: 'c6' });
    expect((events.at(-1) as { subtype: string }).subtype).not.toBe('success');
  });

  it('a bare id is not accepted as the session id', () => {
    const events = parse(cursorLine({ id: 'req_123', result: withReceipt('hello') }));

    expect(events.at(-1)).toMatchObject({ kind: 'result' });
    expect(events.at(-1)).not.toHaveProperty('sessionId');
  });

  it('the cursor adapter reports id cursor and always records the trust grant', async () => {
    const adapter = createCursorAdapter({
      probe: okCursorProbe(),
      spawn: fakeCursorSpawn().spawn,
    });
    expect(adapter.id).toBe('cursor');
    expect(await adapter.preflight()).toEqual({ ok: true });
    expect(adapter.planStart({ cwd: '/tmp/x', prompt: 'p', tools: 'readonly' })).toEqual({
      ok: true,
      trustOverride: true,
    });
  });
});

describe('cursor worker profile enforcement gate (NOT-671)', () => {
  it('help text must list --sandbox, --approve-mcps, and --plan or --mode', () => {
    expect(cursorHelpTextSupportsEnforcement(CURSOR_ENFORCING_HELP)).toBe(true);
    expect(cursorHelpTextSupportsEnforcement('Usage: agent [options]\n')).toBe(false);
    expect(
      cursorHelpTextSupportsEnforcement(
        'Usage: agent\n  --sandbox <mode>\n  --approve-mcps\n  --mode <mode>\n',
      ),
    ).toBe(true);
    for (const missing of ['--sandbox', '--approve-mcps']) {
      expect(
        cursorHelpTextSupportsEnforcement(
          CURSOR_ENFORCING_HELP.replace(missing, '--something-else'),
        ),
      ).toBe(false);
    }
    expect(
      cursorHelpTextSupportsEnforcement(
        CURSOR_ENFORCING_HELP.replace('--plan', '--project').replace('--mode=plan', '--project'),
      ),
    ).toBe(false);
  });

  it('a failing --help probe means enforcement is unsupported', () => {
    expect(cursorEnforcementFlagsSupported(okCursorProbe(), 'cursor-agent')).toBe(true);
    expect(
      cursorEnforcementFlagsSupported(() => ({ code: 127, stdout: '', stderr: '' }), 'cursor-agent'),
    ).toBe(false);
    expect(
      cursorEnforcementFlagsSupported(
        () => ({ code: 0, stdout: 'Usage: agent [options]\n', stderr: '' }),
        'cursor-agent',
      ),
    ).toBe(false);
  });

  it('the gate passes with enforcing flags, isolated projects, and a buildable overlay', () => {
    const osHome = makeOsHome();
    const adapter = createCursorAdapter({
      probe: okCursorProbe(),
      spawn: fakeCursorSpawn().spawn,
      readFile: () => null,
      homedir: () => osHome,
      sandboxProbe: passingSandboxProbe(),
    });

    for (const tools of ['readonly', 'edit'] as const) {
      expect(
        adapter.profileEnforcement({ cwd: makeDir('agent-deck-cursor-cwd-'), prompt: 'p', tools }),
      ).toEqual({ ok: true });
    }
  });

  it('a build without the enforcement flags fails closed before spawn on start and resume', async () => {
    for (const extra of [[], ['--resume', 'chat_1']] as string[][]) {
      const cwd = makeDir('agent-deck-cursor-cwd-');
      const homeDir = makeDir('agent-deck-cursor-home-');
      const deps = makeDeps(cwd, homeDir, {
        enforceProfile: true,
        readFile: () => null,
        probe: (bin, argv) => {
          if (argv[0] === '--version') {
            return { code: 0, stdout: '2026.10.01-e373342\n', stderr: '' };
          }
          if (argv[0] === '--help') {
            return { code: 0, stdout: 'Usage: agent [options]\n  -p, --print\n', stderr: '' };
          }
          return {
            code: 0,
            stdout: '{"status":"authenticated","isAuthenticated":true}\n',
            stderr: '',
          };
        },
      });

      expect(await runRunCommand(cursorArgs(cwd, extra), deps)).not.toBe(0);
      expect(deps.calls).toHaveLength(0);
      expect(errors.join('\n')).toMatch(/enforcement unavailable/);
      expect(errors.join('\n')).toMatch(/--sandbox/);
      expect(errors.join('\n')).toMatch(/no process was started/i);
      expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
      logs = [];
      errors = [];
    }
  });

  it('a project config with a foreign MCP server fails closed before spawn', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    fs.mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' }, other: {} } }),
      'utf8',
    );
    const deps = makeDeps(cwd, homeDir, { enforceProfile: true });

    expect(await runRunCommand(cursorArgs(cwd), deps)).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/MCP isolation unavailable/);
    expect(errors.join('\n')).toContain('"other"');
    expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
  });

  it('foreign servers are found up the tree, agent-deck-only projects pass', () => {
    const cwd = path.join(makeDir('agent-deck-cursor-tree-'), 'a', 'b');
    fs.mkdirSync(cwd, { recursive: true });
    const root = path.resolve(cwd, '..', '..');
    const readFile: CursorFileReader = (filePath) => {
      if (filePath === path.join(root, '.cursor', 'mcp.json')) {
        return JSON.stringify({ mcpServers: { stranger: { url: 'http://127.0.0.1:9/mcp' } } });
      }
      return null;
    };
    expect(findCursorForeignProjectServers(cwd, readFile)).toEqual([
      { configPath: path.join(root, '.cursor', 'mcp.json'), server: 'stranger' },
    ]);
    const agentDeckOnly: CursorFileReader = (filePath) =>
      filePath === path.join(cwd, '.cursor', 'mcp.json')
        ? JSON.stringify({ mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } } })
        : null;
    expect(findCursorForeignProjectServers(cwd, agentDeckOnly)).toEqual([]);
    const garbage: CursorFileReader = (filePath) =>
      filePath === path.join(cwd, '.cursor', 'mcp.json') ? 'not json {' : null;
    expect(findCursorForeignProjectServers(cwd, garbage)).toEqual([
      { configPath: path.join(cwd, '.cursor', 'mcp.json'), server: '<unparseable mcp.json>' },
    ]);
  });

  it('the real home user config is excluded: the worker home shadows it', () => {
    const home = makeDir('agent-deck-cursor-realhome-');
    const cwd = path.join(home, 'work', 'repo');
    fs.mkdirSync(cwd, { recursive: true });
    const readFile: CursorFileReader = (filePath) => {
      if (filePath === path.join(home, '.cursor', 'mcp.json')) {
        return JSON.stringify({ mcpServers: { other: {}, 'agent-deck': {} } });
      }
      return null;
    };
    // Without the home exclusion the global server would fail the gate;
    // with it the walk finds nothing — the worker home shadows that file.
    expect(findCursorForeignProjectServers(cwd, readFile)).toEqual([
      { configPath: path.join(home, '.cursor', 'mcp.json'), server: 'other' },
    ]);
    expect(findCursorForeignProjectServers(cwd, readFile, home)).toEqual([]);
  });

  it('a project agent-deck entry fails closed before spawn on start and resume (project shadows the run entry)', async () => {
    for (const extra of [[], ['--resume', 'chat_1']] as string[][]) {
      const cwd = makeDir('agent-deck-cursor-cwd-');
      const homeDir = makeDir('agent-deck-cursor-home-');
      fs.mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, '.cursor', 'mcp.json'),
        JSON.stringify({ mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } } }),
        'utf8',
      );
      // Real project reads (this test covers MCP isolation) with a
      // supporting sandbox host, so the rejection is the shadowing check.
      const deps = makeDeps(cwd, homeDir, {
        enforceProfile: true,
        readFile: supportingHostReadFile(),
        sandboxProbe: passingSandboxProbe(),
      });

      expect(await runRunCommand(cursorArgs(cwd, extra), deps)).not.toBe(0);
      expect(deps.calls).toHaveLength(0);
      expect(errors.join('\n')).toMatch(/MCP isolation unavailable/);
      expect(errors.join('\n')).toMatch(/project-over-global precedence/);
      expect(errors.join('\n')).toMatch(/without its run token/);
      expect(errors.join('\n')).toMatch(/no process was started/i);
      expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
      logs = [];
      errors = [];
    }
  });

  it('project agent-deck entries are found up the tree and the real-home user config is excluded', () => {
    const home = makeDir('agent-deck-cursor-realhome-');
    const cwd = path.join(home, 'work', 'repo', 'a');
    fs.mkdirSync(cwd, { recursive: true });
    const projectPath = path.join(home, 'work', 'repo', '.cursor', 'mcp.json');
    const readFile: CursorFileReader = (filePath) => {
      // The real-home user entry can never load (the worker home shadows
      // it), so it must not fail the shadowing check.
      if (filePath === path.join(home, '.cursor', 'mcp.json')) {
        return JSON.stringify({ mcpServers: { 'agent-deck': {} } });
      }
      if (filePath === projectPath) {
        return JSON.stringify({ mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } } });
      }
      return null;
    };
    expect(findCursorProjectAgentDeckEntries(cwd, readFile, home)).toEqual([projectPath]);
    // Unparseable project files are the foreign finder's failure, not this one.
    const garbage: CursorFileReader = (filePath) =>
      filePath === path.join(cwd, '.cursor', 'mcp.json') ? 'not json {' : null;
    expect(findCursorProjectAgentDeckEntries(cwd, garbage, home)).toEqual([]);
    expect(findCursorForeignProjectServers(cwd, garbage, home)).toEqual([
      { configPath: path.join(cwd, '.cursor', 'mcp.json'), server: '<unparseable mcp.json>' },
    ]);
  });

  it('the host check is decided by cursor-agent sandbox run true alone', () => {
    const probe = vi.fn(passingSandboxProbe());
    expect(cursorSandboxHostSupport({ bin: '/opt/cursor-agent', sandboxProbe: probe })).toEqual({ supported: true });
    expect(probe).toHaveBeenCalledWith('/opt/cursor-agent');
    expect(cursorSandboxHostSupport({ bin: 'cursor-agent', sandboxProbe: failingSandboxProbe() })).toEqual({
      supported: false,
      reason: expect.stringMatching(/`cursor-agent sandbox run true` failed \(SandboxUnsupportedError/),
    });
    expect(cursorSandboxHostSupport({ bin: 'cursor-agent', sandboxProbe: () => ({ ok: false }) }).supported).toBe(false);
  });

  it('the default probe runs the bin with sandbox run true and fails closed on errors', () => {
    expect(CURSOR_SANDBOX_PROBE_ARGS).toEqual(['sandbox', 'run', 'true']);
    expect(defaultCursorSandboxProbe('/nonexistent/cursor-agent-xyz')).toEqual({
      ok: false,
      detail: expect.any(String),
    });
    expect(
      firstCursorProbeErrorLine('Executing command: true\nWorking directory: /tmp\nFailed to execute command: SandboxUnsupportedError: x'),
    ).toBe('Failed to execute command: SandboxUnsupportedError: x');
  });

  it('the gate rejects readonly but passes edit on a host that cannot start the sandbox', () => {
    const osHome = makeOsHome();
    const adapter = createCursorAdapter({
      probe: okCursorProbe(),
      spawn: fakeCursorSpawn().spawn,
      sandboxProbe: failingSandboxProbe(),
      homedir: () => osHome,
    });

    const cwd = makeDir('agent-deck-cursor-cwd-');
    const readonlyGate = adapter.profileEnforcement({ cwd, prompt: 'p', tools: 'readonly' });
    expect(readonlyGate.ok).toBe(false);
    if (!readonlyGate.ok) {
      expect(readonlyGate.remedy).toMatch(/unsupported on this host/);
      expect(readonlyGate.remedy).toMatch(/SandboxUnsupportedError/);
      expect(readonlyGate.remedy).toMatch(/--tools edit .* unaffected/);
      expect(readonlyGate.remedy).toMatch(/no process was started/i);
    }
    expect(adapter.profileEnforcement({ cwd, prompt: 'p', tools: 'edit' })).toEqual({ ok: true });
  });

  it('a host that cannot start the sandbox rejects readonly before spawn on start and resume', async () => {
    for (const extra of [[], ['--resume', 'chat_1']] as string[][]) {
      const cwd = makeDir('agent-deck-cursor-cwd-');
      const homeDir = makeDir('agent-deck-cursor-home-');
      const deps = makeDeps(cwd, homeDir, {
        enforceProfile: true,
        sandboxProbe: failingSandboxProbe(),
      });

      expect(await runRunCommand(cursorArgs(cwd, extra), deps)).not.toBe(0);
      expect(deps.calls).toHaveLength(0);
      expect(errors.join('\n')).toMatch(/unsupported on this host/);
      expect(errors.join('\n')).toMatch(/SandboxUnsupportedError/);
      expect(errors.join('\n')).toMatch(/no process was started/i);
      expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
      logs = [];
      errors = [];
    }
  });

  it('a failing cursor-agent sandbox preflight rejects readonly before spawn on start and resume', async () => {
    for (const extra of [[], ['--resume', 'chat_1']] as string[][]) {
      const cwd = makeDir('agent-deck-cursor-cwd-');
      const homeDir = makeDir('agent-deck-cursor-home-');
      const deps = makeDeps(cwd, homeDir, {
        enforceProfile: true,
        readFile: supportingHostReadFile(),
        sandboxProbe: failingSandboxProbe(),
      });

      expect(await runRunCommand(cursorArgs(cwd, extra), deps)).not.toBe(0);
      expect(deps.calls).toHaveLength(0);
      expect(errors.join('\n')).toMatch(/unsupported on this host/);
      expect(errors.join('\n')).toMatch(/sandbox run true` failed/);
      expect(errors.join('\n')).toMatch(/no process was started/i);
      expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
      logs = [];
      errors = [];
    }
  });

  it('edit skips the sandbox host check on start and resume (--sandbox disabled needs no sandbox)', async () => {
    for (const extra of [
      ['--tools', 'edit'],
      ['--tools', 'edit', '--resume', 'chat_1'],
    ] as string[][]) {
      const cwd = makeDir('agent-deck-cursor-cwd-');
      const homeDir = makeDir('agent-deck-cursor-home-');
      const deps = makeDeps(cwd, homeDir, {
        enforceProfile: true,
        sandboxProbe: failingSandboxProbe(),
      });

      expect(await runRunCommand(cursorArgs(cwd, extra), deps)).toBe(0);
      expect(deps.calls).toHaveLength(1);
      const sandboxIndex = deps.calls[0].argv.indexOf('--sandbox');
      expect(deps.calls[0].argv[sandboxIndex + 1]).toBe('disabled');
      logs = [];
      errors = [];
    }
  });

  it('an unbuildable worker-home overlay fails the gate with a remedy', () => {
    const adapter = createCursorAdapter({
      probe: okCursorProbe(),
      spawn: fakeCursorSpawn().spawn,
      readFile: () => null,
      homedir: () => path.join(makeDir('agent-deck-cursor-gone-'), 'no-such-home'),
    });

    // Edit skips the sandbox host check, so the failure is deterministically
    // the overlay dry run on every platform; the overlay check itself is
    // profile-independent.
    const gate = adapter.profileEnforcement({
      cwd: makeDir('agent-deck-cursor-cwd-'),
      prompt: 'p',
      tools: 'edit',
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.remedy).toMatch(/worker config isolation unavailable/);
      expect(gate.remedy).toMatch(/No process was started/);
    }
  });

  it('planStart carries the pin and launch deck instead of rejecting them', () => {
    const adapter = createCursorAdapter({
      probe: okCursorProbe(),
      spawn: fakeCursorSpawn().spawn,
    });
    expect(
      adapter.planStart({
        cwd: '/tmp/x',
        prompt: 'p',
        tools: 'readonly',
        playbookPin: { playbookId: 'pb', versionId: 'v' },
        launchDeckId: 'deck-other',
      }),
    ).toEqual({ ok: true, trustOverride: true });
  });
});

describe('cursor worker MCP identity (NOT-671)', () => {
  it('the worker entry carries the daemon URL and the workspace, pin, deck, and token headers', () => {
    expect(buildCursorWorkerMcpEntry({ workspaceRoot: '/work' })).toEqual({
      url: 'http://127.0.0.1:1110/mcp',
      headers: { 'x-agent-deck-workspace': '/work' },
    });
    expect(
      buildCursorWorkerMcpEntry(
        {
          workspaceRoot: '/work',
          playbookPin: { playbookId: 'pb', versionId: 'v1' },
          launchDeckId: 'deck-1',
          runToken: 't'.repeat(64),
        },
        { host: '127.0.0.1', port: '2222' },
      ),
    ).toEqual({
      url: 'http://127.0.0.1:2222/mcp',
      headers: {
        'x-agent-deck-workspace': '/work',
        'x-agent-deck-playbook-pin': 'pb=v1',
        'x-agent-deck-deck-id': 'deck-1',
        'x-agent-deck-run-token': 't'.repeat(64),
      },
    });
    expect(
      buildCursorWorkerMcpDocument(buildCursorWorkerMcpEntry({ workspaceRoot: '/work' })),
    ).toEqual({
      mcpServers: {
        'agent-deck': {
          url: 'http://127.0.0.1:1110/mcp',
          headers: { 'x-agent-deck-workspace': '/work' },
        },
      },
    });
  });

  it('the worker home holds only the run entry and symlinks everything else', () => {
    const osHome = makeOsHome();
    const workerHome = makeDir('agent-deck-cursor-worker-');
    const document = buildCursorWorkerMcpDocument(buildCursorWorkerMcpEntry({ workspaceRoot: '/w' }));

    expect(setupCursorWorkerHome({ workerHome, realHome: osHome, mcpDocument: document })).toBe(
      workerHome,
    );
    expect(JSON.parse(fs.readFileSync(path.join(workerHome, '.cursor', 'mcp.json'), 'utf8'))).toEqual(
      document,
    );
    // The worker mcp.json is a real file, not a link to the home one.
    expect(fs.lstatSync(path.join(workerHome, '.cursor', 'mcp.json')).isSymbolicLink()).toBe(false);
    for (const entry of ['.gitconfig', 'workspace']) {
      const linkPath = path.join(workerHome, entry);
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(path.join(osHome, entry)));
    }
    expect(fs.lstatSync(path.join(workerHome, '.cursor', 'chats')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(workerHome, '.cursor', 'chats'))).toBe(
      fs.realpathSync(path.join(osHome, '.cursor', 'chats')),
    );
    cleanupCursorWorkerHome(workerHome);
    expect(fs.existsSync(workerHome)).toBe(false);
    // Cleanup never touches the real home behind the symlinks.
    expect(fs.existsSync(path.join(osHome, '.gitconfig'))).toBe(true);
  });

  it('the worker home setup throws with a remedy when home is unreadable', () => {
    expect(() =>
      setupCursorWorkerHome({
        workerHome: makeDir('agent-deck-cursor-worker-'),
        realHome: path.join(makeDir('agent-deck-cursor-gone-'), 'no-such-home'),
        mcpDocument: buildCursorWorkerMcpDocument(buildCursorWorkerMcpEntry({ workspaceRoot: '/w' })),
      }),
    ).toThrow(/cannot read home directory/);
  });

  it('start spawns with HOME pointed at a cleaned-up worker home', async () => {
    const cwd = makeDir('agent-deck-cursor-cwd-');
    const homeDir = makeDir('agent-deck-cursor-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(await runRunCommand(cursorArgs(cwd), deps)).toBe(0);
    expect(deps.calls).toHaveLength(1);
    const childHome = deps.calls[0].env?.HOME;
    expect(childHome).toBeTruthy();
    expect(childHome).not.toBe(deps.osHome);
    expect(childHome).not.toBe(process.env.HOME);
    // Per-run: removed after the stream ends.
    expect(fs.existsSync(childHome as string)).toBe(false);
  });

  it('start without a worker token fails closed before spawn', async () => {
    const { spawn, calls } = fakeCursorSpawn();
    const adapter = createCursorAdapter({
      probe: okCursorProbe(),
      spawn,
      readFile: () => null,
      homedir: makeOsHome,
    });
    await expect(async () => {
      for await (const _event of adapter.start({ cwd: '/tmp/x', prompt: 'p', tools: 'readonly' })) {
        // Drain.
      }
    }).rejects.toThrow(/without a worker token/);
    expect(calls).toHaveLength(0);
  });

  it('write-back moves new top-level home paths, never .cursor, and keeps real-home conflicts', () => {
    const osHome = makeOsHome();
    const workerHome = makeDir('agent-deck-cursor-worker-');
    const document = buildCursorWorkerMcpDocument(buildCursorWorkerMcpEntry({ workspaceRoot: '/w' }));
    setupCursorWorkerHome({ workerHome, realHome: osHome, mcpDocument: document });

    // New paths the agent created inside the worker home.
    fs.writeFileSync(path.join(workerHome, 'profile-proof.txt'), 'edit home write\n', 'utf8');
    fs.mkdirSync(path.join(workerHome, 'newdir'), { recursive: true });
    fs.writeFileSync(path.join(workerHome, 'newdir', 'nested.txt'), 'nested\n', 'utf8');
    fs.writeFileSync(path.join(workerHome, '.cursor', 'new-state.json'), '{"run":1}', 'utf8');
    // Names that appeared in the real home concurrently: a file and a dir.
    fs.writeFileSync(path.join(workerHome, 'clash.txt'), 'run copy\n', 'utf8');
    fs.writeFileSync(path.join(osHome, 'clash.txt'), 'real copy\n', 'utf8');
    fs.mkdirSync(path.join(workerHome, 'clashdir'), { recursive: true });
    fs.writeFileSync(path.join(workerHome, 'clashdir', 'a.txt'), 'run\n', 'utf8');
    fs.mkdirSync(path.join(osHome, 'clashdir'), { recursive: true });
    fs.writeFileSync(path.join(osHome, 'clashdir', 'a.txt'), 'real\n', 'utf8');

    const result = syncCursorWorkerHomeWrites({ workerHome, realHome: osHome });

    expect(fs.readFileSync(path.join(osHome, 'profile-proof.txt'), 'utf8')).toBe('edit home write\n');
    expect(fs.readFileSync(path.join(osHome, 'newdir', 'nested.txt'), 'utf8')).toBe('nested\n');
    expect(result.moved.sort()).toEqual(['newdir', 'profile-proof.txt']);
    expect(result.conflicts.sort()).toEqual(['clash.txt', 'clashdir']);
    // Conflicts keep the real-home entries untouched.
    expect(fs.readFileSync(path.join(osHome, 'clash.txt'), 'utf8')).toBe('real copy\n');
    expect(fs.readFileSync(path.join(osHome, 'clashdir', 'a.txt'), 'utf8')).toBe('real\n');
    // `.cursor` is never written back: no new state, and the per-run
    // authenticated entry never leaks into the user config.
    expect(fs.existsSync(path.join(osHome, '.cursor', 'new-state.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(osHome, '.cursor', 'mcp.json'), 'utf8'))).toEqual({
      mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } },
    });
    // Symlinked entries are left alone (writes through them already persist).
    expect(fs.lstatSync(path.join(workerHome, '.gitconfig')).isSymbolicLink()).toBe(true);
  });

  it('start preserves new agent-home paths the run creates (edit home side effects survive cleanup)', async () => {
    const osHome = makeOsHome();
    const { spawn: inner, calls } = fakeCursorSpawn();
    const spawn = ((bin: string, argv: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      const home = opts.env?.HOME ?? '';
      fs.writeFileSync(path.join(home, 'profile-proof.txt'), 'edit home write\n', 'utf8');
      return (inner as CursorSpawn)(bin, argv, opts);
    }) as CursorSpawn;
    const adapter = createCursorAdapter({
      probe: okCursorProbe(),
      spawn,
      readFile: () => null,
      homedir: () => osHome,
    });

    const events = [];
    for await (const event of adapter.start({
      cwd: makeDir('agent-deck-cursor-cwd-'),
      prompt: 'p',
      tools: 'edit',
      runToken: 't'.repeat(64),
    })) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'result', subtype: 'success' }),
    );
    // The new home path survived the worker-home cleanup.
    expect(fs.readFileSync(path.join(osHome, 'profile-proof.txt'), 'utf8')).toBe('edit home write\n');
    const childHome = calls[0].env?.HOME as string;
    expect(fs.existsSync(childHome)).toBe(false);
  });

  it('a failed home write-back yields a notice instead of failing the run', async () => {
    const osHome = makeOsHome();
    const blocker = path.join(makeDir('agent-deck-cursor-blocker-'), 'file');
    fs.writeFileSync(blocker, 'not a dir', 'utf8');
    // Setup reads the real home; write-back targets an impossible one.
    let homedirCalls = 0;
    const homedir = (): string => (++homedirCalls === 1 ? osHome : path.join(blocker, 'sub'));
    const inner = fakeCursorSpawn().spawn;
    // The run creates a new home path, so the write-back has work to fail on.
    const spawn = ((bin: string, argv: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      fs.writeFileSync(path.join(opts.env?.HOME ?? '', 'run-new.txt'), 'x', 'utf8');
      return inner(bin, argv, opts);
    }) as typeof inner;
    const adapter = createCursorAdapter({
      probe: okCursorProbe(),
      spawn,
      readFile: () => null,
      homedir,
    });

    const events = [];
    for await (const event of adapter.start({
      cwd: makeDir('agent-deck-cursor-cwd-'),
      prompt: 'p',
      tools: 'edit',
      runToken: 't'.repeat(64),
    })) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'result', subtype: 'success' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'notice', message: expect.stringContaining('write-back failed') }),
    );
  });
});

describe('cursor client denials (NOT-671)', () => {
  it('refusal strings map to file_write, shell, network, and client_tool kinds', () => {
    expect(
      cursorDenialsFromResult({ warnings: ['sandbox blocked file write to /work/a.txt'] }),
    ).toEqual([
      {
        target: 'sandbox blocked file write to /work/a.txt',
        reason: 'sandbox blocked file write to /work/a.txt',
        denialKind: 'file_write',
      },
    ]);
    expect(cursorDenialsFromResult({ messages: ['command execution denied by policy'] })).toEqual([
      expect.objectContaining({ denialKind: 'shell' }),
    ]);
    expect(cursorDenialsFromResult({ error: 'network request blocked by sandbox' })).toEqual([
      expect.objectContaining({ denialKind: 'network' }),
    ]);
    expect(cursorDenialsFromResult({ warnings: ['slow model, consider retrying'] })).toEqual([]);
    expect(cursorDenialsFromResult({ result: 'writes are denied in readonly mode' })).toEqual([]);
  });

  it('tool records with a denied status become denials named by the tool', () => {
    expect(
      cursorDenialsFromResult({
        tool_calls: [
          { name: 'Edit', status: 'denied', reason: 'plan mode forbids edits' },
          { name: 'Read', status: 'ok' },
        ],
      }),
    ).toEqual([
      {
        target: 'Edit',
        reason: 'plan mode forbids edits',
        denialKind: 'file_write',
      },
    ]);
  });

  it('denials surface as events before the result on success and on failure', () => {
    const success = cursorEventsFromOutput(
      cursorLine({
        session_id: 'c7',
        result: withReceipt('done'),
        warnings: ['sandbox blocked file write to /work/a.txt'],
      }),
    );
    expect(success.map((event) => event.kind)).toEqual(['notice', 'text', 'denial', 'result']);
    expect(success[2]).toMatchObject({
      kind: 'denial',
      denialKind: 'file_write',
      sessionId: 'c7',
    });
    const failed = cursorEventsFromOutput(
      cursorLine({ session_id: 'c8', error: 'command execution denied by policy' }),
    );
    expect(failed.map((event) => event.kind)).toEqual(['denial', 'result']);
    expect(failed[0]).toMatchObject({ kind: 'denial', denialKind: 'shell', sessionId: 'c8' });
  });

  it('a run records client denials with the effective profile', async () => {
    for (const tools of ['readonly', 'edit'] as const) {
      const cwd = makeDir('agent-deck-cursor-cwd-');
      const homeDir = makeDir('agent-deck-cursor-home-');
      const deps = makeDeps(cwd, homeDir, {
        stdout: cursorLine({
          session_id: `cursor_denied_${tools}`,
          result: withReceipt('done despite refusal'),
          warnings: ['sandbox blocked file write to /work/a.txt'],
        }),
      });

      expect(await runRunCommand(cursorArgs(cwd, ['--tools', tools]), deps)).toBe(0);
      const meta = readMeta(logPathFromStdout());
      expect(meta.state).toBe('ended');
      expect(meta.denials).toHaveLength(1);
      expect(meta.denials?.[0]).toMatchObject({
        client: 'cursor',
        profile: tools,
        source: 'client',
        kind: 'file_write',
      });
      logs = [];
    }
  });
});
