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
  CODEX_NO_FINAL_MESSAGE,
  WORKER_EDIT_ALLOW_MCP_TOOLS,
  WORKER_EDIT_DENY_MCP_TOOLS,
  WORKER_READONLY_ALLOW_MCP_TOOLS,
  WORKER_READONLY_DENY_MCP_TOOLS,
  buildCodexArgv,
  buildCodexMcpConfigOverride,
  codexEnabledMcpTools,
  codexEventsFromLine,
  codexVersionSupportsEnforcement,
  createCodexAdapter,
  createRunAdapter,
  parseCodexVersion,
  tomlStringArray,
  verifyCodexResumePolicy,
  type CodexLineContext,
  type CodexProbe,
  type CodexSpawn,
} from '@agent-deck/backend/agent-run';
import { runRunCommand, type RunDeps, type RunMeta } from './run';
import { runRunLogCommand } from './run-status';

const DECK = { id: 'deck-planner', name: 'planner' };

const CODEX_FIXTURE_LINES = fs
  .readFileSync(fileURLToPath(new URL('./run-codex.fixture.jsonl', import.meta.url)), 'utf8')
  .trim()
  .split('\n');
const CODEX_THREAD_ID = (JSON.parse(CODEX_FIXTURE_LINES[0]) as { thread_id: string }).thread_id;

// Synthetic (NOT-482): commentary, reasoning, command and MCP tool items, two
// commentary messages, then the final answer and usage, in codex-cli 0.157.1's
// `exec --json` item shapes.
const CODEX_FINAL_FIXTURE_LINES = fs
  .readFileSync(fileURLToPath(new URL('./run-codex-final.fixture.jsonl', import.meta.url)), 'utf8')
  .trim()
  .split('\n');
const CODEX_FINAL_THREAD_ID = (JSON.parse(CODEX_FINAL_FIXTURE_LINES[0]) as { thread_id: string })
  .thread_id;
const CODEX_FINAL_ANSWER = 'Review verdict: approve. The change is scoped and tested.';

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
  const codex = {
    probe: overrides.probe ?? okCodexProbe(),
    spawn,
    isGitRepo: overrides.isGitRepo ?? (() => true),
  };
  return {
    calls,
    codex,
    // Real adapter behavior with the NOT-669 gate bypassed: these tests
    // exercise argv/event mapping, not the sibling-ticket mapping.
    createAdapter: (client) => ({
      ...createRunAdapter(client, { codex }),
      profileEnforcement: () => ({ ok: true as const }),
    }),
    resolveDeck: async (ref: string) => (ref === DECK.name || ref === DECK.id ? { ...DECK } : null),
    resolveLaunchPlan: (async () => overrides.plan ?? matchingPlan(cwd)) as RunDeps['resolveLaunchPlan'],
    homeDir,
  };
}

function codexArgs(cwd: string, extra: string[] = []): string[] {
  return ['planner', '--client', 'codex', '--cwd', cwd, '--prompt', 'remember kiwi', ...extra];
}

/**
 * Real runs carry the worker token in a `-c` per-run MCP override (NOT-669)
 * plus the NOT-672 enforcement `-c` pairs; assert the argv around them (the
 * endpoint comes from env, the token is random).
 */
function expectRunArgv(argv: string[], resume: boolean, tools: RunToolsProfile, tail: string[]): void {
  const head = resume ? ['exec', 'resume'] : ['exec'];
  expect(argv.slice(0, head.length)).toEqual(head);
  const rest = argv.slice(head.length);
  expect(rest[0]).toBe('-c');
  expect(rest[1]).toMatch(/^mcp_servers\.agent-deck=\{url="http:\/\/[^"]+\/mcp",http_headers=\{/);
  expect(rest[1]).toContain('"x-agent-deck-run-token"');
  expect(rest[1]).toMatch(/"x-agent-deck-run-token"="[0-9a-f]{64}"/);
  expect(rest[1]).toContain('default_tools_approval_mode="approve"');
  expect(rest[1]).toContain('enabled_tools=');
  expect(rest[2]).toBe('-c');
  expect(rest[3]).toBe('approval_policy="never"');
  let tailStart = 4;
  if (tools === 'edit') {
    expect(rest[4]).toBe('-c');
    expect(rest[5]).toBe('sandbox_workspace_write.network_access=true');
    expect(rest[6]).toBe('-c');
    expect(rest[7]).toMatch(/^sandbox_workspace_write\.writable_roots=\["[^"]+","[^"]+"\]/);
    tailStart = 8;
  } else {
    expect(rest.slice(4).join(' ')).not.toContain('sandbox_workspace_write');
  }
  expect(rest.slice(tailStart)).toEqual(tail);
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

/** A successful turn; appends a final `agent_message` when `items` has none. */
function successStream(threadId: string, items: unknown[] = []): string[] {
  const hasMessage = items.some(
    (item) => (item as { type?: string }).type === 'agent_message',
  );
  const finalItems = hasMessage
    ? items
    : [...items, { id: 'item_final', type: 'agent_message', text: 'done' }];
  return [
    codexLine({ type: 'thread.started', thread_id: threadId }),
    ...finalItems.map((item) => codexLine({ type: 'item.completed', item })),
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
    expect(lines[2]['result']).toBe('OK');
    expect(lines[2]['usage']).toEqual({
      input_tokens: 18324,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    });
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
    expect(lines.map((line) => line.t)).toEqual(['tool', 'tool', 'text', 'result', 'end']);
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
    expect(lines.map((line) => line.t)).toEqual(['notice', 'text', 'result', 'end']);
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

describe('codex final assistant result (NOT-482)', () => {
  it('commentary, tools, final message, and usage yield one success result carrying the final text', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, { lines: CODEX_FINAL_FIXTURE_LINES });

    expect(await runRunCommand(codexArgs(cwd), deps)).toBe(0);

    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual([
      'text',
      'tool',
      'tool',
      'text',
      'text',
      'result',
      'end',
    ]);
    // Streaming text stays observable, final answer included.
    expect(lines.filter((line) => line.t === 'text').map((line) => line.text)).toEqual([
      "I'll check the deck binding and the diff first.",
      'Looking at the changed files now.',
      CODEX_FINAL_ANSWER,
    ]);
    const results = lines.filter((line) => line.t === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      t: 'result',
      subtype: 'success',
      sessionId: CODEX_FINAL_THREAD_ID,
      result: CODEX_FINAL_ANSWER,
      usage: {
        input_tokens: 24110,
        cached_input_tokens: 3072,
        output_tokens: 212,
        reasoning_output_tokens: 64,
      },
    });
    expect(typeof results[0]['result']).toBe('string');
    expect(readMeta(logPathFromStdout())).toMatchObject({
      state: 'ended',
      sessionId: CODEX_FINAL_THREAD_ID,
    });
  });

  it('a completed turn with no assistant message fails explicitly instead of an empty success', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: [
        codexLine({ type: 'thread.started', thread_id: 'thread_silent' }),
        codexLine({ type: 'turn.started' }),
        codexLine({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls' } }),
        codexLine({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 0 } }),
      ],
    });

    const code = await runRunCommand(codexArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['tool', 'result', 'end']);
    expect(lines[1]).toMatchObject({
      t: 'result',
      subtype: 'failed',
      sessionId: 'thread_silent',
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    expect(String(lines[1]['result'])).toContain('without a final assistant message');
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error', sessionId: 'thread_silent' });
  });

  it('run log --json --follow preserves the final string result, session id, and terminal event', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir, { lines: CODEX_FINAL_FIXTURE_LINES });

    expect(await runRunCommand(codexArgs(cwd), deps)).toBe(0);
    const runId = (logs.at(-1)?.match(/^run (\S+) /) ?? [])[1] ?? '';
    expect(runId).toMatch(/^run-/);

    logs.length = 0;
    expect(await runRunLogCommand([runId, '--json', '--follow'], { homeDir, followPollMs: 10 })).toBe(0);

    const printed = logs
      .join('\n')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(printed.map((line) => line.t)).toEqual(['text', 'tool', 'tool', 'text', 'text', 'result', 'end']);
    expect(printed.at(-2)).toMatchObject({
      t: 'result',
      subtype: 'success',
      sessionId: CODEX_FINAL_THREAD_ID,
      result: CODEX_FINAL_ANSWER,
      usage: { input_tokens: 24110 },
    });
    expect(printed.at(-1)).toMatchObject({ t: 'end', sessionId: CODEX_FINAL_THREAD_ID });
  });
});

describe('codex argv and tool profiles (NOT-404)', () => {
  const PROMPT = 'remember kiwi';

  it.each([
    ['readonly', true],
    ['edit', true],
    ['readonly', false],
    ['edit', false],
  ])('start argv for --tools %s (git repo: %s)', (tools, insideGitRepo) => {
    const profile = tools as RunToolsProfile;
    const argv = buildCodexArgv({
      prompt: PROMPT,
      tools: profile,
      insideGitRepo: insideGitRepo as boolean,
      workspaceRoot: '/work/repo',
      ...(profile === 'edit' ? { homeDir: '/home/agent' } : {}),
    });
    // -c pairs first (MCP table, approval policy, edit-only sandbox
    // overrides), then the fixed flags, then the `--` terminator + prompt.
    expect(argv[0]).toBe('exec');
    expect(argv[1]).toBe('-c');
    expect(argv[2]).toMatch(/^mcp_servers\.agent-deck=\{/);
    expect(argv[3]).toBe('-c');
    expect(argv[4]).toBe('approval_policy="never"');
    const afterPolicy = profile === 'edit' ? argv.slice(9) : argv.slice(5);
    if (profile === 'edit') {
      expect(argv.slice(5, 9)).toEqual([
        '-c',
        'sandbox_workspace_write.network_access=true',
        '-c',
        'sandbox_workspace_write.writable_roots=["/work/repo","/home/agent"]',
      ]);
    }
    expect(afterPolicy).toEqual([
      '--json',
      ...((insideGitRepo as boolean) ? [] : ['--skip-git-repo-check']),
      '-s',
      profile === 'edit' ? 'workspace-write' : 'read-only',
      '--',
      PROMPT,
    ]);
  });

  it('readonly produces -s read-only on a real run', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(await runRunCommand(codexArgs(cwd, ['--tools', 'readonly']), deps)).toBe(0);

    expect(deps.calls).toHaveLength(1);
    expectRunArgv(deps.calls[0].argv, false, 'readonly', ['--json', '-s', 'read-only', '--', 'remember kiwi']);
    expect(deps.calls[0].cwd).toBe(cwd);
    expect(readMeta(logPathFromStdout())).toMatchObject({ tools: 'readonly' });
  });

  it('edit produces -s workspace-write on a real run', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(await runRunCommand(codexArgs(cwd, ['--tools', 'edit']), deps)).toBe(0);

    expectRunArgv(deps.calls[0].argv, false, 'edit', ['--json', '-s', 'workspace-write', '--', 'remember kiwi']);
    expect(readMeta(logPathFromStdout())).toMatchObject({ tools: 'edit' });
  });

  it('no generated argv ever contains --dangerously-bypass-approvals-and-sandbox', () => {
    const profiles: RunToolsProfile[] = ['readonly', 'edit'];
    for (const tools of profiles) {
      for (const insideGitRepo of [true, false]) {
        for (const resumeId of [undefined, 'thread_abc']) {
          const argv = buildCodexArgv({
            prompt: 'p',
            tools,
            insideGitRepo,
            workspaceRoot: '/work/repo',
            ...(tools === 'edit' ? { homeDir: '/home/agent' } : {}),
            ...(resumeId ? { resumeId } : {}),
          });
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
      buildCodexArgv({
        prompt: 'p',
        tools: 'readonly',
        insideGitRepo: true,
        resumeId,
        workspaceRoot: '/work/repo',
      }),
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
    // No Agent Deck run ever captured a dash-leading id, so provenance rejects it first.
    expect(errors.join('\n')).toMatch(
      /Cannot resume codex session --dangerously-bypass-approvals-and-sandbox: no Agent Deck run on this host started it/,
    );
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
        workspaceRoot: '/work/repo',
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
        resumeId ? ['-c', '-c', '--json'] : ['-c', '-c', '--json', '-s'],
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
    expect(await runRunCommand(codexArgs(cwd), makeDeps(cwd, homeDir))).toBe(0);
    const originLog = logPathFromStdout();
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream(CODEX_THREAD_ID, [
        { id: 'item_9', type: 'agent_message', text: 'kiwi' },
      ]),
    });

    const code = await runRunCommand(codexArgs(cwd, ['--resume', CODEX_THREAD_ID]), deps);

    expect(code).toBe(0);
    expectRunArgv(deps.calls[0].argv, true, 'readonly', ['--json', '--', CODEX_THREAD_ID, 'remember kiwi']);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['notice', 'text', 'result', 'end']);
    expect(String(lines[0]['message'])).toContain('keeps its original sandbox');
    expect(lines.at(-1)).toMatchObject({ t: 'end', sessionId: CODEX_THREAD_ID });
    expect(readMeta(logPathFromStdout()).resumedFrom).toEqual({
      runId: readMeta(originLog).runId,
      sessionId: CODEX_THREAD_ID,
      tools: 'readonly',
    });
  });

  it('an edit run resumes with --tools edit and status shows both runs on one session (NOT-484)', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const first = makeDeps(cwd, homeDir);
    expect(await runRunCommand(codexArgs(cwd, ['--tools', 'edit']), first)).toBe(0);
    const originRunId = readMeta(logPathFromStdout()).runId;
    expect(first.calls[0].argv).toContain('workspace-write');

    const deps = makeDeps(cwd, homeDir);
    expect(await runRunCommand(codexArgs(cwd, ['--resume', CODEX_THREAD_ID, '--tools', 'edit']), deps)).toBe(0);

    expectRunArgv(deps.calls[0].argv, true, 'edit', ['--json', '--', CODEX_THREAD_ID, 'remember kiwi']);
    for (const call of [...first.calls, ...deps.calls]) {
      expect(call.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    }
    const resumedMeta = readMeta(logPathFromStdout());
    expect(resumedMeta).toMatchObject({
      tools: 'edit',
      sessionId: CODEX_THREAD_ID,
      resumedFrom: { runId: originRunId, sessionId: CODEX_THREAD_ID, tools: 'edit' },
    });

    logs = [];
    expect(await runRunCommand(['status', resumedMeta.runId], { homeDir })).toBe(0);
    expect(logs).toContain(`  session ${CODEX_THREAD_ID}`);
    expect(logs).toContain(`  resumed from ${originRunId} (--tools edit)`);
    logs = [];
    expect(await runRunCommand(['status', originRunId, '--json'], { homeDir })).toBe(0);
    expect(JSON.parse(logs[0])).toMatchObject({ runId: originRunId, sessionId: CODEX_THREAD_ID });
  });

  it('a readonly run resumed with --tools edit fails closed before spawning', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    expect(await runRunCommand(codexArgs(cwd), makeDeps(cwd, homeDir))).toBe(0);
    const runsBefore = fs.readdirSync(path.join(homeDir, 'runs'));
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(
      codexArgs(cwd, ['--resume', CODEX_THREAD_ID, '--tools', 'edit']),
      deps,
    );

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/started it with --tools readonly, and a resumed codex thread keeps its original sandbox/);
    expect(fs.readdirSync(path.join(homeDir, 'runs'))).toEqual(runsBefore);
  });

  it('an unknown session resumed with --tools edit fails closed before spawning', async () => {
    const cwd = makeDir('agent-deck-codex-cwd-');
    const homeDir = makeDir('agent-deck-codex-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(
      codexArgs(cwd, ['--resume', CODEX_THREAD_ID, '--tools', 'edit']),
      deps,
    );

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/no Agent Deck run on this host started it/);
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

  it('turn.completed carries the last agent message of the turn and usage separately', () => {
    const events = parse([
      codexLine({ type: 'thread.started', thread_id: 't1' }),
      codexLine({ type: 'turn.started' }),
      codexLine({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      codexLine({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
      codexLine({ type: 'turn.completed', usage: { output_tokens: 2 } }),
    ]);
    expect(events.at(-1)).toEqual({
      kind: 'result',
      subtype: 'success',
      result: 'final',
      usage: { output_tokens: 2 },
      sessionId: 't1',
    });
  });

  it('a new turn does not inherit the previous turn\'s final message', () => {
    const events = parse([
      codexLine({ type: 'turn.started' }),
      codexLine({ type: 'item.completed', item: { type: 'agent_message', text: 'old' } }),
      codexLine({ type: 'turn.completed' }),
      codexLine({ type: 'turn.started' }),
      codexLine({ type: 'turn.completed' }),
    ]);
    expect(events.filter((event) => event.kind === 'result')).toEqual([
      { kind: 'result', subtype: 'success', result: 'old' },
      { kind: 'result', subtype: 'failed', result: CODEX_NO_FINAL_MESSAGE },
    ]);
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

describe('codex worker profile enforcement (NOT-672)', () => {
  const VERSION_169: CodexProbe = (bin: string, argv: string[]) =>
    argv[0] === '--version'
      ? { code: 0, stdout: 'codex-cli 0.169.0\n', stderr: '' }
      : { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };

  function versionProbe(stdout: string, code = 0): CodexProbe {
    return () => ({ code, stdout, stderr: '' });
  }

  function writeRollout(
    codexHome: string,
    threadId: string,
    lines: unknown[],
    stamp = '2026-11-25T00-00-00',
  ): string {
    const dir = path.join(codexHome, 'sessions', '2026', '11', '25');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${stamp}-${threadId}.jsonl`);
    fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    return file;
  }

  function rolloutLines(
    threadId: string,
    policies: Array<{ approval: unknown; sandbox: unknown }>,
  ): unknown[] {
    return [
      { type: 'session_meta', payload: { session_id: threadId, id: threadId, cwd: '/work' } },
      ...policies.map((policy, index) => ({
        type: 'turn_context',
        payload: {
          turn_id: `turn-${index}`,
          cwd: '/work',
          approval_policy: policy.approval,
          sandbox_policy: policy.sandbox,
        },
      })),
    ];
  }

  it('parses codex versions and gates enforcement at 0.169.0', () => {
    expect(parseCodexVersion('codex-cli 0.169.0\n')).toEqual([0, 169, 0]);
    expect(parseCodexVersion('codex-cli 0.157.1\n')).toEqual([0, 157, 1]);
    expect(parseCodexVersion('no version here')).toBeNull();
    expect(codexVersionSupportsEnforcement([0, 169, 0])).toBe(true);
    expect(codexVersionSupportsEnforcement([0, 170, 0])).toBe(true);
    expect(codexVersionSupportsEnforcement([1, 0, 0])).toBe(true);
    expect(codexVersionSupportsEnforcement([0, 168, 9])).toBe(false);
    expect(codexVersionSupportsEnforcement([0, 157, 1])).toBe(false);
  });

  it('builds TOML string arrays with escaping', () => {
    expect(tomlStringArray(['a', 'b'])).toBe('["a","b"]');
    expect(tomlStringArray([])).toBe('[]');
    expect(tomlStringArray(['/w"o\\rk'])).toBe('["/w\\"o\\\\rk"]');
  });

  it.each(['readonly', 'edit'] as const)(
    'the per-run MCP table carries the %s allow set and approve-everything approvals',
    (profile) => {
      const table = buildCodexMcpConfigOverride(
        { workspaceRoot: '/work/repo', tools: profile, runToken: 't'.repeat(64) },
        { port: '1110', host: '127.0.0.1' },
      );
      const allow = profile === 'edit' ? WORKER_EDIT_ALLOW_MCP_TOOLS : WORKER_READONLY_ALLOW_MCP_TOOLS;
      const deny = profile === 'edit' ? WORKER_EDIT_DENY_MCP_TOOLS : WORKER_READONLY_DENY_MCP_TOOLS;
      expect(codexEnabledMcpTools(profile)).toEqual([...allow]);
      expect(table).toContain(`enabled_tools=${tomlStringArray(allow)}`);
      expect(table).toContain('default_tools_approval_mode="approve"');
      for (const tool of allow) {
        expect(table).toContain(`"${tool}"={approval_mode="approve"}`);
      }
      // No denied tool is enabled or approved: switch_deck/start_run never
      // reach the worker, in either profile.
      for (const tool of deny) {
        expect(table).not.toContain(`"${tool}"`);
      }
      expect(table).toContain('"x-agent-deck-run-token"="');
    },
  );

  it('an edit run without a home directory fails closed in the builder', () => {
    expect(() =>
      buildCodexArgv({ prompt: 'p', tools: 'edit', insideGitRepo: true, workspaceRoot: '/work' }),
    ).toThrow(/without homeDir/);
    // Readonly needs no home: no writable-roots override is built.
    const argv = buildCodexArgv({
      prompt: 'p',
      tools: 'readonly',
      insideGitRepo: true,
      workspaceRoot: '/work',
    });
    expect(argv.join(' ')).not.toContain('writable_roots');
  });

  it('start passes enforcement on a verified codex and fails closed below it', () => {
    const args = { cwd: '/work', prompt: 'p', tools: 'readonly' as const };
    expect(
      createCodexAdapter({ probe: VERSION_169, isGitRepo: () => true }).profileEnforcement(args),
    ).toEqual({ ok: true });

    for (const [label, stdout, code] of [
      ['older release', 'codex-cli 0.157.1\n', 0],
      ['unparseable', 'codex\n', 0],
      ['failed probe', '', 1],
    ] as const) {
      const verdict = createCodexAdapter({
        probe: versionProbe(stdout, code),
        isGitRepo: () => true,
      }).profileEnforcement(args);
      expect(verdict.ok, label).toBe(false);
      if (!verdict.ok) {
        expect(verdict.remedy).toMatch(/0\.169\.0\+ is required for worker profile enforcement/);
      }
    }
  });

  it('resume verifies the recorded effective policy for both profiles', () => {
    const codexHome = makeDir('agent-deck-codex-home-');
    const cwd = makeDir('agent-deck-codex-cwd-');
    const home = makeDir('agent-deck-agent-home-');
    const readonlyThread = '019a0000-0000-7000-8000-00000000c0de';
    const editThread = '019a0000-0000-7000-8000-00000000c0df';
    writeRollout(codexHome, readonlyThread, rolloutLines(readonlyThread, [{ approval: 'never', sandbox: { type: 'read-only' } }]));
    writeRollout(
      codexHome,
      editThread,
      rolloutLines(editThread, [
        {
          approval: 'never',
          sandbox: { type: 'workspace-write', writable_roots: [cwd, home], network_access: true },
        },
      ]),
    );

    const adapter = createCodexAdapter({ probe: VERSION_169, isGitRepo: () => true, codexHome, homeDir: home });
    expect(
      adapter.profileEnforcement({
        cwd,
        prompt: 'again',
        tools: 'readonly',
        resumeId: readonlyThread,
        resumedFrom: { runId: 'run-1', sessionId: readonlyThread, tools: 'readonly' },
      }),
    ).toEqual({ ok: true });
    expect(
      adapter.profileEnforcement({
        cwd,
        prompt: 'again',
        tools: 'edit',
        resumeId: editThread,
        resumedFrom: { runId: 'run-2', sessionId: editThread, tools: 'edit' },
      }),
    ).toEqual({ ok: true });
    // A parent root covers a nested workspace.
    expect(
      verifyCodexResumePolicy({ codexHome, threadId: editThread, tools: 'edit', cwd: path.join(cwd, 'sub'), homeDir: home }),
    ).toEqual({ ok: true });
  });

  it('resume fails closed on a missing, unproven, or incompatible recording', () => {
    const codexHome = makeDir('agent-deck-codex-home-');
    const cwd = makeDir('agent-deck-codex-cwd-');
    const home = makeDir('agent-deck-agent-home-');
    const adapter = createCodexAdapter({ probe: VERSION_169, isGitRepo: () => true, codexHome, homeDir: home });
    const resume = (threadId: string, tools: 'readonly' | 'edit', resumedFrom?: { runId: string; sessionId: string; tools: 'readonly' | 'edit' }) =>
      adapter.profileEnforcement({
        cwd,
        prompt: 'again',
        tools,
        resumeId: threadId,
        ...(resumedFrom ? { resumedFrom } : {}),
      });

    // No rollout at all: the sandbox cannot be verified.
    const missing = resume('019a0000-0000-7000-8000-00000000c1de', 'readonly', {
      runId: 'run-1',
      sessionId: '019a0000-0000-7000-8000-00000000c1de',
      tools: 'readonly',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.remedy).toMatch(/effective sandbox cannot be verified/);
    }

    // A filename match alone proves nothing: the content names another thread.
    const spoofed = '019a0000-0000-7000-8000-00000000c2de';
    writeRollout(codexHome, spoofed, rolloutLines('019a0000-0000-7000-8000-00000000ffff', [{ approval: 'never', sandbox: { type: 'read-only' } }]));
    const unproven = resume(spoofed, 'readonly', { runId: 'run-1', sessionId: spoofed, tools: 'readonly' });
    expect(unproven.ok).toBe(false);
    if (!unproven.ok) {
      expect(unproven.remedy).toMatch(/effective sandbox cannot be verified/);
    }

    // Sandbox mismatch both directions.
    const writableThread = '019a0000-0000-7000-8000-00000000c3de';
    writeRollout(
      codexHome,
      writableThread,
      rolloutLines(writableThread, [
        { approval: 'never', sandbox: { type: 'workspace-write', writable_roots: [cwd, home], network_access: true } },
      ]),
    );
    const mislabeled = resume(writableThread, 'readonly', { runId: 'run-1', sessionId: writableThread, tools: 'readonly' });
    expect(mislabeled.ok).toBe(false);
    if (!mislabeled.ok) {
      expect(mislabeled.remedy).toMatch(/does not satisfy the profile/);
      expect(mislabeled.remedy).toMatch(/sandbox "workspace-write" \(want "read-only"\)/);
    }

    const readOnlyThread = '019a0000-0000-7000-8000-00000000c4de';
    writeRollout(codexHome, readOnlyThread, rolloutLines(readOnlyThread, [{ approval: 'never', sandbox: { type: 'read-only' } }]));
    const escalated = resume(readOnlyThread, 'edit', { runId: 'run-1', sessionId: readOnlyThread, tools: 'edit' });
    expect(escalated.ok).toBe(false);
    if (!escalated.ok) {
      expect(escalated.remedy).toMatch(/does not satisfy the profile/);
      expect(escalated.remedy).toMatch(/sandbox "read-only" \(want "workspace-write"\)/);
    }

    // Edit without network access or without home coverage: incompatible.
    const noNetwork = '019a0000-0000-7000-8000-00000000c5de';
    writeRollout(
      codexHome,
      noNetwork,
      rolloutLines(noNetwork, [{ approval: 'never', sandbox: { type: 'workspace-write', writable_roots: [cwd, home] } }]),
    );
    const networkVerdict = resume(noNetwork, 'edit', { runId: 'run-1', sessionId: noNetwork, tools: 'edit' });
    expect(networkVerdict.ok).toBe(false);
    if (!networkVerdict.ok) {
      expect(networkVerdict.remedy).toMatch(/network_access .* \(want true\)/);
    }

    const noHome = '019a0000-0000-7000-8000-00000000c6de';
    writeRollout(
      codexHome,
      noHome,
      rolloutLines(noHome, [{ approval: 'never', sandbox: { type: 'workspace-write', writable_roots: [cwd], network_access: true } }]),
    );
    const homeVerdict = resume(noHome, 'edit', { runId: 'run-1', sessionId: noHome, tools: 'edit' });
    expect(homeVerdict.ok).toBe(false);
    if (!homeVerdict.ok) {
      expect(homeVerdict.remedy).toMatch(/missing the agent home/);
    }

    // An approval-taking thread is never resumed headless.
    const asking = '019a0000-0000-7000-8000-00000000c7de';
    writeRollout(codexHome, asking, rolloutLines(asking, [{ approval: 'on-request', sandbox: { type: 'read-only' } }]));
    const askingVerdict = resume(asking, 'readonly', { runId: 'run-1', sessionId: asking, tools: 'readonly' });
    expect(askingVerdict.ok).toBe(false);
    if (!askingVerdict.ok) {
      expect(askingVerdict.remedy).toMatch(/approval_policy "on-request" \(want "never"\)/);
    }

    // Defense in depth behind planStart: no provenance, no resume.
    const unproven2 = resume(readOnlyThread, 'readonly');
    expect(unproven2.ok).toBe(false);
    if (!unproven2.ok) {
      expect(unproven2.remedy).toMatch(/no trusted Agent Deck run is known to have started it/);
    }
  });
});
