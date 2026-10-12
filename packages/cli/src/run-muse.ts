/**
 * Muse adapter for `agent-deck run` (NOT-407).
 *
 * Drives `muse exec --json` (start) and `muse exec --json --session-id <id>`
 * (resume) as a child process and maps the JSONL stream onto normalized
 * events. Verified against Muse Code 1.4.4 (1.4.4-R5419.1) via `muse
 * --version`, `muse --help`, `muse exec --help`, `muse mcp --help`, `muse mcp
 * login --help`, `muse config --help`, and echo-provider captures in
 * /tmp/smoke. Tool mapping for this version: readonly passes
 * `--disable-write --disable-shell`; edit passes no extra flags (Muse's
 * default bounded permissions: approval on-request, sandbox on):
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
 *   profiles map to Muse's own enforcement flags instead (see below).
 * - Signed-in preflight is `providers.meta` in the Muse auth file (or
 *   META_API_KEY), which makes no model call; there is no `login status`
 *   subcommand.
 *
 * Never selected, with no flag, env var, or option that selects them:
 * `--yolo`, `--trust-workspace`, `--disable-approval`, `--disable-sandbox`
 * (all disable checks or mark the workspace trusted), and
 * `--permission-profile` (no valid id exists; any value aborts the run).
 * `--disable-write`/`--disable-shell` only narrow capabilities for readonly
 * and leave approval and the sandbox on. Tests assert no generated argv ever
 * contains the forbidden flags.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { resolveConfigPath } from './mcp-config';
import {
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
  type RunToolsProfile,
} from './run-adapter';

/**
 * readonly: Muse's own read-only enforcement — `--disable-write` blocks
 * non-shell workspace file writes and `--disable-shell` blocks workspace
 * shell execution, so a readonly run cannot modify the checkout.
 */
export const MUSE_READONLY_FLAGS: readonly string[] = ['--disable-write', '--disable-shell'];

/**
 * edit: default bounded permissions (approval on-request, sandbox on) with
 * no extra flags — there is no named profile to select, and the default
 * never disables checks.
 */
export const MUSE_EDIT_FLAGS: readonly string[] = [];

export const MUSE_FLAGS_FOR_PROFILE: Record<RunToolsProfile, readonly string[]> = {
  readonly: MUSE_READONLY_FLAGS,
  edit: MUSE_EDIT_FLAGS,
};

export const MUSE_JSONL_VERSION_NOTE = 'Muse Code 1.4.4 (1.4.4-R5419.1)';

/** Flags that must never appear in generated argv (bypass checks or trust). */
export const MUSE_FORBIDDEN_FLAGS: readonly string[] = [
  '--yolo',
  '--trust-workspace',
  '--disable-approval',
  '--disable-sandbox',
  '--permission-profile',
];

export function resolveMuseBin(): string {
  return process.env.MUSE_BIN?.trim() || 'muse';
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
 * `exec --json [--disable-write --disable-shell] -- <prompt>`; resume:
 * `exec --json --session-id <id> [--disable-write --disable-shell] -- <prompt>`.
 * The `--` terminator (accepted by `muse exec`, verified with the echo
 * provider) keeps dash-leading prompts from being parsed as muse options.
 */
export function buildMuseArgv(args: MuseArgvArgs): string[] {
  const argv = ['exec', '--json'];
  if (args.resumeId !== undefined) {
    assertSafeMuseResumeId(args.resumeId);
    argv.push('--session-id', args.resumeId);
  }
  argv.push(...MUSE_FLAGS_FOR_PROFILE[args.tools]);
  argv.push('--', args.prompt);
  return argv;
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

export type MuseSpawn = (bin: string, argv: string[], opts: { cwd: string }) => MuseChild;

export function defaultMuseSpawn(bin: string, argv: string[], opts: { cwd: string }): MuseChild {
  const child = spawn(bin, argv, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * Map one `muse exec --json` stdout line onto normalized events. The session
 * id is captured from `stream: {kind: "session", id}` on every record (no
 * log line); `run.output.delta` becomes `text`; `tool_batch.effect.started`
 * becomes `tool`; `run.terminal.completed` becomes `result` (subtype
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
    return [withSession({ kind: 'tool', name }, ctx)];
  }
  if (payloadType === 'run.terminal.completed') {
    const text = payload ? nonEmptyString(payload.text) : null;
    return [withSession({ kind: 'result', subtype: 'success', result: text ?? null }, ctx)];
  }
  if (payloadType.startsWith('run.terminal.')) {
    const text = payload ? nonEmptyString(payload.text) : null;
    const reason = payload ? nonEmptyString(payload.reason) : null;
    return [withSession({ kind: 'result', subtype: 'failed', result: text ?? reason ?? null }, ctx)];
  }
  return [];
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

function museAuthFilePath(): string {
  // Mirrors resolveMuseGlobalConfigDir (mcp-config.ts): Muse honors
  // XDG_CONFIG_HOME for its user settings; otherwise ~/.config.
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(configHome, 'muse', 'auth.json');
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
  const candidates = [
    resolveConfigPath('muse', 'global'),
    resolveConfigPath('muse', 'project', cwd),
  ];
  for (const candidate of candidates) {
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
};

export function createMuseAdapter(deps: MuseAdapterDeps = {}): ClientAdapter {
  const bin = deps.bin ?? resolveMuseBin();
  const probe = deps.probe ?? defaultMuseProbe;
  const spawnFn = deps.spawn ?? defaultMuseSpawn;
  const readFile = deps.readFile ?? defaultMuseFileReader;

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
      if (!hasMuseMcpEntry(args.cwd, readFile)) {
        return {
          ok: false,
          remedy:
            'agent-deck MCP server is not registered with Muse: run `agent-deck setup --client muse` to register it, ' +
            'then retry. If Muse reports the server needs authorization, run `muse mcp login agent-deck` (see `muse mcp --help`).',
        };
      }
      // Never trust the workspace from run: no --trust-workspace/--yolo, so
      // trustOverride stays false and the untrusted warning surfaces as a
      // notice (agent delegation unavailable is a known limit).
      return { ok: true, trustOverride: false };
    },

    async *start(args: AdapterStartArgs): AsyncGenerator<NormalizedEvent> {
      const argv = buildMuseArgv({
        prompt: args.prompt,
        tools: args.tools,
        ...(args.resumeId !== undefined ? { resumeId: args.resumeId } : {}),
      });
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
      let child: MuseChild;
      try {
        child = spawnFn(bin, argv, { cwd: args.cwd });
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
    },
  };
}
