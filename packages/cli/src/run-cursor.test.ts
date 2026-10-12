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
import type { NormalizedEvent, RunToolsProfile } from './run-adapter';
import {
  buildCursorArgv,
  createCursorAdapter,
  cursorEventsFromOutput,
  isCursorStatusAuthenticated,
  type CursorProbe,
  type CursorSpawn,
} from './run-cursor';
import { runRunCommand, type RunDeps, type RunMeta } from './run';

const DECK = { id: 'deck-planner', name: 'planner' };

// Reconstructed fixture: {"session_id","result"} per the smoke-test facts.
const CURSOR_FIXTURE_TEXT = fs
  .readFileSync(fileURLToPath(new URL('./run-cursor.fixture.json', import.meta.url)), 'utf8')
  .trim();
const CURSOR_SESSION_ID = (JSON.parse(CURSOR_FIXTURE_TEXT) as { session_id: string }).session_id;

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

function fakeCursorSpawn(
  stdout: string = CURSOR_FIXTURE_TEXT,
  code = 0,
  stderrTail = '',
): { spawn: CursorSpawn; calls: Array<{ bin: string; argv: string[]; cwd: string }> } {
  const calls: Array<{ bin: string; argv: string[]; cwd: string }> = [];
  const spawn = vi.fn((bin: string, argv: string[], opts: { cwd: string }) => {
    calls.push({ bin, argv, cwd: opts.cwd });
    return {
      stdout: (async function* (): AsyncGenerator<string> {
        yield* stdout.split('\n');
      })(),
      wait: async () => ({ code, stderrTail }),
    };
  });
  return { spawn: spawn as unknown as CursorSpawn, calls };
}

function okCursorProbe(): CursorProbe {
  return (bin: string, argv: string[]) =>
    argv[0] === '--version'
      ? { code: 0, stdout: '2026.10.01-e373342\n', stderr: '' }
      : {
          code: 0,
          stdout: '{"status":"authenticated","isAuthenticated":true}\n',
          stderr: '',
        };
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
  } = {},
): RunDeps & { calls: Array<{ bin: string; argv: string[]; cwd: string }> } {
  const { spawn, calls } = fakeCursorSpawn(overrides.stdout, overrides.code, overrides.stderrTail);
  return {
    calls,
    cursor: {
      probe: overrides.probe ?? okCursorProbe(),
      spawn,
    },
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
    expect(lines[0]).toMatchObject({ t: 'text', text: 'contract hello' });
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
        result: 'done with warnings',
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
        result: 'used tools',
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

describe('cursor argv and tool profiles (NOT-406)', () => {
  const PROMPT = 'remember kiwi';

  it('readonly passes no --force, --yolo, or --approve-mcps', () => {
    const argv = buildCursorArgv({ prompt: PROMPT, tools: 'readonly' });

    expect(argv).toEqual(['-p', '--trust', '--output-format', 'json', '--', PROMPT]);
    expect(argv).not.toContain('--force');
    expect(argv).not.toContain('--yolo');
    expect(argv).not.toContain('--approve-mcps');
  });

  it('edit passes --force and still no --yolo or --approve-mcps', () => {
    const argv = buildCursorArgv({ prompt: PROMPT, tools: 'edit' });

    expect(argv).toEqual(['-p', '--trust', '--output-format', 'json', '--force', '--', PROMPT]);
    expect(argv).toContain('--force');
    expect(argv).not.toContain('--yolo');
    expect(argv).not.toContain('--approve-mcps');
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
      '--resume',
      CURSOR_SESSION_ID,
      '--',
      'remember kiwi',
    ]);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.at(-1)).toMatchObject({ t: 'end', sessionId: CURSOR_SESSION_ID });
  });

  it('no generated argv ever contains --yolo or --approve-mcps', () => {
    const profiles: RunToolsProfile[] = ['readonly', 'edit'];
    for (const tools of profiles) {
      for (const resumeId of [undefined, 'abc123']) {
        const argv = buildCursorArgv({ prompt: 'p', tools, ...(resumeId ? { resumeId } : {}) });
        expect(argv).not.toContain('--yolo');
        expect(argv).not.toContain('--approve-mcps');
        expect(argv.join('\n')).not.toMatch(/yolo|approve-mcps/i);
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
});

describe('cursor output parser edges (NOT-406)', () => {
  function parse(stdout: string, resumeId?: string): NormalizedEvent[] {
    return cursorEventsFromOutput(stdout, resumeId ? { resumeId } : {});
  }

  it('accepts session id and answer aliases', () => {
    expect(parse(cursorLine({ chatId: 'c1', text: 'hi' }))).toEqual([
      { kind: 'text', text: 'hi', sessionId: 'c1' },
      {
        kind: 'result',
        subtype: 'success',
        result: { chatId: 'c1', text: 'hi' },
        sessionId: 'c1',
      },
    ]);
    expect(parse(cursorLine({ sessionId: 'c2', message: 'yo' }))[0]).toMatchObject({
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
          { type: 'text', text: 'working' },
          { type: 'tool_use', name: 'Read' },
        ],
      }),
    );

    expect(events.map((event) => event.kind)).toEqual(['text', 'tool', 'result']);
    expect(events[1]).toMatchObject({ kind: 'tool', name: 'Read', sessionId: 'c3' });
  });

  it('non-JSON lines around the result object become notices', () => {
    const events = parse(`starting up\n${cursorLine({ session_id: 'c4', result: 'ok' })}`);

    expect(events.map((event) => event.kind)).toEqual(['notice', 'text', 'result']);
    expect(events[0]).toMatchObject({ kind: 'notice', sessionId: 'c4' });
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
