/**
 * Shared ClientAdapter contract (NOT-404), run against the Claude adapter
 * and the Codex adapter with fake client processes: normalized events,
 * session id capture, resume pass-through, tool-profile mapping, preflight
 * failure before start, deck mismatch before start.
 *
 * Every supported client must have a case below (asserted); a new adapter
 * extends the contract by adding a case, without touching run/log/status.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpLaunchPlan } from './mcp-launcher';
import {
  allowedToolsForProfile,
  RUN_SUPPORTED_CLIENTS,
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
  type RunClient,
} from './run-adapter';
import { createClaudeAdapter, type RunQueryFn, type RunQueryMessage } from './run-claude';
import { createCodexAdapter, type CodexProbe, type CodexSpawn } from './run-codex';
import { runRunCommand, type RunDeps } from './run';

const DECK = { id: 'deck-planner', name: 'planner' };

// Verbatim capture from the owner's Mac (codex-cli 0.157.1, /tmp/smoke/cx1.jsonl):
// thread.started, a mid-stream provider error, one agent_message, turn.completed.
const CODEX_FIXTURE_LINES = fs
  .readFileSync(fileURLToPath(new URL('./run-codex.fixture.jsonl', import.meta.url)), 'utf8')
  .trim()
  .split('\n');
const CODEX_THREAD_ID = (JSON.parse(CODEX_FIXTURE_LINES[0]) as { thread_id: string }).thread_id;

const CLAUDE_SESSION_ID = 'ses_contract';

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

function claudeSuccessMessages(): RunQueryMessage[] {
  return [
    {
      type: 'assistant',
      session_id: CLAUDE_SESSION_ID,
      message: {
        content: [
          { type: 'text', text: 'contract hello' },
          { type: 'tool_use', name: 'Read' },
        ],
      },
    },
    { type: 'result', subtype: 'success', session_id: CLAUDE_SESSION_ID, result: 'done' },
  ];
}

function fakeClaudeQuery(
  messages: RunQueryMessage[] = claudeSuccessMessages(),
): RunQueryFn & ReturnType<typeof vi.fn> {
  const query = vi.fn(async function* (): AsyncGenerator<RunQueryMessage> {
    yield* messages;
  });
  return query as unknown as RunQueryFn & ReturnType<typeof vi.fn>;
}

function fakeCodexSpawn(
  lines: string[] = CODEX_FIXTURE_LINES,
  code = 0,
): { spawn: CodexSpawn; calls: Array<{ bin: string; argv: string[]; cwd: string }> } {
  const calls: Array<{ bin: string; argv: string[]; cwd: string }> = [];
  const spawn = vi.fn((bin: string, argv: string[], opts: { cwd: string }) => {
    calls.push({ bin, argv, cwd: opts.cwd });
    return {
      stdout: (async function* (): AsyncGenerator<string> {
        yield* lines;
      })(),
      wait: async () => ({ code, stderrTail: '' }),
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

type ClientLaunchRecord =
  | { client: 'claude'; prompt: string; options: Record<string, unknown> }
  | { client: 'codex'; bin: string; argv: string[]; cwd: string };

type ContractCase = {
  id: RunClient;
  adapter: ClientAdapter;
  expectedKinds: Array<NormalizedEvent['kind']>;
  expectedSessionId: string;
  clientInvocations: () => number;
  launch: (overrides?: Partial<AdapterStartArgs>) => Promise<ClientLaunchRecord>;
  runArgs: (cwd: string, extra?: string[]) => string[];
  runDeps: (cwd: string, homeDir: string) => RunDeps;
  clientRunCalls: (deps: RunDeps) => number;
};

function makeClaudeCase(): ContractCase {
  const query = fakeClaudeQuery();
  const adapter = createClaudeAdapter({ query });
  const baseArgs: AdapterStartArgs = { cwd: '/tmp/contract', prompt: 'brief', tools: 'readonly' };
  return {
    id: 'claude',
    adapter,
    expectedKinds: ['text', 'tool', 'result'],
    expectedSessionId: CLAUDE_SESSION_ID,
    clientInvocations: () => query.mock.calls.length,
    launch: async (overrides = {}) => {
      const callIndex = query.mock.calls.length;
      for await (const _event of adapter.start({ ...baseArgs, ...overrides })) {
        // Drain; the launch record is the assertion surface.
      }
      const params = query.mock.calls[callIndex][0] as {
        prompt: string;
        options: Record<string, unknown>;
      };
      return { client: 'claude', prompt: params.prompt, options: params.options };
    },
    runArgs: (cwd, extra = []) => ['planner', '--client', 'claude', '--cwd', cwd, ...extra],
    runDeps: (cwd, homeDir) => ({
      query: fakeClaudeQuery(),
      resolveDeck: async () => ({ ...DECK }),
      resolveLaunchPlan: async () => matchingPlan(cwd),
      homeDir,
      // The contract covers the adapter, not the NOT-405 CLI preflight;
      // stub the probe passing so the test never depends on machine state.
      claudeProbe: vi.fn(async () => ({ ok: true as const })),
    }),
    clientRunCalls: (deps) => (deps.query as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
  };
}

function makeCodexCase(): ContractCase {
  const { spawn, calls } = fakeCodexSpawn();
  const adapter = createCodexAdapter({ probe: okCodexProbe(), spawn, isGitRepo: () => true });
  const baseArgs: AdapterStartArgs = { cwd: '/tmp/contract', prompt: 'brief', tools: 'readonly' };
  return {
    id: 'codex',
    adapter,
    expectedKinds: ['notice', 'text', 'result'],
    expectedSessionId: CODEX_THREAD_ID,
    clientInvocations: () => calls.length,
    launch: async (overrides = {}) => {
      for await (const _event of adapter.start({ ...baseArgs, ...overrides })) {
        // Drain; the launch record is the assertion surface.
      }
      const last = calls.at(-1) ?? { bin: '', argv: [] as string[], cwd: '' };
      return { client: 'codex', bin: last.bin, argv: last.argv, cwd: last.cwd };
    },
    runArgs: (cwd, extra = []) => ['planner', '--client', 'codex', '--cwd', cwd, ...extra],
    runDeps: (cwd, homeDir) => {
      const { spawn: runSpawn } = fakeCodexSpawn();
      return {
        codex: { probe: okCodexProbe(), spawn: runSpawn, isGitRepo: () => true },
        resolveDeck: async () => ({ ...DECK }),
        resolveLaunchPlan: async () => matchingPlan(cwd),
        homeDir,
      };
    },
    clientRunCalls: (deps) =>
      (deps.codex?.spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
  };
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

function expectWellFormed(event: NormalizedEvent): void {
  switch (event.kind) {
    case 'text':
      expect(typeof event.text).toBe('string');
      expect(event.text.length).toBeGreaterThan(0);
      break;
    case 'tool':
      expect(typeof event.name).toBe('string');
      expect(event.name.length).toBeGreaterThan(0);
      break;
    case 'result':
      expect(typeof event.subtype).toBe('string');
      expect('result' in event).toBe(true);
      break;
    case 'notice':
      expect(typeof event.message).toBe('string');
      expect(event.message.length).toBeGreaterThan(0);
      break;
    default:
      expect.unreachable(`unknown normalized kind: ${JSON.stringify(event)}`);
  }
  if (event.sessionId !== undefined) {
    expect(event.sessionId.length).toBeGreaterThan(0);
  }
}

const CASES = [
  { id: 'claude', make: makeClaudeCase },
  { id: 'codex', make: makeCodexCase },
] as const;

describe('adapter contract coverage', () => {
  it('covers every supported client', () => {
    expect(CASES.map((entry) => entry.id)).toEqual([...RUN_SUPPORTED_CLIENTS]);
  });
});

describe.each(CASES)('adapter contract: $id', ({ make }) => {
  it('emits well-formed normalized events in order', async () => {
    const kase = make();

    const events: NormalizedEvent[] = [];
    for await (const event of kase.adapter.start({
      cwd: '/tmp/contract',
      prompt: 'brief',
      tools: 'readonly',
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.kind)).toEqual(kase.expectedKinds);
    for (const event of events) {
      expectWellFormed(event);
    }
  });

  it('captures the client session id on the result', async () => {
    const kase = make();

    const events: NormalizedEvent[] = [];
    for await (const event of kase.adapter.start({
      cwd: '/tmp/contract',
      prompt: 'brief',
      tools: 'readonly',
    })) {
      events.push(event);
    }

    const last = events.at(-1);
    expect(last?.kind).toBe('result');
    expect(last).toMatchObject({ sessionId: kase.expectedSessionId });
  });

  it('passes resume through to the client process', async () => {
    const kase = make();

    const record = await kase.launch({ resumeId: 'resume_contract_1' });

    if (record.client === 'claude') {
      expect(record.options['resume']).toBe('resume_contract_1');
    } else {
      expect(record.argv[0]).toBe('exec');
      expect(record.argv[1]).toBe('resume');
      // The thread id and prompt are positionals after the `--` terminator,
      // so neither can be parsed as a resume option.
      const sep = record.argv.indexOf('--');
      expect(sep).toBeGreaterThan(0);
      expect(record.argv.slice(sep + 1)).toEqual(['resume_contract_1', 'brief']);
    }
  });

  it('maps the readonly and edit tool profiles', async () => {
    const kase = make();

    const readonlyRecord = await kase.launch({ tools: 'readonly' });
    const editRecord = await kase.launch({ tools: 'edit' });

    if (readonlyRecord.client === 'claude' && editRecord.client === 'claude') {
      expect(readonlyRecord.options['allowedTools']).toEqual([
        ...allowedToolsForProfile('readonly'),
      ]);
      expect(editRecord.options['allowedTools']).toEqual([...allowedToolsForProfile('edit')]);
      expect(readonlyRecord.options['permissionMode']).toBe('acceptEdits');
      expect(JSON.stringify(editRecord.options)).not.toContain('bypassPermissions');
    } else if (readonlyRecord.client === 'codex' && editRecord.client === 'codex') {
      expect(readonlyRecord.argv).toContain('-s');
      expect(readonlyRecord.argv).toContain('read-only');
      expect(editRecord.argv).toContain('workspace-write');
      for (const record of [readonlyRecord, editRecord]) {
        expect(record.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      }
    } else {
      expect.unreachable('mixed client records');
    }
  });

  it('preflight failure exits non-zero before the client starts', async () => {
    const cwd = makeDir('agent-deck-contract-cwd-');
    const homeDir = makeDir('agent-deck-contract-home-');
    const kase = make();
    let deps: RunDeps;
    let invocations: () => number;
    if (kase.id === 'claude') {
      const loadQuery = vi.fn(() => {
        throw new Error('contract sdk missing');
      });
      deps = {
        claude: { loadQuery },
        resolveDeck: async () => ({ ...DECK }),
        resolveLaunchPlan: async () => matchingPlan(cwd),
        homeDir,
        // Pass the NOT-405 CLI preflight so the adapter preflight under
        // test is what fails (machine-independent: no real `claude` probe).
        claudeProbe: vi.fn(async () => ({ ok: true as const })),
      };
      invocations = () => loadQuery.mock.calls.length;
      const code = await runRunCommand(kase.runArgs(cwd, ['--prompt', 'brief']), deps);
      expect(code).not.toBe(0);
      expect(errors.join('\n')).toContain('contract sdk missing');
      // Preflight probed once; start never ran, so the loader ran exactly once.
      expect(invocations()).toBe(1);
      return;
    }
    const { spawn } = fakeCodexSpawn();
    const probe = vi.fn(() => ({ code: 127, stdout: '', stderr: '' }));
    deps = {
      codex: { probe, spawn, isGitRepo: () => true },
      resolveDeck: async () => ({ ...DECK }),
      resolveLaunchPlan: async () => matchingPlan(cwd),
      homeDir,
    };
    invocations = () => (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const code = await runRunCommand(kase.runArgs(cwd, ['--prompt', 'brief']), deps);
    expect(code).not.toBe(0);
    expect(errors.join('\n')).toMatch(/codex CLI not found/);
    expect(invocations()).toBe(0);
  });

  it('deck mismatch exits non-zero before the client starts', async () => {
    const cwd = makeDir('agent-deck-contract-cwd-');
    const homeDir = makeDir('agent-deck-contract-home-');
    const kase = make();
    const deps = kase.runDeps(cwd, homeDir);
    deps.resolveLaunchPlan = (async () => ({
      ...matchingPlan(cwd),
      deckId: 'deck-other',
      deckName: 'other',
    })) as RunDeps['resolveLaunchPlan'];

    const code = await runRunCommand(kase.runArgs(cwd, ['--prompt', 'brief']), deps);

    expect(code).not.toBe(0);
    expect(errors.join('\n')).toMatch(/mis-bound/);
    expect(kase.clientRunCalls(deps)).toBe(0);
  });

  it('completes a run end to end with the session id in the final line', async () => {
    const cwd = makeDir('agent-deck-contract-cwd-');
    const homeDir = makeDir('agent-deck-contract-home-');
    const kase = make();

    const code = await runRunCommand(kase.runArgs(cwd, ['--prompt', 'brief']), kase.runDeps(cwd, homeDir));

    expect(code).toBe(0);
    expect(logs.at(-1)).toContain(`sessionId ${kase.expectedSessionId}`);
  });
});
