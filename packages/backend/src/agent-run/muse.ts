/**
 * Muse adapter for `agent-deck run` (NOT-407; worker-profile enforcement NOT-671).
 *
 * Drives `muse exec --json` (start) and `muse exec --json --session-id <id>`
 * (resume) as a child process and maps the JSONL stream onto normalized
 * events. Verified against Muse Code 1.4.4 (1.4.4-R5419.1) via `muse
 * --version`, `muse --help`, `muse exec --help`, `muse mcp --help`, `muse mcp
 * login --help`, `muse config --help`, and echo-provider captures in
 * /tmp/smoke, with the enforcement flags re-verified on 1.4.25. Tool mapping
 * (NOT-671): both profiles pass `--approval-mode never` (no prompt can
 * occur, on start and resume); `readonly` adds `--disable-write` plus
 * `--sandbox-network restricted`; `edit` adds `--sandbox-network enabled`.
 * The sandbox stays ON (default) on both profiles:
 *
 * - Every stdout record carries `stream: {kind: "session", id}`; that id is
 *   the session id. Assistant text streams as `run.output.delta`
 *   (`payload.text`); tool calls arrive as `tool_batch.effect.started`
 *   (`payload.record.tool_name`, e.g. "read_memory" in a stored session
 *   log); the final `run.terminal.completed` carries the result `text`.
 *   Anything else (task.lifecycle.*, turn.input.user, ...) is ignored so a
 *   newer CLI cannot break the log.
 * - Warnings (the untrusted-workspace notice, "Agent delegation: auto
 *   unavailable") print to stderr as `muse: ...` lines, never to stdout, so
 *   the adapter merges stdout and stderr by arrival and maps warning-shaped
 *   stderr lines to `notice` events. Notices never fail the run.
 * - Resume passes the previous session id via `--session-id <id>` and the
 *   process reports the same id back (verified with the echo provider).
 * - `--permission-profile` selects ONLY enterprise-plane profiles: 1.4.4
 *   ships with none, user settings.json has no such key ("profile does not
 *   exist" for every candidate id), so the adapter never passes it. Tool
 *   profiles map to Muse's own enforcement flags instead (see below), and
 *   the gate fails closed unless the installed muse lists every flag the
 *   requested profile needs in `muse exec --help`.
 * - Readonly keeps shell reads and web reads: `--disable-shell` would block
 *   all shell execution and `--disable-web-tools` all web tools, so neither
 *   is passed — filesystem writes are blocked by `--disable-write` plus the
 *   sandbox, outbound mutations by `--sandbox-network restricted`.
 * - Per-run MCP identity (NOT-671): the child spawns with `XDG_CONFIG_HOME`
 *   pointed at a per-run worker config whose `muse/settings.json` holds
 *   ONLY the run's `agent-deck` entry (daemon URL plus the workspace,
 *   launch-deck, playbook-pin, and worker-token headers), with the real
 *   `muse/auth.json` copied in so sign-in survives the isolation. Sessions
 *   live outside the config home, so resume is unaffected. A project
 *   `.mcp.json` (cwd up to the filesystem root) defining any non-`agent-deck`
 *   server fails closed before spawn.
 * - Signed-in preflight is `providers.meta` in the Muse auth file (or
 *   META_API_KEY), which makes no model call; there is no `login status`
 *   subcommand.
 *
 * Never selected, with no flag, env var, or option that selects them:
 * `--yolo`, `--trust-workspace`, `--disable-approval`, `--disable-sandbox`
 * (all disable checks or mark the workspace trusted),
 * `--permission-profile` (no valid id exists; any value aborts the run),
 * `--disable-shell` (would block readonly shell reads), and
 * `--disable-web-tools` (would block readonly web reads). Tests assert no
 * generated argv ever contains the forbidden flags.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  formatRunPlaybookPin,
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
  type RunPlaybookPin,
  type RunProcessControl,
  type RunToolsProfile,
} from './adapter';

/** Enforcement flags re-verified against this build (`muse exec --help`). */
export const MUSE_ENFORCEMENT_VERSION_NOTE = 'Muse Code 1.4.25';

/**
 * Both profiles: no approval prompt can occur, on start and resume alike.
 * Enforcement comes from the profile flags below plus the sandbox (ON by
 * default), never from interactive approval.
 */
export const MUSE_APPROVAL_FLAGS: readonly string[] = ['--approval-mode', 'never'];

/**
 * readonly: `--disable-write` blocks non-shell workspace file writes and
 * `--sandbox-network restricted` blocks outbound mutations, while the
 * sandbox (ON) confines shell filesystem access — shell reads and web reads
 * stay available. `--disable-shell` is deliberately NOT passed: it would
 * block shell reads too.
 */
export const MUSE_READONLY_FLAGS: readonly string[] = [
  '--disable-write',
  '--sandbox-network',
  'restricted',
];

/**
 * edit: full network access with the sandbox still ON. No `--disable-write`:
 * the profile allows workspace and agent-home writes.
 */
export const MUSE_EDIT_FLAGS: readonly string[] = ['--sandbox-network', 'enabled'];

export const MUSE_FLAGS_FOR_PROFILE: Record<RunToolsProfile, readonly string[]> = {
  readonly: MUSE_READONLY_FLAGS,
  edit: MUSE_EDIT_FLAGS,
};

/** Flags that must never appear in generated argv (bypass checks, trust, or reads). */
export const MUSE_FORBIDDEN_FLAGS: readonly string[] = [
  '--yolo',
  '--trust-workspace',
  '--disable-approval',
  '--disable-sandbox',
  '--permission-profile',
  '--disable-shell',
  '--disable-web-tools',
];

export function resolveMuseBin(): string {
  return process.env.MUSE_BIN?.trim() || 'muse';
}

/**
 * Help-text markers the installed `muse` must list for the requested profile
 * (NOT-671): `--approval-mode` and `--sandbox-network` always, plus
 * `--disable-write` for readonly.
 */
export function museHelpTextSupportsEnforcement(helpText: string, tools: RunToolsProfile): boolean {
  if (!helpText.includes('--approval-mode') || !helpText.includes('--sandbox-network')) {
    return false;
  }
  return tools === 'edit' || helpText.includes('--disable-write');
}

/**
 * Enforcement is structural AND verified: the flags must exist in
 * `muse exec --help` output, and the profile gate fails closed when the
 * installed muse does not list them, so a run never silently proceeds under
 * default permissions. Help text, not a model call.
 */
export function museEnforcementFlagsSupported(
  probe: (bin: string, argv: string[]) => { code: number; stdout: string; stderr: string },
  bin: string,
  tools: RunToolsProfile,
): boolean {
  const help = probe(bin, ['exec', '--help']);
  if (help.code !== 0) {
    return false;
  }
  return museHelpTextSupportsEnforcement(`${help.stdout}\n${help.stderr}`, tools);
}

export type MuseArgvArgs = {
  prompt: string;
  tools: RunToolsProfile;
  resumeId?: string;
};

/**
 * Resume ids are muse session ids (UUIDs); a leading `-` is never legitimate
 * and would be parsed as an exec option, so it fails closed in planStart and
 * throws here.
 */
export function assertSafeMuseResumeId(resumeId: string): void {
  if (resumeId.startsWith('-')) {
    throw new Error(
      `Invalid --resume id ${JSON.stringify(resumeId)}: session ids never start with '-'. ` +
        'Pass the session id printed as sessionId in a previous run log.',
    );
  }
}

/**
 * Pure argv builder (everything after the `muse` binary). Start:
 * `exec --json --approval-mode never <profile flags> -- <prompt>`; resume:
 * `exec --json --approval-mode never <profile flags> --session-id <id> --
 * <prompt>`. The `--` terminator (accepted by `muse exec`, verified with the
 * echo provider) keeps dash-leading prompts from being parsed as muse
 * options.
 */
export function buildMuseArgv(args: MuseArgvArgs): string[] {
  const argv = ['exec', '--json', ...MUSE_APPROVAL_FLAGS];
  argv.push(...MUSE_FLAGS_FOR_PROFILE[args.tools]);
  if (args.resumeId !== undefined) {
    assertSafeMuseResumeId(args.resumeId);
    argv.push('--session-id', args.resumeId);
  }
  argv.push('--', args.prompt);
  return argv;
}

/**
 * Header names the run's MCP entry sends. Literals (not `@agent-deck/shared` —
 * this module imports node built-ins and siblings only, NOT-479); they must
 * match `AGENT_DECK_WORKSPACE_HEADER` / `AGENT_DECK_PLAYBOOK_PIN_HEADER` /
 * `AGENT_DECK_DECK_ID_HEADER` / `AGENT_DECK_RUN_TOKEN_HEADER`.
 */
export const MUSE_WORKER_WORKSPACE_HEADER = 'x-agent-deck-workspace';
export const MUSE_WORKER_PLAYBOOK_PIN_HEADER = 'x-agent-deck-playbook-pin';
export const MUSE_WORKER_LAUNCH_DECK_HEADER = 'x-agent-deck-deck-id';
export const MUSE_WORKER_RUN_TOKEN_HEADER = 'x-agent-deck-run-token';

/**
 * MCP endpoint the worker entry preserves. Malformed values fall back to the
 * defaults rather than breaking a run.
 */
export function museWorkerEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): { port: string; host: string } {
  const port = env.AGENT_DECK_MCP_PORT?.trim() ?? '';
  const host = env.AGENT_DECK_HOST?.trim() ?? '';
  return {
    port: /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 ? port : '1110',
    host: host ? host : '127.0.0.1',
  };
}

export type MuseWorkerMcpEntryInput = {
  workspaceRoot: string;
  playbookPin?: RunPlaybookPin;
  launchDeckId?: string;
  runToken?: string;
};

/**
 * The run's `agent-deck` MCP entry for the worker config's
 * `muse/settings.json` (NOT-671): the daemon URL plus the workspace header,
 * the playbook pin, the launch deck header, and/or the worker token header
 * when the run has them. Same `{ type: 'http', url, headers }` shape
 * `agent-deck use --client muse` writes for per-folder entries — only the
 * headers are per-run.
 */
export function buildMuseWorkerMcpEntry(
  input: MuseWorkerMcpEntryInput,
  endpoint: { port: string; host: string } = museWorkerEndpoint(),
): Record<string, unknown> {
  const headers: Record<string, string> = {
    [MUSE_WORKER_WORKSPACE_HEADER]: input.workspaceRoot,
    ...(input.playbookPin
      ? { [MUSE_WORKER_PLAYBOOK_PIN_HEADER]: formatRunPlaybookPin(input.playbookPin) }
      : {}),
    ...(input.launchDeckId ? { [MUSE_WORKER_LAUNCH_DECK_HEADER]: input.launchDeckId } : {}),
    ...(input.runToken ? { [MUSE_WORKER_RUN_TOKEN_HEADER]: input.runToken } : {}),
  };
  return {
    type: 'http',
    url: `http://${endpoint.host}:${endpoint.port}/mcp`,
    headers,
  };
}

/**
 * Full `muse/settings.json` document holding ONLY the run's entry (NOT-671).
 * The schema version is the exact value Muse requires (NOT-387); without it
 * the worker config is rejected at startup.
 */
export function buildMuseWorkerSettingsDocument(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  return { schema_version: 1, mcpServers: { 'agent-deck': entry } };
}

/**
 * Write the per-run worker config (NOT-671): `<configHome>/muse/settings.json`
 * holding only the run's entry, plus `<configHome>/muse/auth.json` when the
 * caller passes the real auth text through, so sign-in survives the
 * isolation. Throws with an actionable message when the config cannot be
 * written; the caller removes the directory afterwards (best effort).
 */
export function setupMuseWorkerConfig(input: {
  configHome: string;
  settingsDocument: Record<string, unknown>;
  authText?: string;
}): string {
  const { configHome, settingsDocument, authText } = input;
  try {
    fs.mkdirSync(path.join(configHome, 'muse'), { recursive: true });
    fs.writeFileSync(
      path.join(configHome, 'muse', 'settings.json'),
      `${JSON.stringify(settingsDocument, null, 2)}\n`,
      'utf8',
    );
    if (authText !== undefined) {
      fs.writeFileSync(path.join(configHome, 'muse', 'auth.json'), authText, 'utf8');
    }
  } catch (error) {
    throw new Error(
      `Cannot isolate the muse worker config under ${configHome}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return configHome;
}

/** Best-effort removal of a per-run worker config. */
export function cleanupMuseWorkerConfig(configHome: string): void {
  try {
    fs.rmSync(configHome, { recursive: true, force: true });
  } catch {
    // Tmp reaping covers leftovers; a run must never fail on cleanup.
  }
}

/**
 * Project MCP config paths that can contribute servers to a run in `cwd`
 * (NOT-671): `cwd` itself up to the filesystem root, since Muse loads
 * project entries from the repository root down to the cwd.
 */
export function museProjectMcpPaths(cwd: string): string[] {
  const paths: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    paths.push(path.join(dir, '.mcp.json'));
    const parent = path.dirname(dir);
    if (parent === dir) {
      return paths;
    }
    dir = parent;
  }
}

function museMcpServerNames(documentText: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentText) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return [];
  }
  return Object.keys(servers as Record<string, unknown>);
}

/**
 * Non-`agent-deck` servers defined by project MCP configs for `cwd` (NOT-671).
 * Any entry here fails the run closed before spawn: in a trusted workspace
 * Muse would load it alongside the run entry, so the worker MCP session
 * cannot be proven isolated to the run entry. A project `agent-deck` entry
 * is allowed (same server the worker entry names). Unparseable project files
 * fail closed too — an unreadable config cannot be proven isolated.
 */
export function findMuseForeignProjectServers(
  cwd: string,
  readFile: MuseFileReader,
): Array<{ configPath: string; server: string }> {
  const foreign: Array<{ configPath: string; server: string }> = [];
  for (const configPath of museProjectMcpPaths(cwd)) {
    const text = readFile(configPath);
    if (text === null) {
      continue;
    }
    const names = museMcpServerNames(text);
    if (names === null) {
      foreign.push({ configPath, server: '<unparseable .mcp.json>' });
      continue;
    }
    for (const name of names) {
      if (name !== 'agent-deck') {
        foreign.push({ configPath, server: name });
      }
    }
  }
  return foreign;
}

export type MuseProbeResult = { code: number; stdout: string; stderr: string };
export type MuseProbe = (bin: string, argv: string[]) => MuseProbeResult;

export function defaultMuseProbe(bin: string, argv: string[]): MuseProbeResult {
  try {
    const probed = spawnSync(bin, argv, { encoding: 'utf8', timeout: 15000 });
    return { code: probed.status ?? 1, stdout: probed.stdout ?? '', stderr: probed.stderr ?? '' };
  } catch {
    return { code: 127, stdout: '', stderr: '' };
  }
}

export type MuseChild = {
  /** Stdout split into lines (without line terminators). */
  stdout: AsyncIterable<string>;
  /** Stderr split into lines (without line terminators). */
  stderr: AsyncIterable<string>;
  wait: () => Promise<{ code: number | null; stderrTail: string }>;
};

/** `control` (NOT-481): spawn as a new process-group leader and report its id. */
export type MuseSpawnOptions = { cwd: string; control?: RunProcessControl; env?: NodeJS.ProcessEnv };

export type MuseSpawn = (bin: string, argv: string[], opts: MuseSpawnOptions) => MuseChild;

export function defaultMuseSpawn(bin: string, argv: string[], opts: MuseSpawnOptions): MuseChild {
  const child = spawn(bin, argv, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: opts.control !== undefined,
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (opts.control && child.pid !== undefined) {
    opts.control.onProcessGroup(child.pid);
  }
  let spawnError: Error | null = null;
  child.on('error', (error) => {
    spawnError = error;
    child.stdout?.destroy();
    child.stderr?.destroy();
  });
  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  // A second listener on the same stream is fine: every `data` listener gets
  // all chunks, so the tail buffer and the readline iterator below each see
  // the full stderr (verified with a node one-liner, NOT-407).
  function lines(input: typeof child.stdout): AsyncIterable<string> {
    async function* gen(): AsyncGenerator<string> {
      const rl = readline.createInterface({ input: input as NodeJS.ReadableStream });
      try {
        for await (const line of rl) {
          yield line;
        }
      } catch {
        // The stream is destroyed when the spawn itself fails; the spawn
        // error below is the actionable failure.
      }
      if (spawnError) {
        throw spawnError;
      }
    }
    return gen();
  }

  const wait = (): Promise<{ code: number | null; stderrTail: string }> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (code: number | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({
          code,
          stderrTail: Buffer.concat(stderrChunks).toString('utf8').slice(-2000),
        });
      };
      child.on('close', done);
      child.on('error', () => done(127));
    });

  return { stdout: lines(child.stdout), stderr: lines(child.stderr), wait };
}

export type MuseLineContext = { sessionId: string | null };

function withSession<T extends object>(event: T, ctx: MuseLineContext): T & { sessionId?: string } {
  return ctx.sessionId ? { ...event, sessionId: ctx.sessionId } : event;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Client denial kind carried by the `denial` normalized event (never `mcp_tool`). */
export type MuseClientDenialKind = Extract<
  NormalizedEvent,
  { kind: 'denial' }
>['denialKind'];

/** Marks a client-reported refusal in payload reason/error/status fields. */
export const MUSE_DENIAL_PATTERN = /denied|blocked|sandbox|not allowed|needs approval|approval required/i;

function museDenialKind(message: string): MuseClientDenialKind {
  if (/writ|file|edit|save|mkdir|delete|unlink|director/i.test(message)) {
    return 'file_write';
  }
  if (/command|shell|exec|terminal|bash|script/i.test(message)) {
    return 'shell';
  }
  if (/network|http|fetch|url|request|connect/i.test(message)) {
    return 'network';
  }
  return 'client_tool';
}

export type MuseDenialSignal = {
  target: string;
  reason: string;
  denialKind: MuseClientDenialKind;
};

/**
 * Client-reported refusal in one JSONL payload (NOT-671): an explicit
 * `denied: true`, a denied/blocked status or policy decision, or a
 * reason/error matching {@link MUSE_DENIAL_PATTERN}. Free answer text
 * (`run.output.delta`, terminal `text`) is deliberately NOT scanned — an
 * agent explaining the profile would otherwise record phantom denials. The
 * run service records each signal on the run with the effective profile
 * (`source: "client"`). Heuristic: the operator profile runs verify muse
 * surfaces refusals in these fields, and refine the matchers when it does
 * not. Never throws.
 */
export function museDenialFromPayload(
  payloadType: string,
  payload: Record<string, unknown> | null,
): MuseDenialSignal | null {
  if (!payload || payloadType === 'run.output.delta' || payloadType === 'turn.input.user') {
    return null;
  }
  const decision = nonEmptyString(payload.policy_decision);
  const deniedFlag = payload.denied === true;
  const status = nonEmptyString(payload.status) ?? nonEmptyString(payload.state);
  const reason =
    nonEmptyString(payload.reason) ??
    nonEmptyString(payload.error) ??
    nonEmptyString(payload.message);
  const denied =
    deniedFlag ||
    (decision !== null && /denied|blocked|reject/i.test(decision)) ||
    (status !== null && /denied|blocked|rejected/i.test(status)) ||
    (reason !== null && MUSE_DENIAL_PATTERN.test(reason));
  if (!denied) {
    return null;
  }
  const operation = nonEmptyString(payload.operation);
  const item = asRecord(payload.record);
  const toolName = item ? (nonEmptyString(item.tool_name) ?? nonEmptyString(item.call_id)) : null;
  const target = (toolName ?? operation ?? reason ?? decision ?? status ?? payloadType).slice(0, 200);
  const detail = (reason ?? decision ?? status ?? 'denied').slice(0, 500);
  return { target, reason: detail, denialKind: museDenialKind(`${target} ${detail}`) };
}

/**
 * Map one `muse exec --json` stdout line onto normalized events. The session
 * id is captured from `stream: {kind: "session", id}` on every record (no
 * log line); `run.output.delta` becomes `text`; `tool_batch.effect.started`
 * becomes `tool`; client-reported refusals become `denial` (ahead of the
 * line's other events); `run.terminal.completed` becomes `result` (subtype
 * `success`, result text); any other `run.terminal.*` becomes `result`
 * (subtype `failed`). Unknown kinds are ignored so a newer CLI cannot break
 * the log. Never throws: unparseable lines become `notice`.
 */
export function museEventsFromLine(line: string, ctx: MuseLineContext): NormalizedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }
  let event: unknown;
  try {
    event = JSON.parse(trimmed) as unknown;
  } catch {
    return [
      withSession(
        { kind: 'notice', message: `unparseable muse output: ${trimmed.slice(0, 300)}` },
        ctx,
      ),
    ];
  }
  const record = asRecord(event);
  if (!record) {
    return [];
  }
  const stream = asRecord(record.stream);
  if (stream?.kind === 'session') {
    const id = nonEmptyString(stream.id);
    if (id) {
      ctx.sessionId = id;
    }
  }
  const payloadType = nonEmptyString(record.payload_type);
  if (!payloadType) {
    return [];
  }
  const payload = asRecord(record.payload);
  const denial = museDenialFromPayload(payloadType, payload);
  const denialPrefix = denial
    ? [
        withSession(
          {
            kind: 'denial' as const,
            target: denial.target,
            reason: denial.reason,
            denialKind: denial.denialKind,
          },
          ctx,
        ),
      ]
    : [];

  if (payloadType === 'run.output.delta') {
    const text = payload ? nonEmptyString(payload.text) : null;
    return text ? [withSession({ kind: 'text', text }, ctx)] : [];
  }
  if (payloadType === 'tool_batch.effect.started') {
    const item = payload ? asRecord(payload.record) : null;
    const name =
      (item ? nonEmptyString(item.tool_name) : null) ??
      (item ? nonEmptyString(item.call_id) : null) ??
      'tool';
    return [...denialPrefix, withSession({ kind: 'tool', name }, ctx)];
  }
  if (payloadType === 'run.terminal.completed') {
    const text = payload ? nonEmptyString(payload.text) : null;
    return [withSession({ kind: 'result', subtype: 'success', result: text ?? null }, ctx)];
  }
  if (payloadType.startsWith('run.terminal.')) {
    const text = payload ? nonEmptyString(payload.text) : null;
    const reason = payload ? nonEmptyString(payload.reason) : null;
    return [
      ...denialPrefix,
      withSession({ kind: 'result', subtype: 'failed', result: text ?? reason ?? null }, ctx),
    ];
  }
  return denialPrefix;
}

/** Stderr lines matching this surface as `notice` events; others are ignored. */
export const MUSE_STDERR_NOTICE_PATTERN = /warning|untrusted|delegation|error|fail/i;

/**
 * Map one stderr line onto a `notice` message. Muse prints startup warnings
 * (`muse: Agent delegation: auto unavailable: workspace is untrusted.`,
 * `muse: warning: rules file ... skipped ...`) to stderr; those surface as
 * notices while routine diagnostics (`muse: workspace root: ...`, plugin
 * lines) stay out of the log. Returns null for ignored lines. Never throws.
 */
export function museNoticeFromStderr(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (!MUSE_STDERR_NOTICE_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, 500);
}

type MergedLine = { source: 'out' | 'err'; line: string };

/**
 * Merge stdout and stderr line iterables by arrival so startup warnings
 * (stderr) land in the log in real order ahead of the streamed answer. Both
 * sides are always consumed (no pipe deadlock); a rejection on either side
 * throws, and the other side's pending read can never reject unobserved.
 */
export async function* mergeMuseLines(
  stdout: AsyncIterable<string>,
  stderr: AsyncIterable<string>,
): AsyncGenerator<MergedLine> {
  type Settled =
    | { ok: true; result: IteratorResult<string> }
    | { ok: false; error: unknown };
  type Raced = { which: 'out' | 'err'; settled: Settled };
  const outIt = stdout[Symbol.asyncIterator]();
  const errIt = stderr[Symbol.asyncIterator]();
  const safeNext = (which: 'out' | 'err'): Promise<Raced> => {
    const it = which === 'out' ? outIt : errIt;
    return it
      .next()
      .then(
        (result) => ({ which, settled: { ok: true as const, result } }),
        (error: unknown) => ({ which, settled: { ok: false as const, error } }),
      );
  };
  const NEVER: Promise<Raced> = new Promise(() => {});
  let outDone = false;
  let errDone = false;
  let outNext = safeNext('out');
  let errNext = safeNext('err');
  const fail = (error: unknown): Error =>
    new Error(
      `muse run failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
    );
  while (!outDone || !errDone) {
    const winner = await Promise.race([
      outDone ? NEVER : outNext,
      errDone ? NEVER : errNext,
    ]);
    if (winner.settled.ok === false) {
      throw fail(winner.settled.error);
    }
    if (winner.settled.result.done) {
      if (winner.which === 'out') {
        outDone = true;
      } else {
        errDone = true;
      }
      continue;
    }
    yield { source: winner.which, line: winner.settled.result.value };
    if (winner.which === 'out') {
      outNext = safeNext('out');
    } else {
      errNext = safeNext('err');
    }
  }
}

export type MuseFileReader = (path: string) => string | null;

export function defaultMuseFileReader(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

function museConfigHome(): string {
  // Mirrors resolveMuseGlobalConfigDir (CLI mcp-config.ts): Muse honors
  // XDG_CONFIG_HOME for its user settings; otherwise ~/.config.
  return process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
}

function museAuthFilePath(): string {
  return path.join(museConfigHome(), 'muse', 'auth.json');
}

/**
 * Where `agent-deck use --client muse` writes the agent-deck MCP entry:
 * global Muse settings, then the cwd's project `.mcp.json`. Mirrors
 * resolveConfigPath('muse', 'global' | 'project', cwd) in CLI mcp-config.ts.
 */
export function museMcpConfigPaths(cwd: string): string[] {
  return [path.join(museConfigHome(), 'muse', 'settings.json'), path.join(cwd, '.mcp.json')];
}

/**
 * Non-model signed-in check: META_API_KEY takes priority over the account
 * login (`muse login --help`), otherwise the auth file must record a `meta`
 * provider (token itself lives in the keychain; only the metadata is read).
 */
export function isMuseSignedIn(readFile: MuseFileReader): boolean {
  if (process.env.META_API_KEY?.trim()) {
    return true;
  }
  const auth = readFile(museAuthFilePath());
  if (!auth) {
    return false;
  }
  const providers = parseJsonObject(auth)?.providers;
  return asRecord(providers)?.meta != null;
}

/**
 * The agent-deck MCP entry must exist in the global Muse settings or the
 * cwd's project `.mcp.json` (whichever `agent-deck use --client muse` wrote);
 * without it no session receipt can ever appear in the log.
 */
export function hasMuseMcpEntry(cwd: string, readFile: MuseFileReader): boolean {
  for (const candidate of museMcpConfigPaths(cwd)) {
    const text = readFile(candidate);
    if (!text) {
      continue;
    }
    const servers = parseJsonObject(text)?.mcpServers;
    if (asRecord(servers)?.['agent-deck'] != null) {
      return true;
    }
  }
  return false;
}

export type MuseAdapterDeps = {
  bin?: string;
  probe?: MuseProbe;
  spawn?: MuseSpawn;
  readFile?: MuseFileReader;
  /** Allocate a fresh worker-config directory; defaults to a tmpdir mkdtemp. */
  makeWorkerConfig?: () => string;
};

export function defaultMuseMakeWorkerConfig(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-muse-worker-'));
}

export function createMuseAdapter(deps: MuseAdapterDeps = {}): ClientAdapter {
  const bin = deps.bin ?? resolveMuseBin();
  const probe = deps.probe ?? defaultMuseProbe;
  const spawnFn = deps.spawn ?? defaultMuseSpawn;
  const readFile = deps.readFile ?? defaultMuseFileReader;
  const makeWorkerConfig = deps.makeWorkerConfig ?? defaultMuseMakeWorkerConfig;

  return {
    id: 'muse',

    async preflight() {
      const version = probe(bin, ['--version']);
      if (version.code !== 0) {
        return {
          ok: false,
          remedy:
            `muse CLI not found (tried "${bin}"): install Muse Code 1.4+ and ensure 'muse' is on PATH (or set MUSE_BIN=/path/to/muse), then retry.`,
        };
      }
      if (!isMuseSignedIn(readFile)) {
        return {
          ok: false,
          remedy: 'muse is not signed in: run `muse login`, then retry.',
        };
      }
      return { ok: true };
    },

    planStart(args: AdapterStartArgs) {
      if (args.resumeId !== undefined && args.resumeId.startsWith('-')) {
        return {
          ok: false,
          remedy:
            `Invalid --resume id ${JSON.stringify(args.resumeId)}: session ids never start with '-'. ` +
            'Pass the session id printed as sessionId in a previous run log.',
        };
      }
      // NOT-671: the profile flags are verified in profileEnforcement; the
      // agent-deck MCP entry is written per run into the worker config (no
      // pre-registration needed); the playbook pin and the launch deck
      // travel as headers in that entry. No rejection here.
      // Never trust the workspace from run: no --trust-workspace/--yolo, so
      // trustOverride stays false and the untrusted warning surfaces as a
      // notice (agent delegation unavailable is a known limit).
      return { ok: true, trustOverride: false };
    },

    profileEnforcement(args: AdapterStartArgs) {
      // 1. The installed build must list every flag the profile needs.
      if (!museEnforcementFlagsSupported(probe, bin, args.tools)) {
        return {
          ok: false,
          remedy:
            `muse enforcement unavailable (tried "${bin}"): this build does not list --approval-mode, --sandbox-network` +
            `${args.tools === 'readonly' ? ', and --disable-write' : ''} ` +
            `in \`muse exec --help\` (verified on ${MUSE_ENFORCEMENT_VERSION_NOTE}). Upgrade Muse Code, then retry. ` +
            `Refusing to run --tools ${args.tools} without enforceable approval, sandbox, and network boundaries; no process was started.`,
        };
      }
      // 2. The worker MCP session must isolate to the run entry: a project
      // config contributing any foreign server would load alongside it in a
      // trusted workspace.
      const foreign = findMuseForeignProjectServers(args.cwd, readFile);
      if (foreign.length > 0) {
        const first = foreign[0];
        return {
          ok: false,
          remedy:
            `muse MCP isolation unavailable: ${first.configPath} defines MCP server "${first.server}" outside the run entry, ` +
            'which Muse would load alongside it in a trusted workspace. Remove the foreign server from the project MCP config ' +
            '(or run in a folder without one), then retry; no process was started.',
        };
      }
      // 3. The worker config must be writable on this host (a dry run with a
      // tokenless entry — the token is minted after the gate).
      let dryRunHome: string | null = null;
      try {
        dryRunHome = makeWorkerConfig();
        setupMuseWorkerConfig({
          configHome: dryRunHome,
          settingsDocument: buildMuseWorkerSettingsDocument(
            buildMuseWorkerMcpEntry({ workspaceRoot: args.cwd }),
          ),
        });
      } catch (error) {
        return {
          ok: false,
          remedy:
            `muse worker config isolation unavailable: ${error instanceof Error ? error.message : String(error)} ` +
            'No process was started.',
        };
      } finally {
        if (dryRunHome) {
          cleanupMuseWorkerConfig(dryRunHome);
        }
      }
      return { ok: true };
    },

    async *start(args: AdapterStartArgs): AsyncGenerator<NormalizedEvent> {
      const argv = buildMuseArgv({
        prompt: args.prompt,
        tools: args.tools,
        ...(args.resumeId !== undefined ? { resumeId: args.resumeId } : {}),
      });
      // Authenticated worker MCP only: without the run token the worker
      // session could not bind its profile server-side.
      if (!args.runToken) {
        throw new Error(
          'Cannot start a muse worker run without a worker token: the run service always provides one; direct adapter use must pass AdapterStartArgs.runToken.',
        );
      }
      if (args.resumeId !== undefined) {
        yield {
          kind: 'notice',
          message:
            `Resuming muse session ${args.resumeId} with --tools ${args.tools} flags passed to the resumed process.`,
          sessionId: args.resumeId,
        };
      }
      const wrapSpawnError = (error: unknown): Error =>
        new Error(
          `muse run failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
        );
      // Per-run worker config: the child's XDG_CONFIG_HOME, holding only the
      // run's MCP entry (the profile gate already proved the config builds
      // here). The real auth file rides along so sign-in survives.
      let workerConfig: string | null = null;
      try {
        workerConfig = makeWorkerConfig();
        const authText = readFile(museAuthFilePath());
        setupMuseWorkerConfig({
          configHome: workerConfig,
          settingsDocument: buildMuseWorkerSettingsDocument(
            buildMuseWorkerMcpEntry({
              workspaceRoot: args.cwd,
              ...(args.playbookPin ? { playbookPin: args.playbookPin } : {}),
              ...(args.launchDeckId ? { launchDeckId: args.launchDeckId } : {}),
              runToken: args.runToken,
            }),
          ),
          ...(authText ? { authText } : {}),
        });
      } catch (error) {
        if (workerConfig) {
          cleanupMuseWorkerConfig(workerConfig);
        }
        throw wrapSpawnError(error);
      }
      try {
        let child: MuseChild;
        try {
          child = spawnFn(bin, argv, {
            cwd: args.cwd,
            ...(args.control ? { control: args.control } : {}),
            env: { ...process.env, XDG_CONFIG_HOME: workerConfig },
          });
        } catch (error) {
          throw wrapSpawnError(error);
        }
        const ctx: MuseLineContext = { sessionId: args.resumeId ?? null };
        try {
          for await (const merged of mergeMuseLines(child.stdout, child.stderr)) {
            if (merged.source === 'err') {
              const message = museNoticeFromStderr(merged.line);
              if (message) {
                yield withSession({ kind: 'notice', message }, ctx);
              }
              continue;
            }
            for (const event of museEventsFromLine(merged.line, ctx)) {
              yield event;
            }
          }
        } catch (error) {
          throw wrapSpawnError(error);
        }
        let settled: { code: number | null; stderrTail: string };
        try {
          settled = await child.wait();
        } catch (error) {
          throw wrapSpawnError(error);
        }
        const { code, stderrTail } = settled;
        if (code !== 0) {
          throw new Error(
            `muse exited with code ${code}${stderrTail ? `: ${stderrTail.slice(0, 300)}` : ''}`,
          );
        }
      } finally {
        cleanupMuseWorkerConfig(workerConfig);
      }
    },
  };
}
