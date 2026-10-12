import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeAssignment } from './assignment';
import { runCli, suggestTopLevelCommand } from './index';
import { resolveMcpLaunchPlan, type McpLaunchPlan } from './mcp-launcher';
import {
  runRunCommand,
  type RunDeps,
  type RunMeta,
  type RunQueryFn,
  type RunQueryMessage,
} from './run';

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECK = { id: 'deck-planner', name: 'planner' };

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

function successMessages(sessionId = 'ses_1'): RunQueryMessage[] {
  return [
    {
      type: 'assistant',
      session_id: sessionId,
      message: {
        content: [
          { type: 'text', text: 'hello from the session' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    },
    { type: 'result', subtype: 'success', session_id: sessionId, result: 'done' },
  ];
}

/** Fake `query()` that captures its params and replays canned messages. */
function fakeQuery(messages: RunQueryMessage[] | Error): {
  query: RunQueryFn & ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async function* (params: {
    prompt: string;
    options: Record<string, unknown>;
  }): AsyncGenerator<RunQueryMessage> {
    void params;
    if (messages instanceof Error) {
      throw messages;
    }
    yield* messages;
  });
  return { query: query as unknown as RunQueryFn & ReturnType<typeof vi.fn> };
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

function makeDeps(
  cwd: string,
  homeDir: string,
  messages: RunQueryMessage[] | Error = successMessages(),
  plan: McpLaunchPlan | null = matchingPlan(cwd),
): RunDeps & { query: ReturnType<typeof vi.fn> } {
  const { query } = fakeQuery(messages);
  return {
    query,
    resolveDeck: vi.fn(async (ref: string) =>
      ref === DECK.name || ref === DECK.id ? { ...DECK } : null,
    ),
    resolveLaunchPlan: vi.fn(async () => plan) as unknown as RunDeps['resolveLaunchPlan'],
    homeDir,
  };
}

function baseArgs(cwd: string, extra: string[] = []): string[] {
  return ['planner', '--client', 'claude', '--cwd', cwd, '--prompt', 'one-line brief', ...extra];
}

function readJsonLines(logPath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('agent-deck run (NOT-400)', () => {
  it('writes text/tool/result/end log lines with ISO ts', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(baseArgs(cwd), deps);

    expect(code).toBe(0);
    const loggedOptions = deps.query.mock.calls[0][0] as { prompt: string };
    expect(loggedOptions.prompt).toBe('one-line brief');
    const finalLine = logs.at(-1) ?? '';
    const logPath = (finalLine.match(/log (\S+) sessionId/) ?? [])[1] ?? '';
    expect(logPath).toContain(path.join(homeDir, 'runs'));
    const lines = readJsonLines(logPath);
    expect(lines.map((line) => line.t)).toEqual(['text', 'tool', 'result', 'end']);
    for (const line of lines) {
      expect(line.ts).toMatch(ISO_TS);
    }
    expect(lines[0]).toMatchObject({ t: 'text', text: 'hello from the session' });
    expect(lines[1]).toMatchObject({ t: 'tool', name: 'Read' });
    expect(lines[2]).toMatchObject({ t: 'result', sessionId: 'ses_1', subtype: 'success' });
    expect(lines[3]).toMatchObject({ t: 'end', sessionId: 'ses_1' });
  });

  it('writes meta.json with the run record fields incl tools', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(await runRunCommand(baseArgs(cwd), deps)).toBe(0);

    const runDirs = fs.readdirSync(path.join(homeDir, 'runs'));
    expect(runDirs).toHaveLength(1);
    const meta = JSON.parse(
      fs.readFileSync(path.join(homeDir, 'runs', runDirs[0], 'meta.json'), 'utf8'),
    ) as RunMeta;
    expect(meta.runId).toBe(runDirs[0]);
    expect(meta).toMatchObject({
      deck: DECK.id,
      client: 'claude',
      tools: 'readonly',
      cwd,
      state: 'ended',
      sessionId: 'ses_1',
    });
    expect(meta.pid).toBe(process.pid);
    expect(meta.startedAt).toMatch(ISO_TS);
  });

  it('passes --resume through to query() and keeps the session id under a new log', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const first = makeDeps(cwd, homeDir, successMessages('ses_resume'));
    expect(await runRunCommand(baseArgs(cwd), first)).toBe(0);
    const firstLog = (logs.at(-1)?.match(/log (\S+) sessionId/) ?? [])[1] ?? '';

    logs = [];
    const second = makeDeps(cwd, homeDir, successMessages('ses_resume'));
    const code = await runRunCommand(baseArgs(cwd, ['--resume', 'ses_resume']), second);

    expect(code).toBe(0);
    const params = second.query.mock.calls[0][0] as { options: { resume?: string } };
    expect(params.options.resume).toBe('ses_resume');
    const secondLog = (logs.at(-1)?.match(/log (\S+) sessionId/) ?? [])[1] ?? '';
    expect(secondLog).not.toBe(firstLog);
    const lines = readJsonLines(secondLog);
    expect(lines.at(-1)).toMatchObject({ t: 'end', sessionId: 'ses_resume' });
  });

  it.each(['cursor'])('--client %s exits non-zero without calling query()', async (client) => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(
      ['planner', '--client', client, '--cwd', cwd, '--prompt', 'brief'],
      deps,
    );

    expect(code).not.toBe(0);
    expect(deps.query).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/not available yet/);
  });

  it('deck mismatch exits non-zero before any query() call', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const deps = makeDeps(cwd, homeDir, successMessages(), {
      ...matchingPlan(cwd),
      deckId: 'deck-other',
      deckName: 'other',
    });

    const code = await runRunCommand(baseArgs(cwd), deps);

    expect(code).not.toBe(0);
    expect(deps.query).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/mis-bound/);
  });

  it('missing assignment exits non-zero before any query() call', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const deps = makeDeps(cwd, homeDir, successMessages(), {
      workspaceRoot: cwd,
      mcpUrl: 'http://127.0.0.1:1110/mcp',
      headers: [],
      unassigned: true,
    });

    const code = await runRunCommand(baseArgs(cwd), deps);

    expect(code).not.toBe(0);
    expect(deps.query).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/No deck assigned/);
  });

  it('unknown deck exits non-zero before any query() call', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(baseArgs(cwd).map((arg) => (arg === 'planner' ? 'nope' : arg)), deps);

    expect(code).not.toBe(0);
    expect(deps.query).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/Deck not found/);
  });

  it('a query() failure writes an error line, marks meta error, and exits non-zero', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const deps = makeDeps(cwd, homeDir, new Error('boom happened'));

    const code = await runRunCommand(baseArgs(cwd), deps);

    expect(code).not.toBe(0);
    const finalLine = logs.at(-1) ?? '';
    const logPath = (finalLine.match(/log (\S+) sessionId/) ?? [])[1] ?? '';
    const lines = readJsonLines(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ t: 'error', message: 'boom happened', sessionId: null });
    expect(lines[0].ts).toMatch(ISO_TS);
    const meta = JSON.parse(
      fs.readFileSync(path.join(path.dirname(logPath), 'meta.json'), 'utf8'),
    ) as RunMeta;
    expect(meta.state).toBe('error');
    expect(finalLine).toContain('sessionId unknown');
  });

  it('a non-success result still writes end but exits non-zero', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const deps = makeDeps(cwd, homeDir, [
      { type: 'result', subtype: 'error_max_turns', session_id: 'ses_2' },
    ]);

    const code = await runRunCommand(baseArgs(cwd), deps);

    expect(code).not.toBe(0);
    const logPath = (logs.at(-1)?.match(/log (\S+) sessionId/) ?? [])[1] ?? '';
    const lines = readJsonLines(logPath);
    expect(lines.map((line) => line.t)).toEqual(['result', 'end']);
    expect(lines[0]).toMatchObject({ subtype: 'error_max_turns', sessionId: 'ses_2' });
    expect(lines[1]).toMatchObject({ t: 'end', sessionId: 'ses_2' });
  });

  it('does not rewrite the existing .agent-deck/use.json in --cwd', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    await writeAssignment(cwd, { deckId: DECK.id, deckName: DECK.name });
    const usePath = path.join(cwd, '.agent-deck', 'use.json');
    const before = fs.readFileSync(usePath, 'utf8');
    const { query } = fakeQuery(successMessages());
    const deps: RunDeps = {
      query,
      resolveDeck: async () => ({ ...DECK }),
      resolveLaunchPlan: resolveMcpLaunchPlan,
      homeDir,
    };

    expect(await runRunCommand(baseArgs(cwd), deps)).toBe(0);

    expect(fs.readFileSync(usePath, 'utf8')).toBe(before);
  });

  it('reads the brief from --prompt-file and honors --log with meta.json next to it', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const promptFile = path.join(cwd, 'brief.md');
    fs.writeFileSync(promptFile, 'file brief text');
    const logPath = path.join(homeDir, 'custom', 'session.jsonl');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(
      ['planner', '--client', 'claude', '--cwd', cwd, '--prompt-file', promptFile, '--log', logPath],
      deps,
    );

    expect(code).toBe(0);
    const params = deps.query.mock.calls[0][0] as { prompt: string };
    expect(params.prompt).toBe('file brief text');
    expect(fs.existsSync(logPath)).toBe(true);
    const meta = JSON.parse(
      fs.readFileSync(path.join(homeDir, 'custom', 'meta.json'), 'utf8'),
    ) as RunMeta;
    expect(meta.state).toBe('ended');
  });

  it.each([
    ['missing brief', ['planner', '--client', 'claude', '--cwd', 'X']],
    ['both briefs', ['planner', '--client', 'claude', '--cwd', 'X', '--prompt', 'a', '--prompt-file', 'b']],
    ['missing client', ['planner', '--cwd', 'X', '--prompt', 'a']],
    ['missing cwd', ['planner', '--client', 'claude', '--prompt', 'a']],
    ['missing deck', ['--client', 'claude', '--cwd', 'X', '--prompt', 'a']],
  ])('invalid args (%s) exit non-zero before any query() call', async (_label, template) => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(template.map((arg) => (arg === 'X' ? cwd : arg)), deps);

    expect(code).not.toBe(0);
    expect(deps.query).not.toHaveBeenCalled();
  });

  it('final stdout line prints the log path and session id', async () => {
    const cwd = makeDir('agent-deck-run-cwd-');
    const homeDir = makeDir('agent-deck-run-home-');
    const deps = makeDeps(cwd, homeDir, successMessages('ses_final'));

    expect(await runRunCommand(baseArgs(cwd), deps)).toBe(0);

    expect(logs.at(-1)).toMatch(/log \S+\.jsonl sessionId ses_final/);
  });

  it('run --help lists the flags via the top-level CLI', async () => {
    const code = await runCli(['node', 'agent-deck', 'run', '--help']);

    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('--tools readonly|edit');
    expect(logs.join('\n')).toContain('--resume');
  });

  it('unknown-command suggestions know about run', () => {
    expect(suggestTopLevelCommand('urn')).toBe('run');
  });
});
