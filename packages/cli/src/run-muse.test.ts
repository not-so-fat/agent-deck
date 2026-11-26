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
 * profiles map to Muse's own enforcement flags instead of profile ids, and
 * `--permission-profile` is never emitted. Enforcement (NOT-671): both
 * profiles pass `--approval-mode never`; readonly adds `--disable-write`
 * plus `--sandbox-network restricted` (sandbox on); edit adds
 * `--disable-sandbox` (sandbox off, so agent-home writes work).
 * `--disable-shell` is never passed (it would block readonly shell reads).
 * The gate fails closed unless `muse exec --help` lists every flag the
 * requested profile needs.
 *
 * Mapping evidence (Muse Code 1.4.4, 1.4.4-R5419.1, enforcement re-verified
 * on 1.4.25): `muse --version`, `muse --help` (approval on-request default,
 * `--permission-profile` selects a named profile), `muse exec --help`
 * (`--approval-mode` never, `--sandbox-network` restricted,
 * `--disable-write` blocks non-shell workspace writes, `--disable-sandbox`
 * lifts the filesystem sandbox; approval and sandbox ON by default),
 * `muse mcp --help` / `muse mcp login --help` (`muse mcp
 * login <server>` is the OAuth login command; the agent-deck entry is named
 * `agent-deck`), `muse config --help` (profiles live in enterprise plane
 * documents, not user settings).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpLaunchPlan } from './mcp-launcher';
import type { RunToolsProfile } from '@agent-deck/backend/agent-run';
import {
  assertSafeMuseResumeId,
  buildMuseArgv,
  buildMuseWorkerMcpEntry,
  buildMuseWorkerSettingsDocument,
  cleanupMuseWorkerConfig,
  createMuseAdapter,
  createRunAdapter,
  findMuseForeignProjectServers,
  findMuseProjectAgentDeckEntries,
  MUSE_APPROVAL_FLAGS,
  MUSE_EDIT_ONLY_FLAGS,
  MUSE_FLAGS_FOR_PROFILE,
  MUSE_FORBIDDEN_FLAGS,
  mergeMuseLines,
  museDenialFromPayload,
  museEnforcementFlagsSupported,
  museEventsFromLine,
  museHelpTextSupportsEnforcement,
  museNoticeFromStderr,
  setupMuseWorkerConfig,
  type MuseFileReader,
  type MuseLineContext,
  type MuseProbe,
  type MuseSpawn,
} from '@agent-deck/backend/agent-run';
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

type MuseSpawnCall = { bin: string; argv: string[]; cwd: string; env?: NodeJS.ProcessEnv };

function fakeMuseSpawn(
  lines: string[] = MUSE_FIXTURE_LINES,
  opts: { stderrLines?: string[]; code?: number; stderrTail?: string } = {},
): { spawn: MuseSpawn; calls: MuseSpawnCall[] } {
  const calls: MuseSpawnCall[] = [];
  const spawn = vi.fn(
    (bin: string, argv: string[], spawnOpts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      calls.push({ bin, argv, cwd: spawnOpts.cwd, ...(spawnOpts.env ? { env: spawnOpts.env } : {}) });
      return {
        stdout: (async function* (): AsyncGenerator<string> {
          yield* lines;
        })(),
        stderr: (async function* (): AsyncGenerator<string> {
          yield* (opts.stderrLines ?? []);
        })(),
        wait: async () => ({ code: opts.code ?? 0, stderrTail: opts.stderrTail ?? '' }),
      };
    },
  );
  return { spawn: spawn as unknown as MuseSpawn, calls };
}

export const MUSE_EXEC_HELP_FIXTURE =
  'Usage: muse exec [options]\n' +
  '  --approval-mode <MODE>  Tool approval mode: untrusted|on-request|never\n' +
  '  --sandbox-network <MODE>  Sandbox network mode\n' +
  '  --disable-write  Disable non-shell workspace filesystem writes\n' +
  '  --disable-sandbox  Disable the filesystem sandbox\n' +
  '  --disable-shell  Disable workspace shell execution\n';

function okMuseProbe(): MuseProbe {
  return (bin: string, argv: string[]) => {
    if (argv[0] === '--version') {
      return { code: 0, stdout: 'Muse Code 1.4.25 (1.4.25-R9361.1)\n', stderr: '' };
    }
    if (argv[0] === 'exec' && argv[1] === '--help') {
      return { code: 0, stdout: MUSE_EXEC_HELP_FIXTURE, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
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
    /** When true the real NOT-671 profile gate runs instead of the bypass. */
    enforceProfile?: boolean;
  } = {},
): RunDeps & { calls: MuseSpawnCall[] } {
  const { spawn, calls } = fakeMuseSpawn(overrides.lines, {
    ...(overrides.stderrLines !== undefined ? { stderrLines: overrides.stderrLines } : {}),
    ...(overrides.code !== undefined ? { code: overrides.code } : {}),
    ...(overrides.stderrTail !== undefined ? { stderrTail: overrides.stderrTail } : {}),
  });
  const muse = {
    probe: overrides.probe ?? okMuseProbe(),
    spawn,
    readFile: overrides.readFile ?? fakeMuseReadFile(cwd),
  };
  return {
    calls,
    muse,
    // Real adapter behavior with the NOT-669 gate bypassed (unless the test
    // asks for enforcement): these tests exercise argv/event mapping.
    ...(overrides.enforceProfile
      ? {}
      : {
          createAdapter: (client: 'claude' | 'codex' | 'cursor' | 'muse') => ({
            ...createRunAdapter(client, { muse }),
            profileEnforcement: () => ({ ok: true as const }),
          }),
        }),
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

describe('muse argv and tool profiles (NOT-407, enforcement NOT-671)', () => {
  const PROMPT = 'remember kiwi';

  it.each([
    [
      'readonly',
      [
        'exec',
        '--json',
        '--approval-mode',
        'never',
        '--disable-write',
        '--sandbox-network',
        'restricted',
        '--',
        PROMPT,
      ],
    ],
    ['edit', ['exec', '--json', '--approval-mode', 'never', '--disable-sandbox', '--', PROMPT]],
  ])('start argv for --tools %s', (tools, expected) => {
    expect(buildMuseArgv({ prompt: PROMPT, tools: tools as RunToolsProfile })).toEqual(expected);
  });

  it('each tool profile produces its recorded permission flags (no --permission-profile id exists in 1.4.4)', async () => {
    expect(MUSE_APPROVAL_FLAGS).toEqual(['--approval-mode', 'never']);
    expect(MUSE_FLAGS_FOR_PROFILE).toEqual({
      readonly: ['--disable-write', '--sandbox-network', 'restricted'],
      edit: ['--disable-sandbox'],
    });
    for (const tools of ['readonly', 'edit'] as const) {
      const cwd = makeDir('agent-deck-muse-cwd-');
      const homeDir = makeDir('agent-deck-muse-home-');
      const deps = makeDeps(cwd, homeDir);

      expect(await runRunCommand(museArgs(cwd, ['--tools', tools]), deps)).toBe(0);

      expect(deps.calls).toHaveLength(1);
      const argv = deps.calls[0].argv;
      expect(argv.slice(0, 4)).toEqual(['exec', '--json', '--approval-mode', 'never']);
      expect(argv.slice(4, 4 + MUSE_FLAGS_FOR_PROFILE[tools].length)).toEqual([
        ...MUSE_FLAGS_FOR_PROFILE[tools],
      ]);
      expect(argv.at(-2)).toBe('--');
      expect(argv.at(-1)).toBe('remember kiwi');
      expect(deps.calls[0].cwd).toBe(cwd);
      expect(readMeta(logPathFromStdout())).toMatchObject({ tools });
    }
  });

  it('enforcement flags are unconditional on start and resume; shell reads stay available', () => {
    // There is no read-only --permission-profile id to go missing (1.4.4
    // ships none and user settings accept none), so enforcement is
    // structural: every argv carries --approval-mode never plus its profile
    // flags, on start and resume. --disable-shell is never passed: it would
    // block readonly shell reads too.
    for (const resumeId of [undefined, '01a13012-b2c8-7da0-8d3d-1397cfaf5952']) {
      const argv = buildMuseArgv({
        prompt: 'p',
        tools: 'readonly',
        ...(resumeId ? { resumeId } : {}),
      });
      expect(argv).toContain('--approval-mode');
      expect(argv).toContain('never');
      expect(argv).toContain('--disable-write');
      expect(argv).toContain('--sandbox-network');
      expect(argv).toContain('restricted');
      expect(argv).not.toContain('--disable-shell');
    }
    const editArgv = buildMuseArgv({ prompt: 'p', tools: 'edit' });
    expect(editArgv).toContain('--approval-mode');
    expect(editArgv).toContain('--disable-sandbox');
    expect(editArgv).not.toContain('--sandbox-network');
    expect(editArgv).not.toContain('--disable-write');
    expect(editArgv).not.toContain('restricted');
    expect(editArgv).not.toContain('--disable-shell');
  });

  it('a build without the enforcement flags fails closed for both profiles before any model call', async () => {
    // The installed muse does not list the enforcement flags (older/newer
    // build): the profile gate fails closed with a remedy and the run never
    // spawns — for readonly and edit alike, since both need --approval-mode
    // and their own profile flags.
    const noFlagsProbe: MuseProbe = (bin, argv) => {
      if (argv[0] === '--version') {
        return { code: 0, stdout: 'Muse Code 1.4.4 (1.4.4-R5419.1)\n', stderr: '' };
      }
      if (argv[0] === 'exec' && argv[1] === '--help') {
        return { code: 0, stdout: 'Usage: muse exec [options]\n  --json  Output JSONL\n', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    };
    expect(museEnforcementFlagsSupported(okMuseProbe(), 'muse', 'readonly')).toBe(true);
    expect(museEnforcementFlagsSupported(okMuseProbe(), 'muse', 'edit')).toBe(true);
    expect(museEnforcementFlagsSupported(noFlagsProbe, 'muse', 'readonly')).toBe(false);
    expect(museEnforcementFlagsSupported(noFlagsProbe, 'muse', 'edit')).toBe(false);

    for (const tools of ['readonly', 'edit'] as const) {
      const cwd = makeDir('agent-deck-muse-cwd-');
      const homeDir = makeDir('agent-deck-muse-home-');
      const deps = makeDeps(cwd, homeDir, { probe: noFlagsProbe, enforceProfile: true });

      const code = await runRunCommand(museArgs(cwd, ['--tools', tools]), deps);

      expect(code).not.toBe(0);
      expect(deps.calls).toHaveLength(0);
      expect(errors.join('\n')).toMatch(/enforcement unavailable/);
      expect(errors.join('\n')).toMatch(/Upgrade Muse Code/);
      expect(errors.join('\n')).toMatch(/no process was started/i);
      expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
      logs = [];
      errors = [];
    }
  });

  it('no generated argv ever contains a permission bypass, --permission-profile, or a read blocker', () => {
    const profiles: RunToolsProfile[] = ['readonly', 'edit'];
    expect(MUSE_FORBIDDEN_FLAGS).toEqual([
      '--yolo',
      '--trust-workspace',
      '--disable-approval',
      '--permission-profile',
      '--disable-shell',
      '--disable-web-tools',
    ]);
    // --disable-sandbox is the one flag edit alone may pass (agent-home
    // writes need the sandbox off); readonly must never contain it.
    expect(MUSE_EDIT_ONLY_FLAGS).toEqual(['--disable-sandbox']);
    for (const tools of profiles) {
      for (const resumeId of [undefined, 'ses_abc']) {
        const argv = buildMuseArgv({ prompt: 'p', tools, ...(resumeId ? { resumeId } : {}) });
        for (const forbidden of MUSE_FORBIDDEN_FLAGS) {
          expect(argv).not.toContain(forbidden);
        }
        expect(argv.join('\n')).not.toMatch(/yolo|bypass|trust-workspace/i);
        if (tools === 'edit') {
          for (const flag of MUSE_EDIT_ONLY_FLAGS) {
            expect(argv).toContain(flag);
          }
        } else {
          for (const flag of MUSE_EDIT_ONLY_FLAGS) {
            expect(argv).not.toContain(flag);
          }
        }
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
            ? ['--json', '--approval-mode', '--disable-write', '--sandbox-network', '--session-id']
            : ['--json', '--approval-mode', '--disable-write', '--sandbox-network'],
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
      '--approval-mode',
      'never',
      '--disable-write',
      '--sandbox-network',
      'restricted',
      '--session-id',
      MUSE_SESSION_ID,
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

  it('no pre-registered MCP entry is needed: the worker config carries the run entry (NOT-671)', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      readFile: fakeMuseReadFile(cwd, {
        globalSettings: JSON.stringify({ schema_version: 1, mcpServers: {} }),
        projectSettings: null,
      }),
    });

    expect(await runRunCommand(museArgs(cwd), deps)).toBe(0);
    expect(deps.calls).toHaveLength(1);
  });

  it('a project .mcp.json agent-deck entry does not break runs (NOT-671)', async () => {
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

describe('muse worker profile enforcement gate (NOT-671)', () => {
  it('help text must list --approval-mode plus the flags the profile passes', () => {
    expect(museHelpTextSupportsEnforcement(MUSE_EXEC_HELP_FIXTURE, 'readonly')).toBe(true);
    expect(museHelpTextSupportsEnforcement(MUSE_EXEC_HELP_FIXTURE, 'edit')).toBe(true);
    expect(museHelpTextSupportsEnforcement('Usage: muse exec [options]\n', 'edit')).toBe(false);
    expect(museHelpTextSupportsEnforcement('Usage: muse exec [options]\n', 'readonly')).toBe(false);
    // Readonly needs --disable-write and --sandbox-network; edit needs
    // neither (it lifts the sandbox instead).
    for (const marker of ['--disable-write', '--sandbox-network']) {
      const missing = MUSE_EXEC_HELP_FIXTURE.replace(marker, '--something-else');
      expect(museHelpTextSupportsEnforcement(missing, 'readonly')).toBe(false);
      expect(museHelpTextSupportsEnforcement(missing, 'edit')).toBe(true);
    }
    // Edit needs --disable-sandbox; readonly must not depend on it.
    const noDisableSandbox = MUSE_EXEC_HELP_FIXTURE.replace('--disable-sandbox', '--something-else');
    expect(museHelpTextSupportsEnforcement(noDisableSandbox, 'edit')).toBe(false);
    expect(museHelpTextSupportsEnforcement(noDisableSandbox, 'readonly')).toBe(true);
    // Both need --approval-mode.
    const noApproval = MUSE_EXEC_HELP_FIXTURE.replace('--approval-mode', '--something-else');
    expect(museHelpTextSupportsEnforcement(noApproval, 'readonly')).toBe(false);
    expect(museHelpTextSupportsEnforcement(noApproval, 'edit')).toBe(false);
  });

  it('edit fails closed when the build lacks --disable-sandbox while readonly still runs', async () => {
    // A build new enough for readonly (approval, write block, sandbox
    // network) but without --disable-sandbox: edit cannot lift the sandbox
    // for agent-home writes, so it rejects before spawn; readonly is
    // unaffected by the missing flag.
    const noDisableSandboxProbe: MuseProbe = (bin, argv) => {
      if (argv[0] === '--version') {
        return { code: 0, stdout: 'Muse Code 1.4.4 (1.4.4-R5419.1)\n', stderr: '' };
      }
      if (argv[0] === 'exec' && argv[1] === '--help') {
        return {
          code: 0,
          stdout: MUSE_EXEC_HELP_FIXTURE.replace('--disable-sandbox', '--something-else'),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: '' };
    };
    expect(museEnforcementFlagsSupported(noDisableSandboxProbe, 'muse', 'readonly')).toBe(true);
    expect(museEnforcementFlagsSupported(noDisableSandboxProbe, 'muse', 'edit')).toBe(false);

    const editCwd = makeDir('agent-deck-muse-cwd-');
    const editHome = makeDir('agent-deck-muse-home-');
    const editDeps = makeDeps(editCwd, editHome, {
      probe: noDisableSandboxProbe,
      enforceProfile: true,
    });
    expect(await runRunCommand(museArgs(editCwd, ['--tools', 'edit']), editDeps)).not.toBe(0);
    expect(editDeps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/enforcement unavailable/);
    expect(errors.join('\n')).toMatch(/--disable-sandbox/);
    expect(errors.join('\n')).toMatch(/no process was started/i);
    expect(fs.existsSync(path.join(editHome, 'runs'))).toBe(false);
    logs = [];
    errors = [];

    const roCwd = makeDir('agent-deck-muse-cwd-');
    const roHome = makeDir('agent-deck-muse-home-');
    const roDeps = makeDeps(roCwd, roHome, {
      probe: noDisableSandboxProbe,
      enforceProfile: true,
    });
    expect(await runRunCommand(museArgs(roCwd, ['--tools', 'readonly']), roDeps)).toBe(0);
    expect(roDeps.calls).toHaveLength(1);
  });

  it('a failing exec --help probe means enforcement is unsupported', () => {
    const failing: MuseProbe = () => ({ code: 127, stdout: '', stderr: '' });
    expect(museEnforcementFlagsSupported(failing, 'muse', 'readonly')).toBe(false);
    expect(museEnforcementFlagsSupported(failing, 'muse', 'edit')).toBe(false);
  });

  it('the gate passes with enforcing flags, isolated projects, and a writable worker config', () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const adapter = createMuseAdapter({
      probe: okMuseProbe(),
      spawn: fakeMuseSpawn().spawn,
      readFile: fakeMuseReadFile(cwd),
    });

    for (const tools of ['readonly', 'edit'] as const) {
      expect(adapter.profileEnforcement({ cwd, prompt: 'p', tools })).toEqual({ ok: true });
    }
  });

  it('resume goes through the same gate as start', async () => {
    const noFlagsProbe: MuseProbe = (bin, argv) => {
      if (argv[0] === '--version') {
        return { code: 0, stdout: 'Muse Code 1.4.4 (1.4.4-R5419.1)\n', stderr: '' };
      }
      if (argv[0] === 'exec' && argv[1] === '--help') {
        return { code: 0, stdout: 'Usage: muse exec [options]\n  --json  Output JSONL\n', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    };
    for (const tools of ['readonly', 'edit'] as const) {
      const cwd = makeDir('agent-deck-muse-cwd-');
      const homeDir = makeDir('agent-deck-muse-home-');
      const deps = makeDeps(cwd, homeDir, {
        probe: noFlagsProbe,
        enforceProfile: true,
        lines: successStream(MUSE_SESSION_ID, [deltaLine(MUSE_SESSION_ID, 'kiwi')]),
      });

      expect(
        await runRunCommand(museArgs(cwd, ['--tools', tools, '--resume', MUSE_SESSION_ID]), deps),
      ).not.toBe(0);
      expect(deps.calls).toHaveLength(0);
      expect(errors.join('\n')).toMatch(/enforcement unavailable/);
      expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
      logs = [];
      errors = [];
    }
  });

  it('a project config with a foreign MCP server fails closed before spawn', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir, {
      enforceProfile: true,
      readFile: fakeMuseReadFile(cwd, {
        projectSettings: JSON.stringify({
          mcpServers: { 'agent-deck': { type: 'http', url: 'http://127.0.0.1:1110/mcp' }, other: {} },
        }),
      }),
    });

    expect(await runRunCommand(museArgs(cwd), deps)).not.toBe(0);
    expect(deps.calls).toHaveLength(0);
    expect(errors.join('\n')).toMatch(/MCP isolation unavailable/);
    expect(errors.join('\n')).toContain('"other"');
    expect(fs.existsSync(path.join(homeDir, 'runs'))).toBe(false);
  });

  it('foreign servers are found up the tree, agent-deck-only projects pass', () => {
    const cwd = path.join(makeDir('agent-deck-muse-tree-'), 'a', 'b');
    fs.mkdirSync(cwd, { recursive: true });
    const root = path.resolve(cwd, '..', '..');
    const readFile: MuseFileReader = (filePath) => {
      if (filePath === path.join(root, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { stranger: { type: 'http' } } });
      }
      return null;
    };
    expect(findMuseForeignProjectServers(cwd, readFile)).toEqual([
      { configPath: path.join(root, '.mcp.json'), server: 'stranger' },
    ]);
    const agentDeckOnly: MuseFileReader = (filePath) =>
      filePath === path.join(cwd, '.mcp.json')
        ? JSON.stringify({ mcpServers: { 'agent-deck': { type: 'http' } } })
        : null;
    expect(findMuseForeignProjectServers(cwd, agentDeckOnly)).toEqual([]);
    const garbage: MuseFileReader = (filePath) =>
      filePath === path.join(cwd, '.mcp.json') ? 'not json {' : null;
    expect(findMuseForeignProjectServers(cwd, garbage)).toEqual([
      { configPath: path.join(cwd, '.mcp.json'), server: '<unparseable .mcp.json>' },
    ]);
  });

  it('a project agent-deck entry does not block start or resume: the untrusted worker never loads it', async () => {
    for (const extra of [[], ['--resume', MUSE_SESSION_ID]] as string[][]) {
      const cwd = makeDir('agent-deck-muse-cwd-');
      const homeDir = makeDir('agent-deck-muse-home-');
      const deps = makeDeps(cwd, homeDir, {
        enforceProfile: true,
        readFile: fakeMuseReadFile(cwd, { projectSettings: SETTINGS_WITH_ENTRY }),
      });

      expect(await runRunCommand(museArgs(cwd, extra), deps)).toBe(0);
      expect(deps.calls).toHaveLength(1);
      // The worker is never trusted, so project .mcp.json entries never load.
      expect(deps.calls[0].argv).not.toContain('--trust-workspace');
      expect(deps.calls[0].argv).not.toContain('--yolo');
      logs = [];
      errors = [];
    }
  });

  it('the per-run worker config carries no persisted trust (settings.json and auth.json only)', () => {
    const configHome = makeDir('agent-deck-muse-worker-config-');
    setupMuseWorkerConfig({
      configHome,
      settingsDocument: buildMuseWorkerSettingsDocument(buildMuseWorkerMcpEntry({ workspaceRoot: '/w' })),
    });
    const entries = fs.readdirSync(path.join(configHome, 'muse')).sort();
    expect(entries.filter((name) => name !== 'auth.json')).toEqual(['settings.json']);
    expect(entries).not.toContain('trust.json');
  });

  it('project agent-deck entries are found up the tree and unparseable files stay foreign', () => {
    const cwd = path.join(makeDir('agent-deck-muse-tree-'), 'a', 'b');
    fs.mkdirSync(cwd, { recursive: true });
    const root = path.resolve(cwd, '..', '..');
    const projectPath = path.join(root, '.mcp.json');
    const readFile: MuseFileReader = (filePath) =>
      filePath === projectPath
        ? JSON.stringify({ mcpServers: { 'agent-deck': { type: 'http' } } })
        : null;
    expect(findMuseProjectAgentDeckEntries(cwd, readFile)).toEqual([projectPath]);
    // Unparseable project files are the foreign finder's failure, not this one.
    const garbage: MuseFileReader = (filePath) =>
      filePath === path.join(cwd, '.mcp.json') ? 'not json {' : null;
    expect(findMuseProjectAgentDeckEntries(cwd, garbage)).toEqual([]);
    expect(findMuseForeignProjectServers(cwd, garbage)).toEqual([
      { configPath: path.join(cwd, '.mcp.json'), server: '<unparseable .mcp.json>' },
    ]);
  });

  it('an unwritable worker config fails the gate with a remedy', () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const adapter = createMuseAdapter({
      probe: okMuseProbe(),
      spawn: fakeMuseSpawn().spawn,
      readFile: fakeMuseReadFile(cwd),
      makeWorkerConfig: () => {
        throw new Error('tmp full');
      },
    });

    const gate = adapter.profileEnforcement({ cwd, prompt: 'p', tools: 'readonly' });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.remedy).toMatch(/worker config isolation unavailable/);
      expect(gate.remedy).toMatch(/No process was started/);
    }
  });

  it('planStart carries the pin and launch deck instead of rejecting them', () => {
    const adapter = createMuseAdapter({
      probe: okMuseProbe(),
      spawn: fakeMuseSpawn().spawn,
      readFile: fakeMuseReadFile('/tmp/x'),
    });
    expect(
      adapter.planStart({
        cwd: '/tmp/x',
        prompt: 'p',
        tools: 'readonly',
        playbookPin: { playbookId: 'pb', versionId: 'v' },
        launchDeckId: 'deck-other',
      }),
    ).toEqual({ ok: true, trustOverride: false });
  });
});

describe('muse worker MCP identity (NOT-671)', () => {
  it('the worker entry carries the daemon URL and the workspace, pin, deck, and token headers', () => {
    expect(buildMuseWorkerMcpEntry({ workspaceRoot: '/work' })).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:1110/mcp',
      headers: { 'x-agent-deck-workspace': '/work' },
    });
    expect(
      buildMuseWorkerMcpEntry(
        {
          workspaceRoot: '/work',
          playbookPin: { playbookId: 'pb', versionId: 'v1' },
          launchDeckId: 'deck-1',
          runToken: 't'.repeat(64),
        },
        { host: '127.0.0.1', port: '2222' },
      ),
    ).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:2222/mcp',
      headers: {
        'x-agent-deck-workspace': '/work',
        'x-agent-deck-playbook-pin': 'pb=v1',
        'x-agent-deck-deck-id': 'deck-1',
        'x-agent-deck-run-token': 't'.repeat(64),
      },
    });
    expect(
      buildMuseWorkerSettingsDocument(buildMuseWorkerMcpEntry({ workspaceRoot: '/work' })),
    ).toEqual({
      schema_version: 1,
      mcpServers: {
        'agent-deck': {
          type: 'http',
          url: 'http://127.0.0.1:1110/mcp',
          headers: { 'x-agent-deck-workspace': '/work' },
        },
      },
    });
  });

  it('the worker config holds only the run entry and carries auth through', () => {
    const configHome = makeDir('agent-deck-muse-worker-');
    const document = buildMuseWorkerSettingsDocument(
      buildMuseWorkerMcpEntry({ workspaceRoot: '/w' }),
    );

    expect(setupMuseWorkerConfig({ configHome, settingsDocument: document, authText: AUTH_JSON })).toBe(
      configHome,
    );
    expect(JSON.parse(fs.readFileSync(path.join(configHome, 'muse', 'settings.json'), 'utf8'))).toEqual(
      document,
    );
    expect(fs.readFileSync(path.join(configHome, 'muse', 'auth.json'), 'utf8')).toBe(AUTH_JSON);
    cleanupMuseWorkerConfig(configHome);
    expect(fs.existsSync(configHome)).toBe(false);
  });

  it('start spawns with XDG_CONFIG_HOME pointed at a cleaned-up worker config', async () => {
    const cwd = makeDir('agent-deck-muse-cwd-');
    const homeDir = makeDir('agent-deck-muse-home-');
    const deps = makeDeps(cwd, homeDir);

    expect(await runRunCommand(museArgs(cwd), deps)).toBe(0);
    expect(deps.calls).toHaveLength(1);
    const childConfigHome = deps.calls[0].env?.XDG_CONFIG_HOME;
    expect(childConfigHome).toBeTruthy();
    expect(childConfigHome).not.toBe(process.env.XDG_CONFIG_HOME);
    // Per-run: removed after the stream ends.
    expect(fs.existsSync(childConfigHome as string)).toBe(false);
  });

  it('start without a worker token fails closed before spawn', async () => {
    const { spawn, calls } = fakeMuseSpawn();
    const adapter = createMuseAdapter({
      probe: okMuseProbe(),
      spawn,
      readFile: fakeMuseReadFile('/tmp/x'),
    });
    await expect(async () => {
      for await (const _event of adapter.start({ cwd: '/tmp/x', prompt: 'p', tools: 'readonly' })) {
        // Drain.
      }
    }).rejects.toThrow(/without a worker token/);
    expect(calls).toHaveLength(0);
  });
});

describe('muse client denials (NOT-671)', () => {
  it('denied flags, policy decisions, and refusal reasons become denials', () => {
    expect(
      museDenialFromPayload('tool_batch.effect.started', {
        denied: true,
        reason: 'sandbox blocked file write to /work/a.txt',
        record: { tool_name: 'write_file', call_id: 'call_1' },
      }),
    ).toEqual({
      target: 'write_file',
      reason: 'sandbox blocked file write to /work/a.txt',
      denialKind: 'file_write',
    });
    expect(
      museDenialFromPayload('task.lifecycle.side_effect_intent', {
        operation: 'shell.exec',
        policy_decision: 'denied',
      }),
    ).toEqual(expect.objectContaining({ denialKind: 'shell', target: 'shell.exec' }));
    expect(
      museDenialFromPayload('run.terminal.failed', { reason: 'network request blocked' }),
    ).toEqual(expect.objectContaining({ denialKind: 'network' }));
  });

  it('answer text, prompts, and ordinary payloads never become denials', () => {
    expect(
      museDenialFromPayload('run.output.delta', { text: 'writes are denied in readonly mode' }),
    ).toBeNull();
    expect(museDenialFromPayload('turn.input.user', { reason: 'denied' })).toBeNull();
    expect(museDenialFromPayload('task.lifecycle.started', { kind: 'task_lifecycle' })).toBeNull();
    expect(
      museDenialFromPayload('task.lifecycle.side_effect_intent', {
        operation: 'model.unknown.response',
        policy_decision: 'not_applicable',
      }),
    ).toBeNull();
    expect(
      museDenialFromPayload('run.terminal.cancelled', { reason: 'user quit' }),
    ).toBeNull();
  });

  it('denials surface ahead of the line events without replacing them', () => {
    const ctx: MuseLineContext = { sessionId: null };
    const toolEvents = museEventsFromLine(
      envelope('s7', 'tool_batch.effect.started', {
        denied: true,
        reason: 'command execution denied by policy',
        record: { tool_name: 'shell', call_id: 'call_2' },
      }),
      ctx,
    );
    expect(toolEvents.map((event) => event.kind)).toEqual(['denial', 'tool']);
    expect(toolEvents[0]).toMatchObject({
      kind: 'denial',
      denialKind: 'shell',
      target: 'shell',
      sessionId: 's7',
    });
    const terminalEvents = museEventsFromLine(
      envelope('s7', 'run.terminal.failed', {
        kind: 'run_terminal',
        terminal: 'failed',
        reason: 'file write blocked by sandbox',
      }),
      ctx,
    );
    expect(terminalEvents.map((event) => event.kind)).toEqual(['denial', 'result']);
    // A completed answer mentioning a refusal stays a plain result.
    expect(
      museEventsFromLine(
        envelope('s7', 'run.terminal.completed', {
          kind: 'run_terminal',
          terminal: 'completed',
          text: 'the write was denied, so I read instead',
        }),
        ctx,
      ).map((event) => event.kind),
    ).toEqual(['result']);
  });

  it('a run records client denials with the effective profile', async () => {
    for (const tools of ['readonly', 'edit'] as const) {
      const cwd = makeDir('agent-deck-muse-cwd-');
      const homeDir = makeDir('agent-deck-muse-home-');
      const sessionId = `ses_denied_${tools}`;
      const deps = makeDeps(cwd, homeDir, {
        lines: successStream(sessionId, [
          envelope(sessionId, 'tool_batch.effect.started', {
            denied: true,
            reason: 'sandbox blocked file write to /work/a.txt',
            record: { tool_name: 'write_file', call_id: 'call_3' },
          }),
          deltaLine(sessionId, 'done despite refusal'),
        ]),
      });

      expect(await runRunCommand(museArgs(cwd, ['--tools', tools]), deps)).toBe(0);
      const meta = readMeta(logPathFromStdout());
      expect(meta.state).toBe('ended');
      expect(meta.denials).toHaveLength(1);
      expect(meta.denials?.[0]).toMatchObject({
        client: 'muse',
        profile: tools,
        source: 'client',
        kind: 'file_write',
      });
      logs = [];
    }
  });
});
