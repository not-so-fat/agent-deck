/**
 * Muse adapter tests (NOT-407): the real `muse exec --json` fixture
 * captured on the owner's Mac (Muse Code 1.4.4, echo provider, /tmp/smoke,
 * "remember kiwi"), tool-profile argv mapping, resume, preflight, workspace
 * trust, and the session-receipt deck check.
 *
 * The fixture file is byte-identical to the captured smoke output (36
 * records): every record carries `stream: {kind: "session", id}`, one
 * `run.output.delta` carries the answer text, and the final
 * `run.terminal.completed` carries the result text. The untrusted-workspace
 * warning is stderr-only, so it is fed through the fake child's stderr lines
 * (verbatim strings from the same capture), never through the fixture.
 *
 * Synthetic records (tool events, receipts, garbage, terminal variants) are
 * labeled inline. Permission finding (a): 1.4.4 ships with NO named
 * permission profiles — `--permission-profile` only selects enterprise-plane
 * profiles and every candidate id errors "profile does not exist" — so tool
 * profiles map to Muse's own enforcement flags (readonly:
 * `--disable-write --disable-shell`; edit: default bounded flags) instead
 * of profile ids, and `--permission-profile` is never emitted.
 *
 * Mapping evidence (Muse Code 1.4.4, 1.4.4-R5419.1): `muse --version`, `muse
 * --help` (approval on-request default, `--permission-profile` selects a
 * named profile), `muse exec --help` (`--disable-write` blocks non-shell
 * workspace writes, `--disable-shell` blocks workspace shell execution,
 * approval and sandbox ON by default), `muse mcp --help` / `muse mcp login
 * --help` (`muse mcp login <server>` is the OAuth login command; the
 * agent-deck entry is named `agent-deck`), `muse config --help` (profiles
 * live in enterprise plane documents, not user settings).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpLaunchPlan } from './mcp-launcher';
import type { RunToolsProfile } from './run-adapter';
import {
  assertSafeMuseResumeId,
  buildMuseArgv,
  createMuseAdapter,
  MUSE_FLAGS_FOR_PROFILE,
  MUSE_FORBIDDEN_FLAGS,
  mergeMuseLines,
  museEventsFromLine,
  museNoticeFromStderr,
  type MuseFileReader,
  type MuseLineContext,
  type MuseProbe,
  type MuseSpawn,
} from './run-muse';
import { runRunCommand, type RunDeps, type RunMeta } from './run';

const DECK = { id: 'deck-planner', name: 'planner' };

const MUSE_FIXTURE_LINES = fs
  .readFileSync(fileURLToPath(new URL('./run-muse.fixture.jsonl', import.meta.url)), 'utf8')
  .trim()
  .split('\n');
const MUSE_SESSION_ID = (
  JSON.parse(MUSE_FIXTURE_LINES[0]) as { stream: { kind: string; id: string } }
).stream.id;

// Verbatim stderr from the /tmp/smoke capture (Muse Code 1.4.4): the first
// line is routine diagnostics (ignored), the second is the
// untrusted-workspace warning (notice).
const MUSE_FIXTURE_STDERR = [
  'muse: workspace root: /private/tmp/smoke (cwd default)',
  'muse: Agent delegation: auto unavailable: workspace is untrusted.',
];

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
  vi.stubEnv('META_API_KEY', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

function fakeMuseSpawn(
  lines: string[] = MUSE_FIXTURE_LINES,
  opts: { stderrLines?: string[]; code?: number; stderrTail?: string } = {},
): { spawn: MuseSpawn; calls: Array<{ bin: string; argv: string[]; cwd: string }> } {
  const calls: Array<{ bin: string; argv: string[]; cwd: string }> = [];
  const spawn = vi.fn((bin: string, argv: string[], spawnOpts: { cwd: string }) => {
    calls.push({ bin, argv, cwd: spawnOpts.cwd });
    return {
      stdout: (async function* (): AsyncGenerator<string> {
        yield* lines;
      })(),
      stderr: (async function* (): AsyncGenerator<string> {
        yield* (opts.stderrLines ?? []);
      })(),
      wait: async () => ({ code: opts.code ?? 0, stderrTail: opts.stderrTail ?? '' }),
    };
  });
  return { spawn: spawn as unknown as MuseSpawn, calls };
}

function okMuseProbe(): MuseProbe {
  return (bin: string, argv: string[]) =>
    argv[0] === '--version'
      ? { code: 0, stdout: 'Muse Code 1.4.4 (1.4.4-R5419.1)\n', stderr: '' }
      : { code: 1, stdout: '', stderr: '' };
}

const AUTH_JSON = JSON.stringify({
  schema_version: 1,
  providers: { meta: { mechanism: 'oauth', storage: 'keychain' } },
});
const SETTINGS_WITH_ENTRY = JSON.stringify({
  schema_version: 1,
  mcpServers: { 'agent-deck': { command: 'agent-deck', args: ['mcp-launch'] } },
});

/**
 * Canned Muse config files: signed in (auth records a meta provider) and
 * MCP-wired (global settings carry the agent-deck entry) unless overridden.
 */
function fakeMuseReadFile(
  cwd: string,
  overrides: { auth?: string | null; globalSettings?: string | null; projectSettings?: string | null } = {},
): MuseFileReader & { paths: string[] } {
  const paths: string[] = [];
  const readFile = ((filePath: string): string | null => {
    paths.push(filePath);
    if (filePath.endsWith(`${path.sep}muse${path.sep}auth.json`)) {
      return overrides.auth === undefined ? AUTH_JSON : overrides.auth;
    }
    if (filePath === path.join(cwd, '.mcp.json')) {
      return overrides.projectSettings === undefined ? null : overrides.projectSettings;
    }
    if (filePath.endsWith(`${path.sep}muse${path.sep}settings.json`)) {
      return overrides.globalSettings === undefined ? SETTINGS_WITH_ENTRY : overrides.globalSettings;
    }
    return null;
  }) as MuseFileReader & { paths: string[] };
  readFile.paths = paths;
  return readFile;
}

function makeDeps(
  cwd: string,
  homeDir: string,
  overrides: {
    lines?: string[];
    stderrLines?: string[];
    code?: number;
    stderrTail?: string;
    probe?: MuseProbe;
    readFile?: MuseFileReader;
    plan?: McpLaunchPlan | null;
  } = {},
): RunDeps & { calls: Array<{ bin: string; argv: string[]; cwd: string }> } {
  const { spawn, calls } = fakeMuseSpawn(overrides.lines, {
    ...(overrides.stderrLines !== undefined ? { stderrLines: overrides.stderrLines } : {}),
    ...(overrides.code !== undefined ? { code: overrides.code } : {}),
    ...(overrides.stderrTail !== undefined ? { stderrTail: overrides.stderrTail } : {}),
  });
  return {
    calls,
    muse: {
      probe: overrides.probe ?? okMuseProbe(),
      spawn,
      readFile: overrides.readFile ?? fakeMuseReadFile(cwd),
    },
    resolveDeck: async (ref: string) => (ref === DECK.name || ref === DECK.id ? { ...DECK } : null),
    resolveLaunchPlan: (async () => overrides.plan ?? matchingPlan(cwd)) as RunDeps['resolveLaunchPlan'],
    homeDir,
  };
}

function museArgs(cwd: string, extra: string[] = []): string[] {
  return ['planner', '--client', 'muse', '--cwd', cwd, '--prompt', 'remember kiwi', ...extra];
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

const museLine = (value: unknown): string => JSON.stringify(value);

function envelope(sessionId: string, payloadType: string, payload: unknown): string {
  return museLine({
    schema_version: 1,
    stream: { kind: 'session', id: sessionId },
    record_type: 'event',
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  });
}

function deltaLine(sessionId: string, text: string): string {
  return envelope(sessionId, 'run.output.delta', { kind: 'run_output_delta', text });
}

function toolLine(sessionId: string, toolName: string): string {
  return envelope(sessionId, 'tool_batch.effect.started', {
    kind: 'tool_batch_effect',
    record: { kind: 'tool_batch_effect_start', tool_name: toolName, call_id: 'call_synth_1' },
  });
}

function terminalLine(sessionId: string, text: string): string {
  return envelope(sessionId, 'run.terminal.completed', {
    kind: 'run_terminal',
    terminal: 'completed',
    text,
    reason: null,
  });
}

function successStream(sessionId: string, middle: string[] = []): string[] {
  return [
    envelope(sessionId, 'run.lifecycle.started', { kind: 'run_started' }),
    ...middle,
    terminalLine(sessionId, 'echo: remember kiwi'),
  ];
}

describe('muse fixture mapping (NOT-407)', () => {
  it('the session event yields sessionId on result and end', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(museArgs(cwd), deps);

    expect(code).toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['text', 'result', 'end']);
    expect(lines[0]).toMatchObject({ t: 'text', text: 'echo: remember kiwi' });
    expect(lines[1]).toMatchObject({ t: 'result', sessionId: MUSE_SESSION_ID, subtype: 'success' });
    expect(lines[1]['result']).toBe('echo: remember kiwi');
    expect(lines[2]).toMatchObject({ t: 'end', sessionId: MUSE_SESSION_ID });
    expect(readMeta(logPathFromStdout())).toMatchObject({
      client: 'muse',
      state: 'ended',
      sessionId: MUSE_SESSION_ID,
    });
  });

  it('run.terminal.completed yields result and end', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream('ses_terminal', [deltaLine('ses_terminal', 'hello')]),
    });

    expect(await runRunCommand(museArgs(cwd), deps)).toBe(0);

    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['text', 'result', 'end']);
    expect(lines[1]).toMatchObject({
      t: 'result',
      sessionId: 'ses_terminal',
      subtype: 'success',
      result: 'echo: remember kiwi',
    });
    expect(lines[2]).toMatchObject({ t: 'end', sessionId: 'ses_terminal' });
  });

  it('the untrusted-workspace warning yields a notice and the run still ends ended', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, { stderrLines: MUSE_FIXTURE_STDERR });

    expect(await runRunCommand(museArgs(cwd), deps)).toBe(0);

    const lines = readJsonLines(logPathFromStdout());
    // The merge consumes both streams, so the startup warning surfaces
    // before the streamed answer — the same order production shows.
    expect(lines.map((line) => line.t)).toEqual(['notice', 'text', 'result', 'end']);
    const notice = lines.find((line) => line.t === 'notice') ?? {};
    expect(String(notice['message'])).toContain('workspace is untrusted');
    expect(String(notice['message'])).toContain('Agent delegation');
    expect(notice).toMatchObject({ sessionId: MUSE_SESSION_ID });
    // The routine `workspace root` diagnostic stays out of the log.
    expect(lines.filter((line) => line.t === 'notice')).toHaveLength(1);
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'ended' });
  });

  it('no terminal event yields error', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: [
        envelope('ses_cut', 'run.lifecycle.started', { kind: 'run_started' }),
        deltaLine('ses_cut', 'cut off'),
      ],
    });

    const code = await runRunCommand(museArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['text', 'end']);
    expect(lines[1]).toMatchObject({ t: 'end', sessionId: 'ses_cut' });
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'error' });
  });

  it('a non-zero exit yields error even after run.terminal.completed', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream('ses_doomed', [deltaLine('ses_doomed', 'almost done')]),
      code: 1,
      stderrTail: 'fatal: something broke',
    });

    const code = await runRunCommand(museArgs(cwd), deps);

    expect(code).not.toBe(0);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['text', 'result', 'error']);
    expect(String(lines[2]['message'])).toContain('muse exited with code 1');
    expect(String(lines[2]['message'])).toContain('fatal: something broke');
    expect(readMeta(logPathFromStdout())).toMatchObject({
      state: 'error',
      sessionId: 'ses_doomed',
    });
  });

  it('tool_batch.effect.started becomes tool lines (synthetic record)', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream('ses_tools', [
        toolLine('ses_tools', 'read_memory'),
        deltaLine('ses_tools', 'done'),
      ]),
    });

    expect(await runRunCommand(museArgs(cwd), deps)).toBe(0);

    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['tool', 'text', 'result', 'end']);
    expect(lines[0]).toMatchObject({ t: 'tool', name: 'read_memory' });
  });

  it('unparseable stdout lines become notice and do not fail the run (synthetic)', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const stream = successStream('ses_garbage', [deltaLine('ses_garbage', 'ok')]);
    stream.splice(1, 0, 'NOT JSON {{{');
    const deps = makeDeps(cwd, homeDir, { lines: stream });

    expect(await runRunCommand(museArgs(cwd), deps)).toBe(0);

    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['notice', 'text', 'result', 'end']);
    expect(String(lines[0]['message'])).toContain('unparseable muse output');
  });
});

describe('muse argv and tool profiles (NOT-407)', () => {
  const PROMPT = 'remember kiwi';

  it.each([
    ['readonly', ['exec', '--json', '--disable-write', '--disable-shell', '--', PROMPT]],
    ['edit', ['exec', '--json', '--', PROMPT]],
  ])('start argv for --tools %s', (tools, expected) => {
    expect(buildMuseArgv({ prompt: PROMPT, tools: tools as RunToolsProfile })).toEqual(expected);
  });

  it('each tool profile produces its recorded permission flags (no --permission-profile id exists in 1.4.4)', async () => {
    expect(MUSE_FLAGS_FOR_PROFILE).toEqual({
      readonly: ['--disable-write', '--disable-shell'],
      edit: [],
    });
    for (const tools of ['readonly', 'edit'] as const) {
      const cwd = makeDir('agent-deck-muse-cwd-');
      const homeDir = makeDir('agent-deck-muse-home-');
      const deps = makeDeps(cwd, homeDir);

      expect(await runRunCommand(museArgs(cwd, ['--tools', tools]), deps)).toBe(0);

      expect(deps.calls).toHaveLength(1);
      const argv = deps.calls[0].argv;
      expect(argv.slice(0, 2)).toEqual(['exec', '--json']);
      expect(argv.slice(2, 2 + MUSE_FLAGS_FOR_PROFILE[tools].length)).toEqual([
        ...MUSE_FLAGS_FOR_PROFILE[tools],
      ]);
      expect(argv.at(-2)).toBe('--');
      expect(argv.at(-1)).toBe('remember kiwi');
      expect(deps.calls[0].cwd).toBe(cwd);
      expect(readMeta(logPathFromStdout())).toMatchObject({ tools });
    }
  });

  it('readonly fails closed rather than running under default permissions: enforcement flags are unconditional', () => {
    // There is no read-only --permission-profile id to go missing (1.4.4
    // ships none and user settings accept none), so readonly enforcement is
    // structural: every readonly argv carries both flags, on start and resume.
    for (const resumeId of [undefined, '01a13012-b2c8-7da0-8d3d-1397cfaf5952']) {
      const argv = buildMuseArgv({
        prompt: 'p',
        tools: 'readonly',
        ...(resumeId ? { resumeId } : {}),
      });
      expect(argv).toContain('--disable-write');
      expect(argv).toContain('--disable-shell');
    }
    const editArgv = buildMuseArgv({ prompt: 'p', tools: 'edit' });
    expect(editArgv).not.toContain('--disable-write');
    expect(editArgv).not.toContain('--disable-shell');
  });

  it('no generated argv ever contains a permission bypass or --permission-profile', () => {
    const profiles: RunToolsProfile[] = ['readonly', 'edit'];
    expect(MUSE_FORBIDDEN_FLAGS).toEqual([
      '--yolo',
      '--trust-workspace',
      '--disable-approval',
      '--disable-sandbox',
      '--permission-profile',
    ]);
    for (const tools of profiles) {
      for (const resumeId of [undefined, 'ses_abc']) {
        const argv = buildMuseArgv({ prompt: 'p', tools, ...(resumeId ? { resumeId } : {}) });
        for (const forbidden of MUSE_FORBIDDEN_FLAGS) {
          expect(argv).not.toContain(forbidden);
        }
        expect(argv.join('\n')).not.toMatch(/yolo|bypass|trust-workspace/i);
      }
    }
  });

  it.each(['--yolo', '--trust-workspace', '--session-id', '--disable-approval'])(
    'a dash-leading resume id %j is rejected before any argv is generated',
    (resumeId) => {
      expect(() => buildMuseArgv({ prompt: 'p', tools: 'readonly', resumeId })).toThrow(
        /never start with '-'/,
      );
      expect(() => assertSafeMuseResumeId(resumeId)).toThrow(/never start with '-'/);
      const adapter = createMuseAdapter({
        probe: okMuseProbe(),
        spawn: fakeMuseSpawn().spawn,
        readFile: fakeMuseReadFile('/tmp/x'),
      });
      const plan = adapter.planStart({ cwd: '/tmp/x', prompt: 'p', tools: 'readonly', resumeId });
      expect(plan.ok).toBe(false);
      if (!plan.ok) {
        expect(plan.remedy).toMatch(/never start with '-'/);
      }
    },
  );

  it('a --resume spelling a muse flag fails closed before spawning', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir);

    const code = await runRunCommand(museArgs(cwd, ['--resume', '--yolo']), deps);

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/never start with '-'/);
    expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
  });

  it.each(['- bullet brief', '---\nfrontmatter brief', '--yolo', '--trust-workspace'])(
    'a dash-leading prompt %j is passed after a -- terminator',
    (prompt) => {
      for (const resumeId of [undefined, 'ses_abc']) {
        const argv = buildMuseArgv({
          prompt,
          tools: 'readonly',
          ...(resumeId ? { resumeId } : {}),
        });
        expect(argv.at(-1)).toBe(prompt);
        const sep = argv.indexOf('--');
        expect(sep).toBeGreaterThan(0);
        expect(argv.filter((arg) => arg === '--')).toHaveLength(1);
        expect(argv.slice(sep + 1)).toEqual([prompt]);
        expect(argv.slice(0, sep).filter((arg) => arg.startsWith('-'))).toEqual(
          resumeId
            ? ['--json', '--session-id', '--disable-write', '--disable-shell']
            : ['--json', '--disable-write', '--disable-shell'],
        );
      }
    },
  );

  it('a dash-leading prompt reaches the spawned argv verbatim on a real run', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(
      await runRunCommand(
        ['planner', '--client', 'muse', '--cwd', cwd, '--prompt', '--yolo'],
        deps,
      ),
    ).toBe(0);

    expect(deps.calls[0].argv.at(-2)).toBe('--');
    expect(deps.calls[0].argv.at(-1)).toBe('--yolo');
  });

  it('resume argv contains --session-id <id> and keeps the session id', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream(MUSE_SESSION_ID, [deltaLine(MUSE_SESSION_ID, 'kiwi')]),
    });

    const code = await runRunCommand(museArgs(cwd, ['--resume', MUSE_SESSION_ID]), deps);

    expect(code).toBe(0);
    expect(deps.calls[0].argv).toEqual([
      'exec',
      '--json',
      '--session-id',
      MUSE_SESSION_ID,
      '--disable-write',
      '--disable-shell',
      '--',
      'remember kiwi',
    ]);
    const lines = readJsonLines(logPathFromStdout());
    expect(lines.map((line) => line.t)).toEqual(['notice', 'text', 'result', 'end']);
    expect(String(lines[0]['message'])).toContain(`Resuming muse session ${MUSE_SESSION_ID}`);
    expect(lines.at(-1)).toMatchObject({ t: 'end', sessionId: MUSE_SESSION_ID });
  });
});

describe('muse preflight and trust (NOT-407)', () => {
  it('a missing binary fails preflight with a one-line remedy before any spawn', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      probe: () => ({ code: 127, stdout: '', stderr: '' }),
    });

    const code = await runRunCommand(museArgs(cwd), deps);

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/muse CLI not found/);
    expect(errors.join('\n')).toContain('MUSE_BIN');
  });

  it('a signed-out muse fails preflight with the login remedy', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      readFile: fakeMuseReadFile(cwd, { auth: null }),
    });

    expect(await runRunCommand(museArgs(cwd), deps)).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toContain('muse login');
  });

  it('META_API_KEY counts as signed in without an auth file', async () => {
    vi.stubEnv('META_API_KEY', 'test-key');
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      readFile: fakeMuseReadFile(cwd, { auth: null }),
    });

    expect(await runRunCommand(museArgs(cwd), deps)).toBe(0);
    expect(deps.calls).toHaveLength(1);
  });

  it('a missing agent-deck MCP entry fails closed with the setup + mcp login remedy before spawning', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const readFile = fakeMuseReadFile(cwd, {
      globalSettings: JSON.stringify({ schema_version: 1, mcpServers: {} }),
      projectSettings: null,
    });
    const deps = makeDeps(cwd, homeDir, { readFile });

    const code = await runRunCommand(museArgs(cwd), deps);

    expect(code).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toContain('agent-deck setup --client muse');
    expect(errors.join('\n')).toContain('muse mcp login agent-deck');
    expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
    // Both scopes were consulted before failing: global settings and the
    // cwd project .mcp.json.
    expect(readFile.paths).toContain(path.join(cwd, '.mcp.json'));
    expect(readFile.paths.some((p) => p.endsWith(`${path.sep}muse${path.sep}settings.json`))).toBe(
      true,
    );
  });

  it('a project .mcp.json entry satisfies the MCP check without a global entry', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      readFile: fakeMuseReadFile(cwd, {
        globalSettings: null,
        projectSettings: SETTINGS_WITH_ENTRY,
      }),
    });

    expect(await runRunCommand(museArgs(cwd), deps)).toBe(0);
    expect(deps.calls).toHaveLength(1);
  });

  it('a successful run records no trustOverride in meta.json', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(await runRunCommand(museArgs(cwd), deps)).toBe(0);

    expect(deps.calls[0].argv).not.toContain('--trust-workspace');
    expect(deps.calls[0].argv).not.toContain('--yolo');
    expect(readMeta(logPathFromStdout())).not.toHaveProperty('trustOverride');
  });
});

describe('muse session receipt (NOT-407)', () => {
  it('a receipt showing a different deck ends the run error with a remedy', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream('ses_receipt', [
        deltaLine('ses_receipt', '◆ other · 1 MCP · 0 keys · 0 playbooks'),
      ]),
    });

    const code = await runRunCommand(museArgs(cwd), deps);

    expect(code).not.toBe(0);
    expect(errors.join('\n')).toContain('"other"');
    expect(errors.join('\n')).toContain('agent-deck use planner');
    expect(readMeta(logPathFromStdout())).toMatchObject({
      state: 'error',
      sessionId: 'ses_receipt',
    });
  });

  it('a receipt naming the requested deck ends ended', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream('ses_receipt_ok', [
        deltaLine('ses_receipt_ok', '◆ planner · 1 MCP · 0 keys · 1 playbooks'),
      ]),
    });

    expect(await runRunCommand(museArgs(cwd), deps)).toBe(0);
    expect(readMeta(logPathFromStdout())).toMatchObject({ state: 'ended' });
  });

  it('a receipt split across output deltas still ends the run error', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    // Token-level streaming: the deck token and the closing `·` land in
    // different deltas, so no single text event matches the receipt pattern.
    const deps = makeDeps(cwd, homeDir, {
      lines: successStream('ses_split', [
        deltaLine('ses_split', 'here is your context ◆ oth'),
        deltaLine('ses_split', 'er · 1 MCP · 0 keys · 0 playbooks'),
      ]),
    });

    const code = await runRunCommand(museArgs(cwd), deps);

    expect(code).not.toBe(0);
    expect(errors.join('\n')).toContain('"other"');
    expect(errors.join('\n')).toContain('agent-deck use planner');
    expect(readMeta(logPathFromStdout())).toMatchObject({
      state: 'error',
      sessionId: 'ses_split',
    });
  });
});

describe('muse line parser edges (NOT-407)', () => {
  function parse(lines: string[]): ReturnType<typeof museEventsFromLine> {
    const ctx: MuseLineContext = { sessionId: null };
    return lines.flatMap((line) => museEventsFromLine(line, ctx));
  }

  it('ignores unknown kinds, blank lines, and textless deltas', () => {
    expect(
      parse([
        '',
        '   ',
        envelope('s1', 'turn.input.user', { kind: 'turn_input_user' }),
        envelope('s1', 'task.lifecycle.started', { kind: 'task_lifecycle' }),
        envelope('s1', 'tool_batch.effect.terminal', { kind: 'tool_batch_effect' }),
        envelope('s1', 'run.output.delta', { kind: 'run_output_delta' }),
        museLine({ retained_frame: {}, frame_schema_version: 1 }),
      ]),
    ).toEqual([]);
  });

  it('maps run.terminal.cancelled to a failed result', () => {
    const events = parse([
      envelope('s1', 'run.lifecycle.started', { kind: 'run_started' }),
      envelope('s1', 'run.terminal.cancelled', {
        kind: 'run_terminal',
        terminal: 'cancelled',
        reason: 'user quit',
      }),
    ]);
    expect(events).toEqual([
      { kind: 'result', subtype: 'failed', result: 'user quit', sessionId: 's1' },
    ]);
  });

  it('captures the session id from the stream envelope onto later events', () => {
    const ctx: MuseLineContext = { sessionId: null };
    expect(museEventsFromLine(envelope('s9', 'turn.input.user', { kind: 'x' }), ctx)).toEqual([]);
    expect(ctx.sessionId).toBe('s9');
    expect(museEventsFromLine(deltaLine('s9', 'hi'), ctx)).toEqual([
      { kind: 'text', text: 'hi', sessionId: 's9' },
    ]);
  });

  it('stderr diagnostics without warning words are ignored', () => {
    expect(museNoticeFromStderr('')).toBeNull();
    expect(museNoticeFromStderr('muse: workspace root: /private/tmp/smoke (cwd default)')).toBeNull();
    expect(
      museNoticeFromStderr('muse: plugins: foreign:codex: foreign codex plugin artifact observed'),
    ).toBeNull();
  });

  it('stderr warnings become notices', () => {
    expect(
      museNoticeFromStderr('muse: Agent delegation: auto unavailable: workspace is untrusted.'),
    ).toContain('workspace is untrusted');
    expect(
      museNoticeFromStderr(
        'muse: warning: rules file at /tmp/x/CLAUDE.md exists, but the workspace is untrusted, so it is skipped',
      ),
    ).toContain('warning');
  });

  it('mergeMuseLines yields stderr-first arrivals first', async () => {
    async function* delayedStdout(): AsyncGenerator<string> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield deltaLine('s1', 'late');
    }
    async function* immediateStderr(): AsyncGenerator<string> {
      yield 'muse: Agent delegation: auto unavailable: workspace is untrusted.';
    }
    const merged: Array<{ source: string; line: string }> = [];
    for await (const item of mergeMuseLines(delayedStdout(), immediateStderr())) {
      merged.push(item);
    }
    expect(merged.map((item) => item.source)).toEqual(['err', 'out']);
  });

  it('mergeMuseLines surfaces a stdout failure', async () => {
    async function* failingStdout(): AsyncGenerator<string> {
      yield deltaLine('s1', 'first');
      throw new Error('stdout exploded');
    }
    async function* emptyStderr(): AsyncGenerator<string> {
      // Never yields.
    }
    await expect(async () => {
      for await (const _item of mergeMuseLines(failingStdout(), emptyStderr())) {
        // Drain.
      }
    }).rejects.toThrow(/muse run failed: stdout exploded/);
  });

  it('the muse adapter reports id muse and passes preflight when the CLI is healthy', async () => {
    const adapter = createMuseAdapter({
      probe: okMuseProbe(),
      spawn: fakeMuseSpawn().spawn,
      readFile: fakeMuseReadFile('/tmp/x'),
    });
    expect(adapter.id).toBe('muse');
    expect(await adapter.preflight()).toEqual({ ok: true });
    expect(adapter.planStart({ cwd: '/tmp/x', prompt: 'p', tools: 'readonly' })).toEqual({
      ok: true,
      trustOverride: false,
    });
  });
});
