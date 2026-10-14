/**
 * Codex adapter tests (NOT-404): the real `codex exec --json` fixture
 * captured on the owner's Mac (codex-cli 0.157.1), tool-profile argv mapping,
 * resume, preflight, workspace trust, and the session-receipt deck check.
 *
 * Synthetic lines (tool items, receipts, garbage) are labeled inline; the
 * fixture file itself is byte-identical to the captured smoke output.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpLaunchPlan } from './mcp-launcher';
import type { RunToolsProfile } from '@agent-deck/backend/agent-run';
import {
  buildCodexArgv,
  codexEventsFromLine,
  createCodexAdapter,
  type CodexLineContext,
  type CodexProbe,
  type CodexSpawn,
} from '@agent-deck/backend/agent-run';
import { runRunCommand, type RunDeps, type RunMeta } from './run';

const DECK = { id: 'deck-planner', name: 'planner' };

const CODEX_FIXTURE_LINES = fs
  .readFileSync(fileURLToPath(new URL('./run-codex.fixture.jsonl', import.meta.url)), 'utf8')
  .trim()
  .split('\n');
const CODEX_THREAD_ID = (JSON.parse(CODEX_FIXTURE_LINES[0]) as { thread_id: string }).thread_id;

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

function fakeCodexSpawn(
  lines: string[] = CODEX_FIXTURE_LINES,
  code = 0,
  stderrTail = '',
): { spawn: CodexSpawn; calls: Array<{ bin: string; argv: string[]; cwd: string }> } {
  const calls: Array<{ bin: string; argv: string[]; cwd: string }> = [];
  const spawn = vi.fn((bin: string, argv: string[], opts: { cwd: string }) => {
    calls.push({ bin, argv, cwd: opts.cwd });
    return {
      stdout: (async function* (): AsyncGenerator<string> {
        yield* lines;
      })(),
      wait: async () => ({ code, stderrTail }),
    };
  });
  return { spawn: spawn as unknown as CodexSpawn, calls };
}

function okCodexProbe(): CodexProbe {
  return (bin: string, argv: string[]) =>
    argv[0] === '--version'
      ? { code: 0, stdout: 'codex-cli 0.157.1\n', stderr: '' }
      : { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
}

function makeDeps(
  cwd: string,
  homeDir: string,
  overrides: {
    lines?: string[];
    code?: number;
    stderrTail?: string;
    probe?: CodexProbe;
    isGitRepo?: (cwd: string) => boolean;
    plan?: McpLaunchPlan | null;
  } = {},
): RunDeps & { calls: Array<{ bin: string; argv: string[]; cwd: string }> } {
  const { spawn, calls } = fakeCodexSpawn(overrides.lines, overrides.code, overrides.stderrTail);
  return {
    calls,
    codex: {
      probe: overrides.probe ?? okCodexProbe(),
      spawn,
      isGitRepo: overrides.isGitRepo ?? (() => true),
    },
    resolveDeck: async (ref: string) => (ref === DECK.name || ref === DECK.id ? { ...DECK } : null),
    resolveLaunchPlan: (async () => overrides.plan ?? matchingPlan(cwd)) as RunDeps['resolveLaunchPlan'],
    homeDir,
  };
}

function codexArgs(cwd: string, extra: string[] = []): string[] {
  return ['planner', '--client', 'codex', '--cwd', cwd, '--prompt', 'remember kiwi', ...extra];
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

const codexLine = (value: unknown): string => JSON.stringify(value);

function successStream(threadId: string, items: unknown[] = []): string[] {
  return [
    codexLine({ type: 'thread.started', thread_id: threadId }),
    ...items.map((item) => codexLine({ type: 'item.completed', item })),
    codexLine({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }),
  ];
}

describe('codex fixture mapping (NOT-404)', () => {
  it('thread.started yields sessionId on result and end', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(codexArgs(cwd), deps);

    expect(code).toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['notice', 'text', 'result', 'end']);
    expect(lines[1]).toMatchObject({ t: 'text', text: 'OK' });
    expect(lines[2]).toMatchObject({ t: 'result', sessionId: CODEX_THREAD_ID, subtype: 'success' });
    expect(lines[3]).toMatchObject({ t: 'end', sessionId: CODEX_THREAD_ID });
    expect(readMeta(logPathFromStdout())).toMatchObject({
      client: 'codex',
      state: 'ended',
      sessionId: CODEX_THREAD_ID,
    });
  });

  it('an error event mid-stream yields a notice and the run still ends ended', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(await runRunCommand(codexArgs(cwd), deps)).toBe(0);

    const lines = readJsonLines(logPathFromStdout());
    expect(lines[0]).toMatchObject({ t: 'notice', sessionId: CODEX_THREAD_ID });
    expect(String(lines[0]['message'])).toContain('Reconnecting... 2/5');
    expect(String(lines[0]['message'])).toContain('if the error persists.');
    expect(readMeta(logPathFromStdout()).state).toBe('ended');
  });

  it('a stream without turn.completed yields error', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: [
        codexLine({ type: 'thread.started', thread_id: 'thread_no_turn' }),
        codexLine({
          type: 'item.completed',
          item: { id: 'item_1', type: 'agent_message', text: 'cut off' },
        }),
      ],
    });

    const code = await runRunCommand(codexArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['text', 'end']);
    expect(lines[1]).toMatchObject({ t: 'end', sessionId: 'thread_no_turn' });
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error' });
  });

  it('command and tool items become tool lines (synthetic items)', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream('thread_tools', [
        { id: 'item_1', type: 'command_execution', command: 'git status' },
        { id: 'item_2', type: 'function_call', name: 'get_session_context' },
      ]),
    });

    expect(await runRunCommand(codexArgs(cwd), deps)).toBe(0);

    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['tool', 'tool', 'result', 'end']);
    expect(lines[0]).toMatchObject({ t: 'tool', name: 'command:git status' });
    expect(lines[1]).toMatchObject({ t: 'tool', name: 'get_session_context' });
  });

  it('unparseable stdout lines become notice and do not fail the run (synthetic)', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const stream = successStream('thread_garbage');
    stream.splice(1, 0, 'NOT JSON {{{');
    const deps = makeDeps(cwd, homeDir, { lines: stream });

    expect(await runRunCommand(codexArgs(cwd), deps)).toBe(0);

    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['notice', 'result', 'end']);
    expect(String(lines[0]['message'])).toContain('unparseable codex output');
  });

  it('a non-zero exit marks the run error even after turn.completed', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream('thread_doomed', [
        { id: 'item_1', type: 'agent_message', text: 'almost done' },
      ]),
      code: 1,
      stderrTail: 'fatal: something broke',
    });

    const code = await runRunCommand(codexArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['text', 'result', 'error']);
    expect(String(lines[2]['message'])).toContain('codex exited with code 1');
    expect(String(lines[2]['message'])).toContain('fatal: something broke');
    expect(readMeta(logPathFromStdout())).toMatchObject({
      state: 'error',
      sessionId: 'thread_doomed',
    });
  });
});

describe('codex argv and tool profiles (NOT-404)', () => {
  const PROMPT = 'remember kiwi';

  it.each([
    ['readonly', true, ['exec', '--json', '-s', 'read-only', '--', PROMPT]],
    ['edit', true, ['exec', '--json', '-s', 'workspace-write', '--', PROMPT]],
    ['readonly', false, ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '--', PROMPT]],
    ['edit', false, ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '--', PROMPT]],
  ])('start argv for --tools %s (git repo: %s)', (tools, insideGitRepo, expected) => {
    expect(
      buildCodexArgv({
        prompt: PROMPT,
        tools: tools as RunToolsProfile,
        insideGitRepo: insideGitRepo as boolean,
      }),
    ).toEqual(expected);
  });

  it('readonly produces -s read-only on a real run', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(await runRunCommand(codexArgs(cwd, ['--tools', 'readonly']), deps)).toBe(0);

    expect(deps.calls).toHaveLength(1);
    expect(deps.calls[0].argv).toEqual(['exec', '--json', '-s', 'read-only', '--', 'remember kiwi']);
    expect(deps.calls[0].cwd).toBe(cwd);
    expect(readMeta(logPathFromStdout())).toMatchObject({ tools: 'readonly' });
  });

  it('edit produces -s workspace-write on a real run', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(await runRunCommand(codexArgs(cwd, ['--tools', 'edit']), deps)).toBe(0);

    expect(deps.calls[0].argv).toEqual(['exec', '--json', '-s', 'workspace-write', '--', 'remember kiwi']);
    expect(readMeta(logPathFromStdout())).toMatchObject({ tools: 'edit' });
  });

  it('no generated argv ever contains --dangerously-bypass-approvals-and-sandbox', () => {
    const profiles: RunToolsProfile[] = ['readonly', 'edit'];
    for (const tools of profiles) {
      for (const insideGitRepo of [true, false]) {
        for (const resumeId of [undefined, 'thread_abc']) {
          const argv = buildCodexArgv({ prompt: 'p', tools, insideGitRepo, ...(resumeId ? { resumeId } : {}) });
          expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
          expect(argv.join('\n')).not.toMatch(/danger/i);
        }
      }
    }
  });

  it.each([
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '-csandbox_mode=danger-full-access',
    '--last',
    '--skip-git-repo-check',
  ])('a dash-leading resume id %j is rejected before any argv is generated', (resumeId) => {
    // The builder throws, so no argv carrying the id-as-option can exist ...
    expect(() =>
      buildCodexArgv({ prompt: 'p', tools: 'readonly', insideGitRepo: true, resumeId }),
    ).toThrow(/never start with '-'/);
    // ... and planStart fails closed with the same remedy.
    const adapter = createCodexAdapter({
      probe: okCodexProbe(),
      spawn: fakeCodexSpawn().spawn,
      isGitRepo: () => true,
    });
    const plan = adapter.planStart({ cwd: '/tmp/x', prompt: 'p', tools: 'readonly', resumeId });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.remedy).toMatch(/never start with '-'/);
    }
  });

  it('a --resume spelling a codex flag fails closed before spawning', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(
      codexArgs(cwd, ['--resume', '--dangerously-bypass-approvals-and-sandbox']),
      deps,
    );

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/never start with '-'/);
    expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
  });

  it.each([
    '- bullet brief',
    '---\nfrontmatter brief',
    '--dangerously-bypass-approvals-and-sandbox',
    '-csandbox_mode=bypass',
  ])('a dash-leading prompt %j is passed after a -- terminator', (prompt) => {
    for (const resumeId of [undefined, 'thread_abc']) {
      const argv = buildCodexArgv({
        prompt,
        tools: 'readonly',
        insideGitRepo: true,
        ...(resumeId ? { resumeId } : {}),
      });
      // The prompt is the last argv element and every user-controlled token
      // (resume id, prompt) sits after `--`, so clap parses them as
      // positionals even when they start with `-`.
      expect(argv.at(-1)).toBe(prompt);
      const sep = argv.indexOf('--');
      expect(sep).toBeGreaterThan(0);
      expect(argv.filter((arg) => arg === '--')).toHaveLength(1);
      expect(argv.slice(sep + 1)).toEqual(resumeId ? [resumeId, prompt] : [prompt]);
      // A prompt that spells a codex flag must never become a parsed option:
      // everything before `--` that looks like a flag is a known fixed flag.
      expect(argv.slice(0, sep).filter((arg) => arg.startsWith('-'))).toEqual(
        resumeId ? ['--json'] : ['--json', '-s'],
      );
    }
  });

  it('a dash-leading prompt reaches the spawned argv verbatim on a real run', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(
      await runRunCommand(
        ['planner', '--client', 'codex', '--cwd', cwd, '--prompt', '--dangerously-bypass-approvals-and-sandbox'],
        deps,
      ),
    ).toBe(0);

    expect(deps.calls[0].argv.at(-2)).toBe('--');
    expect(deps.calls[0].argv.at(-1)).toBe('--dangerously-bypass-approvals-and-sandbox');
  });

  it('resume passes the thread id to codex exec resume and keeps the session id', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream(CODEX_THREAD_ID, [
        { id: 'item_9', type: 'agent_message', text: 'kiwi' },
      ]),
    });

    const code = await runRunCommand(codexArgs(cwd, ['--resume', CODEX_THREAD_ID]), deps);

    expect(code).toBe(0);
    expect(deps.calls[0].argv).toEqual(['exec', 'resume', '--json', '--', CODEX_THREAD_ID, 'remember kiwi']);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['notice', 'text', 'result', 'end']);
    expect(String(lines[0]['message'])).toContain('keeps its original sandbox');
    expect(lines.at(-1)).toMatchObject({ t: 'end', sessionId: CODEX_THREAD_ID });
  });

  it('a resumed edit run fails closed before spawning', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(
      codexArgs(cwd, ['--resume', CODEX_THREAD_ID, '--tools', 'edit']),
      deps,
    );

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/no sandbox flag/);
    expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
  });
});

describe('codex preflight and trust (NOT-404)', () => {
  it('a missing binary fails preflight with a one-line remedy before any spawn', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, {
      probe: () => ({ code: 127, stdout: '', stderr: '' }),
    });

    const code = await runRunCommand(codexArgs(cwd), deps);

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/codex CLI not found/);
    expect(errors.join('\n')).toContain('CODEX_BIN');
  });

  it('a signed-out codex fails preflight with the login remedy', async () => {
    for (const login of [
      { code: 1, stdout: '', stderr: '' },
      { code: 0, stdout: 'Not logged in\n', stderr: '' },
    ]) {
      const cwd = makeDir('agent-deck-codex-cwd-');
      const homeDir = makeDir('agent-deck-codex-home-');
      const deps = makeDeps(cwd, homeDir, {
        probe: (bin, argv) =>
          argv[0] === '--version'
            ? { code: 0, stdout: 'codex-cli 0.157.1\n', stderr: '' }
            : login,
      });

      expect(await runRunCommand(codexArgs(cwd), deps)).not.toBe(0);
      expect(deps.calls).toHaveLength(0);
      expect(errors.join('\n')).toContain('codex login');
    }
  });

  it('a non-git cwd passes --skip-git-repo-check and records trustOverride', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, { isGitRepo: () => false });

    expect(await runRunCommand(codexArgs(cwd), deps)).toBe(0);

    expect(deps.calls[0].argv).toContain('--skip-git-repo-check');
    expect(readMeta(logPathFromStdout())).toMatchObject({ trustOverride: true });
  });

  it('a git cwd omits --skip-git-repo-check and records no trustOverride', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, { isGitRepo: () => true });

    expect(await runRunCommand(codexArgs(cwd), deps)).toBe(0);

    expect(deps.calls[0].argv).not.toContain('--skip-git-repo-check');
    expect(readMeta(logPathFromStdout())).not.toHaveProperty('trustOverride');
  });
});

describe('codex session receipt (NOT-404)', () => {
  it('a receipt naming another deck marks the run error', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream('thread_receipt', [
        { id: 'item_1', type: 'agent_message', text: '◆ other · 1 MCP · 0 keys · 0 playbooks' },
      ]),
    });

    const code = await runRunCommand(codexArgs(cwd), deps);

    expect(code).not.toBe(0);
    expect(errors.join('\n')).toContain('"other"');
    expect(readMeta(logPathFromStdout())).toMatchObject({
      state: 'error',
      sessionId: 'thread_receipt',
    });
  });

  it('a receipt naming the requested deck ends ended', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream('thread_receipt_ok', [
        { id: 'item_1', type: 'agent_message', text: '◆ planner · 1 MCP · 0 keys · 1 playbooks' },
      ]),
    });

    expect(await runRunCommand(codexArgs(cwd), deps)).toBe(0);
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'ended' });
  });
});

describe('run --client routing (NOT-404)', () => {
  it('an unknown client exits non-zero listing the supported clients', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(
      ['planner', '--client', 'clippy', '--cwd', cwd, '--prompt', 'brief'],
      deps,
    );

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toContain('claude, codex, cursor, muse');
  });
});

describe('codex line parser edges (NOT-404)', () => {
  function parse(lines: string[]): ReturnType<typeof codexEventsFromLine> {
    const ctx: CodexLineContext = { threadId: null };
    return lines.flatMap((line) => codexEventsFromLine(line, ctx));
  }

  it('ignores turn.started, blank lines, and reasoning items', () => {
    expect(
      parse([
        '',
        '   ',
        codexLine({ type: 'turn.started' }),
        codexLine({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'hmm' } }),
        codexLine({ type: 'something.new', payload: 1 }),
      ]),
    ).toEqual([]);
  });

  it('maps turn.failed to a failed result', () => {
    const events = parse([
      codexLine({ type: 'thread.started', thread_id: 't1' }),
      codexLine({ type: 'turn.failed', error: 'blew up' }),
    ]);
    expect(events).toEqual([{ kind: 'result', subtype: 'failed', result: 'blew up', sessionId: 't1' }]);
  });

  it('prefers the tool name, then the command, then the item type', () => {
    const ctx: CodexLineContext = { threadId: 't1' };
    expect(
      codexEventsFromLine(
        codexLine({ type: 'item.completed', item: { type: 'x', name: 'n', command: 'c' } }),
        ctx,
      ),
    ).toEqual([{ kind: 'tool', name: 'n', sessionId: 't1' }]);
    expect(
      codexEventsFromLine(codexLine({ type: 'item.completed', item: { type: 'x', command: 'c' } }), ctx),
    ).toEqual([{ kind: 'tool', name: 'command:c', sessionId: 't1' }]);
    expect(
      codexEventsFromLine(codexLine({ type: 'item.completed', item: { type: 'x' } }), ctx),
    ).toEqual([{ kind: 'tool', name: 'x', sessionId: 't1' }]);
  });

  it('the codex adapter reports id codex and passes preflight when the CLI is healthy', async () => {
    const adapter = createCodexAdapter({
      probe: okCodexProbe(),
      spawn: fakeCodexSpawn().spawn,
      isGitRepo: () => true,
    });
    expect(adapter.id).toBe('codex');
    expect(await adapter.preflight()).toEqual({ ok: true });
    expect(adapter.planStart({ cwd: '/tmp/x', prompt: 'p', tools: 'readonly' })).toEqual({
      ok: true,
      trustOverride: false,
    });
  });
});
