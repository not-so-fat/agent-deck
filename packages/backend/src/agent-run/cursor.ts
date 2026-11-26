/**
 * Cursor adapter for `agent-deck run` (NOT-406; worker-profile enforcement NOT-671).
 *
 * Drives `cursor-agent -p --trust --output-format json` (start and resume, the
 * latter adding `--resume <chatId>`) as a child process and maps the single
 * result object onto normalized events. Verified against cursor-agent
 * 2026.10.01 (`cursor-agent --help`, `cursor-agent status --format json`) for
 * the output shape and 2026.11.22 for the enforcement flags:
 *
 * - Output format is single-shot `json`, not `stream-json`: the stream-json
 *   event shape is uncaptured (no incremental events were observed), while
 *   the owner's smoke test verified `json` returns a result object with
 *   `session_id`. Consequence: all log lines land when the process exits, so
 *   status polling shows no intermediate lines for Cursor.
 * - The answer text is yielded as one `text` event (so the shared session
 *   receipt check sees it) followed by `result`; the full result object is
 *   the `result` payload.
 * - Tool mapping (NOT-671): both profiles pass `--sandbox enabled`
 *   (explicitly selected — the Linux box defaults to a disabled Cursor
 *   sandbox) and `--approve-mcps` (preapproved MCP, isolated to the run's
 *   own entry, so no prompt can occur); `readonly` adds `--plan`
 *   (read-only/planning mode, no edits) and `edit` adds `--force`.
 *   `--force` is command preapproval ("allow commands unless explicitly
 *   denied"), not a sandbox — the sandbox is `--sandbox enabled` on both
 *   profiles. `--yolo` (an alias for `--force`) is never passed and no
 *   option can select it. Every enforcement flag is verified in
 *   `cursor-agent --help` before spawn; a build without any of them fails
 *   closed with an upgrade remedy and nothing spawns.
 * - Per-run MCP identity (NOT-671): the child spawns with `HOME` pointed at
 *   a per-run worker home whose `.cursor/mcp.json` holds ONLY the run's
 *   `agent-deck` entry (daemon URL plus the workspace, launch-deck,
 *   playbook-pin, and worker-token headers), so `--approve-mcps` can only
 *   approve that entry and the worker's MCP session always carries its
 *   token. Every other entry of the real home (and of the real `.cursor`
 *   dir) is symlinked into the worker home, so sign-in, chats (resume),
 *   and agent-home reads/writes keep working; only `mcp.json` is per-run.
 *   A project `.cursor/mcp.json` (cwd up to the filesystem root) that
 *   defines any non-`agent-deck` server fails closed before spawn, because
 *   `--approve-mcps` would approve it too. A project `agent-deck` entry is
 *   allowed: the user entry wins by Cursor's enterprise > user > project
 *   precedence, and the deck receipt check below guards a mismatch.
 * - Deck receipt is mandatory on start (not resume): a success whose output
 *   lacks a `◆ ... ·` display_summary line fails closed as `error`, because
 *   a missing receipt would otherwise look like a correctly bound run.
 *   Resume is exempt (the harness prints the receipt on the first turn
 *   only).
 * - `--trust` is passed on every launch (the caller named --cwd explicitly)
 *   and recorded as `trustOverride: true` in meta.json — the existing meta
 *   field for "launch bypassed a client workspace-trust guard". Without it
 *   the CLI prints "Workspace Trust Required" with an empty success, so that
 *   string (and any empty result at exit 0) fails closed as `error`.
 * - Signed-in preflight is `cursor-agent status --format json` (exit 0 even
 *   when signed out, so the output is parsed, not just the exit code), which
 *   makes no model call.
 * - The prompt is passed after a `--` terminator (verified: `cursor-agent -p
 *   --trust --output-format json -- --help` treats `--help` as the prompt
 *   instead of printing help), so dash-leading prompts cannot be parsed as
 *   options. Resume ids starting with `-` fail closed in planStart.
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

export const CURSOR_JSON_VERSION_NOTE = 'cursor-agent 2026.10.01';

/** Enforcement flags verified against this build (`cursor-agent --help`). */
export const CURSOR_ENFORCEMENT_VERSION_NOTE = 'cursor-agent 2026.11.22';

/** Single-shot result object; stream-json incremental shape is unverified. */
export const CURSOR_OUTPUT_FORMAT = 'json';

export function resolveCursorBin(): string {
  return process.env.CURSOR_BIN?.trim() || 'cursor-agent';
}

export type CursorArgvArgs = {
  prompt: string;
  tools: RunToolsProfile;
  resumeId?: string;
};

/**
 * Resume ids are cursor chat ids (32-hex); a leading `-` is never legitimate
 * and would be parsed as a cursor-agent option, so it fails closed in
 * planStart and throws here. Belt and suspenders with the `--` placement
 * below: this builder never emits a dash-leading id at all.
 */
export function assertSafeCursorResumeId(resumeId: string): void {
  if (resumeId.startsWith('-')) {
    throw new Error(
      `Invalid --resume id ${JSON.stringify(resumeId)}: session ids never start with '-'. ` +
        'Pass the chat id printed as sessionId in a previous run log.',
    );
  }
}

/**
 * Profile flags (NOT-671): `readonly` runs plan mode (no edits) without
 * command preapproval; `edit` runs the default mode with `--force` command
 * preapproval. `--force` is NOT a sandbox — both profiles also pass
 * `--sandbox enabled` (see {@link buildCursorArgv}).
 */
export const CURSOR_FLAGS_FOR_PROFILE: Record<RunToolsProfile, readonly string[]> = {
  readonly: ['--plan'],
  edit: ['--force'],
};

/** Flags that must never appear in generated argv (bypass checks). */
export const CURSOR_FORBIDDEN_FLAGS: readonly string[] = ['--yolo'];

/**
 * Pure argv builder (everything after the `cursor-agent` binary):
 * `-p --trust --output-format json --sandbox enabled [--plan | --force]
 * --approve-mcps [--resume <id>] -- <prompt>`.
 * `--sandbox enabled` is explicit on both profiles (the Linux box defaults
 * to a disabled sandbox); `--approve-mcps` preapproves the run's own MCP
 * entry (isolated via the worker home, so no prompt can occur);
 * `--plan` only for readonly, `--force` only for edit; `--yolo` is never
 * emitted. The `--` terminator keeps dash-leading prompts from being parsed
 * as cursor-agent options.
 */
export function buildCursorArgv(args: CursorArgvArgs): string[] {
  const argv = ['-p', '--trust', '--output-format', CURSOR_OUTPUT_FORMAT, '--sandbox', 'enabled'];
  argv.push(...CURSOR_FLAGS_FOR_PROFILE[args.tools]);
  argv.push('--approve-mcps');
  if (args.resumeId !== undefined) {
    assertSafeCursorResumeId(args.resumeId);
    argv.push('--resume', args.resumeId);
  }
  argv.push('--', args.prompt);
  return argv;
}

/**
 * Help-text markers the installed `cursor-agent` must list for enforcement
 * (NOT-671). `--plan` and `--mode` are alternatives (the former is shorthand
 * for `--mode plan`); the other two are required literally.
 */
export const CURSOR_ENFORCEMENT_HELP_MARKERS: readonly string[] = [
  '--sandbox',
  '--approve-mcps',
];

export function cursorHelpTextSupportsEnforcement(helpText: string): boolean {
  return (
    CURSOR_ENFORCEMENT_HELP_MARKERS.every((flag) => helpText.includes(flag)) &&
    (helpText.includes('--plan') || helpText.includes('--mode'))
  );
}

/**
 * Enforcement support probe (NOT-671): `cursor-agent --help` must exit 0 and
 * list `--sandbox`, `--approve-mcps`, and `--plan`/`--mode`. Help text, not a
 * model call. A build without any of them cannot enforce the profile, so the
 * run fails closed with an upgrade remedy and nothing spawns.
 */
export function cursorEnforcementFlagsSupported(
  probe: (bin: string, argv: string[]) => { code: number; stdout: string; stderr: string },
  bin: string,
): boolean {
  const help = probe(bin, ['--help']);
  if (help.code !== 0) {
    return false;
  }
  return cursorHelpTextSupportsEnforcement(`${help.stdout}\n${help.stderr}`);
}

/**
 * Header names the run's MCP entry sends. Literals (not `@agent-deck/shared` —
 * this module imports node built-ins and siblings only, NOT-479); they must
 * match `AGENT_DECK_WORKSPACE_HEADER` / `AGENT_DECK_PLAYBOOK_PIN_HEADER` /
 * `AGENT_DECK_DECK_ID_HEADER` / `AGENT_DECK_RUN_TOKEN_HEADER`.
 */
export const CURSOR_WORKER_WORKSPACE_HEADER = 'x-agent-deck-workspace';
export const CURSOR_WORKER_PLAYBOOK_PIN_HEADER = 'x-agent-deck-playbook-pin';
export const CURSOR_WORKER_LAUNCH_DECK_HEADER = 'x-agent-deck-deck-id';
export const CURSOR_WORKER_RUN_TOKEN_HEADER = 'x-agent-deck-run-token';

/**
 * MCP endpoint the worker entry preserves. Malformed values fall back to the
 * defaults rather than breaking a run.
 */
export function cursorWorkerEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): { port: string; host: string } {
  const port = env.AGENT_DECK_MCP_PORT?.trim() ?? '';
  const host = env.AGENT_DECK_HOST?.trim() ?? '';
  return {
    port: /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 ? port : '1110',
    host: host ? host : '127.0.0.1',
  };
}

export type CursorWorkerMcpEntryInput = {
  workspaceRoot: string;
  playbookPin?: RunPlaybookPin;
  launchDeckId?: string;
  runToken?: string;
};

/**
 * The run's `agent-deck` MCP entry for the worker home's `.cursor/mcp.json`
 * (NOT-671): the daemon URL plus the workspace header, the playbook pin, the
 * launch deck header, and/or the worker token header when the run has them.
 * Same `{ url, headers }` shape `agent-deck use --client cursor` writes for
 * per-folder entries — only the headers are per-run.
 */
export function buildCursorWorkerMcpEntry(
  input: CursorWorkerMcpEntryInput,
  endpoint: { port: string; host: string } = cursorWorkerEndpoint(),
): Record<string, unknown> {
  const headers: Record<string, string> = {
    [CURSOR_WORKER_WORKSPACE_HEADER]: input.workspaceRoot,
    ...(input.playbookPin
      ? { [CURSOR_WORKER_PLAYBOOK_PIN_HEADER]: formatRunPlaybookPin(input.playbookPin) }
      : {}),
    ...(input.launchDeckId ? { [CURSOR_WORKER_LAUNCH_DECK_HEADER]: input.launchDeckId } : {}),
    ...(input.runToken ? { [CURSOR_WORKER_RUN_TOKEN_HEADER]: input.runToken } : {}),
  };
  return {
    url: `http://${endpoint.host}:${endpoint.port}/mcp`,
    headers,
  };
}

/** Full `.cursor/mcp.json` document holding ONLY the run's entry. */
export function buildCursorWorkerMcpDocument(entry: Record<string, unknown>): Record<string, unknown> {
  return { mcpServers: { 'agent-deck': entry } };
}

/**
 * Project MCP config paths that can contribute servers to a run in `cwd`
 * (NOT-671): `cwd` itself up to the filesystem root, since Cursor resolves
 * the project entry from the project root, not necessarily the run cwd.
 */
export function cursorProjectMcpPaths(cwd: string): string[] {
  const paths: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    paths.push(path.join(dir, '.cursor', 'mcp.json'));
    const parent = path.dirname(dir);
    if (parent === dir) {
      return paths;
    }
    dir = parent;
  }
}

export type CursorFileReader = (path: string) => string | null;

export function defaultCursorFileReader(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function mcpServerNames(documentText: string): string[] | null {
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
 * Any entry here fails the run closed before spawn: `--approve-mcps`
 * approves every loaded server, so a foreign project server cannot be
 * isolated to the run entry. A project `agent-deck` entry is allowed (the
 * worker home's user entry wins by precedence). Unparseable project files
 * fail closed too — an unreadable config cannot be proven isolated.
 *
 * `realHome` (when given) excludes that home's own `.cursor/mcp.json` from
 * the walk: it is the user config, shadowed by the worker home, so its
 * servers can never load. Without the exclusion every user with a foreign
 * global MCP server would fail the gate. Edge case: a run whose cwd IS the
 * home directory would still load that file as the project entry — such
 * runs should use a workspace directory below the home.
 */
export function findCursorForeignProjectServers(
  cwd: string,
  readFile: CursorFileReader,
  realHome?: string,
): Array<{ configPath: string; server: string }> {
  const foreign: Array<{ configPath: string; server: string }> = [];
  const excluded =
    realHome === undefined ? null : path.join(path.resolve(realHome), '.cursor', 'mcp.json');
  for (const configPath of cursorProjectMcpPaths(cwd)) {
    if (excluded !== null && configPath === excluded) {
      continue;
    }
    const text = readFile(configPath);
    if (text === null) {
      continue;
    }
    const names = mcpServerNames(text);
    if (names === null) {
      foreign.push({ configPath, server: '<unparseable mcp.json>' });
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

/**
 * Create the per-run worker home (NOT-671): a fresh directory whose
 * `.cursor/mcp.json` holds ONLY the run's entry, with every other entry of
 * the real home — and of the real `.cursor` dir — symlinked in, so sign-in,
 * chats (resume), skills, and agent-home reads/writes keep working while
 * only `mcp.json` is per-run. Returns the worker home path. Throws with an
 * actionable message when the overlay cannot be built; the caller removes
 * the directory afterwards (best effort).
 */
export function setupCursorWorkerHome(input: {
  workerHome: string;
  realHome: string;
  mcpDocument: Record<string, unknown>;
}): string {
  const { workerHome, realHome, mcpDocument } = input;
  fs.mkdirSync(path.join(workerHome, '.cursor'), { recursive: true });
  const linkIfMissing = (target: string, linkPath: string): void => {
    try {
      fs.lstatSync(linkPath);
      return;
    } catch {
      // Missing: create the symlink below.
    }
    fs.symlinkSync(target, linkPath);
  };
  let homeEntries: string[];
  try {
    homeEntries = fs.readdirSync(realHome);
  } catch (error) {
    throw new Error(
      `Cannot isolate the cursor worker config: cannot read home directory ${realHome}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const entry of homeEntries) {
    if (entry === '.cursor') {
      continue;
    }
    linkIfMissing(path.join(realHome, entry), path.join(workerHome, entry));
  }
  try {
    for (const entry of fs.readdirSync(path.join(realHome, '.cursor'))) {
      if (entry === 'mcp.json') {
        continue;
      }
      linkIfMissing(path.join(realHome, '.cursor', entry), path.join(workerHome, '.cursor', entry));
    }
  } catch {
    // No real `.cursor` dir (fresh machine): the worker home's own
    // `.cursor/mcp.json` below is still complete.
  }
  fs.writeFileSync(
    path.join(workerHome, '.cursor', 'mcp.json'),
    `${JSON.stringify(mcpDocument, null, 2)}\n`,
    'utf8',
  );
  return workerHome;
}

/** Best-effort removal of a per-run worker home (symlinks, never targets). */
export function cleanupCursorWorkerHome(workerHome: string): void {
  try {
    fs.rmSync(workerHome, { recursive: true, force: true });
  } catch {
    // Tmp reaping covers leftovers; a run must never fail on cleanup.
  }
}

export type CursorProbeResult = { code: number; stdout: string; stderr: string };
export type CursorProbe = (bin: string, argv: string[]) => CursorProbeResult;

export function defaultCursorProbe(bin: string, argv: string[]): CursorProbeResult {
  try {
    const probed = spawnSync(bin, argv, { encoding: 'utf8', timeout: 15000 });
    return { code: probed.status ?? 1, stdout: probed.stdout ?? '', stderr: probed.stderr ?? '' };
  } catch {
    return { code: 127, stdout: '', stderr: '' };
  }
}

export type CursorChild = {
  /** Stdout split into lines (without line terminators). */
  stdout: AsyncIterable<string>;
  wait: () => Promise<{ code: number | null; stderrTail: string }>;
};

/** `control` (NOT-481): spawn as a new process-group leader and report its id. */
export type CursorSpawnOptions = { cwd: string; control?: RunProcessControl; env?: NodeJS.ProcessEnv };

export type CursorSpawn = (bin: string, argv: string[], opts: CursorSpawnOptions) => CursorChild;

export function defaultCursorSpawn(bin: string, argv: string[], opts: CursorSpawnOptions): CursorChild {
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
  });
  const stderrChunks: Buffer[] = [];
  child.stderr?.on('data', (chunk) => {
    stderrChunks.push(Buffer.from(chunk));
  });

  async function* lines(): AsyncGenerator<string> {
    const rl = readline.createInterface({ input: child.stdout });
    try {
      for await (const line of rl) {
        yield line;
      }
    } catch {
      // The stdout stream is destroyed when the spawn itself fails; the
      // spawn error below is the actionable failure.
    }
    if (spawnError) {
      throw spawnError;
    }
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

  return { stdout: lines(), wait };
}

/**
 * `cursor-agent status --format json` exits 0 even when signed out
 * (`{"status":"unauthenticated","isAuthenticated":false,...}`), so the
 * output decides. The `isAuthenticated` boolean wins; the `status` string
 * and a text fallback cover older shapes. Unknown output fails closed.
 */
export function isCursorStatusAuthenticated(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (typeof record.isAuthenticated === 'boolean') {
          return record.isAuthenticated;
        }
        if (typeof record.status === 'string') {
          const status = record.status.trim().toLowerCase();
          if (status === 'authenticated') {
            return true;
          }
          if (status === 'unauthenticated') {
            return false;
          }
        }
      }
    } catch {
      // Fall through to the text heuristics below.
    }
  }
  if (/not logged in|unauthenticated/i.test(trimmed)) {
    return false;
  }
  return /logged in/i.test(trimmed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && !!entry);
}

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry) {
      names.push(entry);
      continue;
    }
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const name =
      nonEmptyString(record.name) ??
      nonEmptyString(record.tool) ??
      (nonEmptyString(record.command) ? `command:${record.command as string}`.slice(0, 200) : null);
    if (name) {
      names.push(name);
    }
  }
  return names;
}

/** Client denial kind carried by the `denial` normalized event (never `mcp_tool`). */
export type CursorClientDenialKind = Extract<
  NormalizedEvent,
  { kind: 'denial' }
>['denialKind'];

/** Marks a client-reported refusal in warnings, messages, errors, and tool status. */
export const CURSOR_DENIAL_PATTERN = /denied|blocked|sandbox|not allowed|needs approval|approval required/i;

function cursorDenialKind(message: string): CursorClientDenialKind {
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

export type CursorDenialSignal = {
  target: string;
  reason: string;
  denialKind: CursorClientDenialKind;
};

/**
 * Client-reported refusals in the single-shot result object (NOT-671): every
 * warning/notice/message/error string matching {@link CURSOR_DENIAL_PATTERN},
 * plus tool records carrying an explicit denied/blocked status. Free answer
 * text is deliberately NOT scanned — an agent explaining the profile would
 * otherwise record phantom denials. The run service records each signal on
 * the run with the effective profile (`source: "client"`). Heuristic: the
 * operator profile runs verify cursor-agent surfaces refusals in these
 * fields, and refine the matchers when it does not.
 */
export function cursorDenialsFromResult(
  resultObject: Record<string, unknown>,
): CursorDenialSignal[] {
  const denials: CursorDenialSignal[] = [];
  const candidates = [
    ...stringArray(resultObject.warnings),
    ...stringArray(resultObject.notices),
    ...stringArray(resultObject.messages),
  ];
  const errorText = nonEmptyString(resultObject.error);
  if (errorText) {
    candidates.push(errorText);
  }
  for (const text of candidates) {
    if (CURSOR_DENIAL_PATTERN.test(text)) {
      denials.push({
        target: text.slice(0, 200),
        reason: text.slice(0, 500),
        denialKind: cursorDenialKind(text),
      });
    }
  }
  for (const key of ['tool_calls', 'tools_used', 'tools'] as const) {
    const value = resultObject[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      const record = asRecord(entry);
      if (!record) {
        continue;
      }
      const status = nonEmptyString(record.status) ?? nonEmptyString(record.state);
      const reason =
        nonEmptyString(record.error) ??
        nonEmptyString(record.reason) ??
        nonEmptyString(record.message);
      const denied =
        (status && /denied|blocked|rejected/i.test(status)) ||
        (reason && CURSOR_DENIAL_PATTERN.test(reason));
      if (!denied) {
        continue;
      }
      const name = nonEmptyString(record.name) ?? nonEmptyString(record.tool) ?? 'tool';
      const detail = reason ?? status ?? 'denied';
      denials.push({
        target: name.slice(0, 200),
        reason: detail.slice(0, 500),
        denialKind: cursorDenialKind(`${name} ${detail}`),
      });
    }
  }
  return denials;
}

/**
 * Map the single-shot `--output-format json` stdout onto normalized events:
 * the result object's `session_id` becomes `sessionId`; the answer text
 * becomes one `text` event; tool arrays become `tool` events; warning arrays
 * become `notice` events; client-reported refusals become `denial` events;
 * the full object becomes the `result` payload
 * (subtype `success`, or `failed` when the object carries `error`,
 * `is_error: true`, or a non-`success` subtype).
 *
 * Throws (so the shared run code marks the run `error`) on "Workspace Trust
 * Required", on empty output at exit 0, on non-JSON output, on a result
 * object with no answer text, tool call, or error content (a bare session
 * id, including the resume-id fallback, is not content), and — on start
 * only, not resume — on a success whose output lacks a `◆ ... ·` deck
 * receipt line. Never returns an empty event list: success always ends with
 * a `result` event.
 */
export function cursorEventsFromOutput(
  stdout: string,
  opts: { resumeId?: string } = {},
): NormalizedEvent[] {
  if (stdout.includes('Workspace Trust Required')) {
    throw new Error(
      'cursor-agent reported "Workspace Trust Required": open the folder in Cursor and accept the workspace trust prompt, then retry.',
    );
  }
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      'cursor-agent returned an empty result (exit 0): retry the run; if it persists, check `cursor-agent status` and re-run the prompt by hand to see the raw error.',
    );
  }

  let resultObject: Record<string, unknown> | null = null;
  let parsedWhole = false;
  try {
    resultObject = asRecord(JSON.parse(trimmed) as unknown);
    parsedWhole = resultObject !== null;
  } catch {
    parsedWhole = false;
  }
  const notices: NormalizedEvent[] = [];
  if (!parsedWhole) {
    // Tolerate warning lines around the result object; anything that is not
    // JSON becomes a notice so a newer CLI cannot break the log.
    for (const line of trimmed.split('\n')) {
      const candidate = line.trim();
      if (!candidate) {
        continue;
      }
      try {
        const parsed = asRecord(JSON.parse(candidate) as unknown);
        if (parsed) {
          resultObject = parsed;
        }
      } catch {
        notices.push({
          kind: 'notice',
          message: `unparseable cursor-agent output: ${candidate.slice(0, 300)}`,
        });
      }
    }
  }
  if (!resultObject) {
    throw new Error(
      `cursor-agent returned unexpected (non-JSON) output: ${trimmed.slice(0, 300)} Re-run the prompt by hand with --output-format json to see the raw error.`,
    );
  }

  // Session aliases are chat-id shaped only: a bare `id` may be a request
  // or message id rather than the chat id, which would resume the wrong
  // session.
  const sessionId =
    firstString(resultObject, ['session_id', 'sessionId', 'chat_id', 'chatId']) ??
    opts.resumeId ??
    null;
  const withSession = sessionId ? { sessionId } : {};

  const errorValue = resultObject.error;
  const errorText = nonEmptyString(errorValue);
  const isErrorFlag = resultObject.is_error === true;
  const subtypeRaw = nonEmptyString(resultObject.subtype);
  const nonSuccessSubtype =
    subtypeRaw && subtypeRaw !== 'success' ? subtypeRaw : null;
  if (errorText || asRecord(errorValue) || isErrorFlag || nonSuccessSubtype) {
    const denials: NormalizedEvent[] = cursorDenialsFromResult(resultObject).map((denial) => ({
      kind: 'denial' as const,
      target: denial.target,
      reason: denial.reason,
      denialKind: denial.denialKind,
      ...withSession,
    }));
    return [
      ...notices.map((notice) =>
        sessionId ? { ...notice, sessionId } : notice,
      ),
      ...denials,
      {
        kind: 'result',
        subtype: nonSuccessSubtype ?? 'failed',
        result: errorValue ?? resultObject,
        ...withSession,
      },
    ];
  }

  const events: NormalizedEvent[] = [...notices];
  const warnings = [
    ...stringArray(resultObject.warnings),
    ...stringArray(resultObject.notices),
    ...stringArray(resultObject.messages).filter((message) => /warn/i.test(message)),
  ];
  for (const warning of warnings) {
    events.push({ kind: 'notice', message: warning.slice(0, 500), ...withSession });
  }

  const answerText = firstString(resultObject, [
    'result',
    'text',
    'message',
    'response',
    'output',
    'answer',
  ]);
  // Array content blocks (claude-style text/tool_use) when the result nests them.
  const blocks = Array.isArray(resultObject.content) ? resultObject.content : [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record) {
      continue;
    }
    if ((record.type === 'text' || record.type === undefined) && typeof record.text === 'string' && record.text) {
      events.push({ kind: 'text', text: record.text, ...withSession });
    } else if (
      (record.type === 'tool_use' || record.type === 'function_call') &&
      typeof record.name === 'string' &&
      record.name
    ) {
      events.push({ kind: 'tool', name: record.name, ...withSession });
    }
  }
  if (answerText) {
    events.push({ kind: 'text', text: answerText, ...withSession });
  }
  const tools = [
    ...toolNames(resultObject.tool_calls),
    ...toolNames(resultObject.tools_used),
    ...toolNames(resultObject.tools),
  ];
  for (const name of tools) {
    events.push({ kind: 'tool', name: name.slice(0, 200), ...withSession });
  }

  // A bare session id (including the resume-id fallback) is not content:
  // `{"session_id":"x","result":""}` and `{}` on --resume are empty results.
  const hasContent =
    answerText !== null ||
    tools.length > 0 ||
    events.some((event) => event.kind === 'text' || event.kind === 'tool');
  if (!hasContent) {
    throw new Error(
      'cursor-agent returned an empty result (exit 0): the result object has no answer text or tool calls — retry the run; if it persists, re-run the prompt by hand to see the raw error.',
    );
  }

  // Mandatory deck receipt on start: without a `◆ ... ·` display_summary
  // line the run cannot prove it bound to the requested deck. Resume is
  // exempt — the harness prints the receipt on the first turn only, so a
  // resumed turn legitimately carries no new receipt. A present-but-wrong
  // receipt is caught by the shared mismatch check in service.ts.
  if (opts.resumeId === undefined && !/◆\s*[^·\r\n]+?\s*·/.test(stdout)) {
    throw new Error(
      "cursor-agent run produced no deck receipt (missing ◆ display_summary line): the session may be bound to another folder's deck. Ask the agent to call get_session_context and print display_summary verbatim, then retry.",
    );
  }

  for (const denial of cursorDenialsFromResult(resultObject)) {
    events.push({
      kind: 'denial',
      target: denial.target,
      reason: denial.reason,
      denialKind: denial.denialKind,
      ...withSession,
    });
  }
  events.push({ kind: 'result', subtype: 'success', result: resultObject, ...withSession });
  return sessionId
    ? events.map((event) => ('sessionId' in event && event.sessionId ? event : { ...event, sessionId }))
    : events;
}

export type CursorAdapterDeps = {
  bin?: string;
  probe?: CursorProbe;
  spawn?: CursorSpawn;
  readFile?: CursorFileReader;
  /** Real home the worker-home overlay links from; defaults to `os.homedir()`. */
  homedir?: () => string;
  /** Allocate a fresh worker-home directory; defaults to a tmpdir mkdtemp. */
  makeWorkerHome?: () => string;
};

export function defaultCursorMakeWorkerHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-cursor-worker-'));
}

export function createCursorAdapter(deps: CursorAdapterDeps = {}): ClientAdapter {
  const bin = deps.bin ?? resolveCursorBin();
  const probe = deps.probe ?? defaultCursorProbe;
  const spawnFn = deps.spawn ?? defaultCursorSpawn;
  const readFile = deps.readFile ?? defaultCursorFileReader;
  const homedir = deps.homedir ?? os.homedir;
  const makeWorkerHome = deps.makeWorkerHome ?? defaultCursorMakeWorkerHome;

  return {
    id: 'cursor',

    async preflight() {
      const version = probe(bin, ['--version']);
      if (version.code !== 0) {
        return {
          ok: false,
          remedy:
            `cursor-agent CLI not found (tried "${bin}"): install cursor-agent 2026.10+ and ensure 'cursor-agent' is on PATH (or set CURSOR_BIN=/path/to/cursor-agent), then retry.`,
        };
      }
      const status = probe(bin, ['status', '--format', 'json']);
      if (status.code !== 0 || !isCursorStatusAuthenticated(status.stdout)) {
        return {
          ok: false,
          remedy: 'cursor-agent is not signed in: run `cursor-agent login`, then retry.',
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
            'Pass the chat id printed as sessionId in a previous run log.',
        };
      }
      // NOT-671: the playbook pin and the launch deck travel as headers in
      // the worker home's per-run MCP entry (see profileEnforcement/start),
      // so pinned and session-deck runs are supported — no rejection here.
      // --trust is passed on every launch, so every cursor run records the
      // workspace-trust grant.
      return { ok: true, trustOverride: true };
    },

    profileEnforcement(args: AdapterStartArgs) {
      // 1. The installed build must list every enforcement flag.
      if (!cursorEnforcementFlagsSupported(probe, bin)) {
        return {
          ok: false,
          remedy:
            `cursor-agent enforcement unavailable (tried "${bin}"): this build does not list --sandbox, --approve-mcps, and --plan/--mode ` +
            `in \`cursor-agent --help\` (verified on ${CURSOR_ENFORCEMENT_VERSION_NOTE}). Upgrade cursor-agent, then retry. ` +
            `Refusing to run --tools ${args.tools} without an enforceable sandbox and MCP preapproval; no process was started.`,
        };
      }
      // 2. MCP preapproval must isolate to the run entry: a project config
      // contributing any foreign server would be approved too. The real
      // home's own config is excluded — the worker home shadows it.
      const foreign = findCursorForeignProjectServers(args.cwd, readFile, homedir());
      if (foreign.length > 0) {
        const first = foreign[0];
        return {
          ok: false,
          remedy:
            `cursor-agent MCP isolation unavailable: ${first.configPath} defines MCP server "${first.server}" outside the run entry, ` +
            'and --approve-mcps would approve it too. Remove the foreign server from the project MCP config (or run in a folder without one), ' +
            'then retry; no process was started.',
        };
      }
      // 3. The worker-home overlay must build on this host (a dry run with a
      // tokenless entry — the token is minted after the gate). Symlink
      // creation fails on hosts without the privilege (Windows without
      // developer mode), which rejects here instead of spawning unenforced.
      let dryRunHome: string | null = null;
      try {
        dryRunHome = makeWorkerHome();
        setupCursorWorkerHome({
          workerHome: dryRunHome,
          realHome: homedir(),
          mcpDocument: buildCursorWorkerMcpDocument(
            buildCursorWorkerMcpEntry({ workspaceRoot: args.cwd }),
          ),
        });
      } catch (error) {
        return {
          ok: false,
          remedy:
            `cursor-agent worker config isolation unavailable: ${error instanceof Error ? error.message : String(error)} ` +
            'No process was started.',
        };
      } finally {
        if (dryRunHome) {
          cleanupCursorWorkerHome(dryRunHome);
        }
      }
      return { ok: true };
    },

    async *start(args: AdapterStartArgs): AsyncGenerator<NormalizedEvent> {
      const argv = buildCursorArgv({
        prompt: args.prompt,
        tools: args.tools,
        ...(args.resumeId !== undefined ? { resumeId: args.resumeId } : {}),
      });
      // Authenticated worker MCP only: without the run token the worker
      // session could not bind its profile server-side.
      if (!args.runToken) {
        throw new Error(
          'Cannot start a cursor worker run without a worker token: the run service always provides one; direct adapter use must pass AdapterStartArgs.runToken.',
        );
      }
      const wrapSpawnError = (error: unknown): Error =>
        new Error(
          `cursor-agent run failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
        );
      // Per-run worker home: the child's HOME, holding only the run's MCP
      // entry (the profile gate already proved the overlay builds here).
      let workerHome: string | null = null;
      try {
        workerHome = makeWorkerHome();
        setupCursorWorkerHome({
          workerHome,
          realHome: homedir(),
          mcpDocument: buildCursorWorkerMcpDocument(
            buildCursorWorkerMcpEntry({
              workspaceRoot: args.cwd,
              ...(args.playbookPin ? { playbookPin: args.playbookPin } : {}),
              ...(args.launchDeckId ? { launchDeckId: args.launchDeckId } : {}),
              runToken: args.runToken,
            }),
          ),
        });
      } catch (error) {
        if (workerHome) {
          cleanupCursorWorkerHome(workerHome);
        }
        throw wrapSpawnError(error);
      }
      const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: workerHome };
      if (process.platform === 'win32') {
        // Node's homedir() (which cursor-agent uses to locate `.cursor`)
        // reads USERPROFILE on Windows, HOME everywhere else.
        childEnv.USERPROFILE = workerHome;
      }
      try {
        let child: CursorChild;
        try {
          child = spawnFn(bin, argv, {
            cwd: args.cwd,
            ...(args.control ? { control: args.control } : {}),
            env: childEnv,
          });
        } catch (error) {
          throw wrapSpawnError(error);
        }
        const lines: string[] = [];
        try {
          for await (const line of child.stdout) {
            lines.push(line);
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
            `cursor-agent exited with code ${code}${stderrTail ? `: ${stderrTail.slice(0, 300)}` : ''}`,
          );
        }
        // Single-shot json: the whole stdout is one result object, so every
        // event lands here, when the process exits.
        yield* cursorEventsFromOutput(lines.join('\n'), {
          ...(args.resumeId !== undefined ? { resumeId: args.resumeId } : {}),
        });
      } finally {
        cleanupCursorWorkerHome(workerHome);
      }
    },
  };
}
