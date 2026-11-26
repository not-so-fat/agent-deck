/**
 * Codex adapter for `agent-deck run` (NOT-404).
 *
 * Drives `codex exec --json` (start) and `codex exec resume` (resume) as a
 * child process and maps the JSONL stream onto normalized events. Verified
 * against codex-cli 0.157.1 (`codex exec --help`, `codex exec resume --help`,
 * `codex login status`); worker-profile enforcement (NOT-672) verified
 * against codex-cli 0.169.0 (`-c` config overrides, `mcp get` rendering of
 * the per-run MCP table, rollout `turn_context` policy records):
 *
 * - Start accepts `-s read-only|workspace-write`; resume accepts NO `-s`
 *   flag (neither does `fork`): the thread keeps the sandbox it started
 *   with. So planStart allows a resume only with trusted provenance — the
 *   Agent Deck run that started the thread, resolved by the run service
 *   (`provenance.ts`, NOT-484) — whose profile equals the requested one.
 *   Edit→edit and readonly→readonly continue; anything else fails closed.
 * - Signed-in preflight is `codex login status` (exit 0 + `Logged in ...`),
 *   which makes no model call.
 * - `--skip-git-repo-check` exists on both start and resume and is passed
 *   only when --cwd is not inside a git work tree (recorded as
 *   `trustOverride: true` in meta.json).
 * - Worker-profile enforcement (NOT-672, `WORKER_PROFILES` in
 *   `profiles.ts`): every start and resume passes
 *   `-c approval_policy="never"` (headless runs never wait on approvals)
 *   and a full per-run `mcp_servers.agent-deck` table carrying the worker
 *   headers, `default_tools_approval_mode="approve"`, and the profile's
 *   explicit `enabled_tools` allow set (unknown names are tolerated, so a
 *   tool the server does not advertise cannot break bootstrap). Edit
 *   additionally passes explicit `-c sandbox_workspace_write.*` overrides
 *   enabling network access and exactly the workspace-plus-agent-home
 *   writable roots; readonly relies on the fixed read-only sandbox. A
 *   resume additionally verifies the thread's recorded effective policy
 *   from its rollout file before trusting it (see
 *   `verifyCodexResumePolicy`); anything unverifiable fails closed.
 *
 * `--dangerously-bypass-approvals-and-sandbox` must never be used: there is
 * no flag, env var, or option that selects it, and tests assert no generated
 * argv ever contains it.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
  defaultWorkerHomeDir,
  formatRunPlaybookPin,
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
  type RunPlaybookPin,
  type RunProcessControl,
  type RunToolsProfile,
} from './adapter';
import { WORKER_PROFILES } from './profiles';

/** Tool-profile mapping: readonly is `-s read-only`, edit is `-s workspace-write`. */
export const CODEX_SANDBOX_FOR_PROFILE: Record<RunToolsProfile, 'read-only' | 'workspace-write'> = {
  readonly: 'read-only',
  edit: 'workspace-write',
};

export const CODEX_JSONL_VERSION_NOTE = 'codex-cli 0.157.1';

/** Worker-profile enforcement keys verified against this codex release (NOT-672). */
export const CODEX_ENFORCEMENT_VERSION_NOTE = 'codex-cli 0.169.0';

/** Minimum codex release whose enforcement surface is verified (NOT-672). */
export const CODEX_MIN_ENFORCEMENT_VERSION: readonly [number, number, number] = [0, 169, 0];

/** Headless worker runs never prompt: approvals are never requested (NOT-672). */
export const CODEX_APPROVAL_POLICY = 'never';

export function resolveCodexBin(): string {
  return process.env.CODEX_BIN?.trim() || 'codex';
}

/** Where codex keeps config, auth, and session rollouts. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(defaultWorkerHomeDir(), '.codex');
}

export type CodexArgvArgs = {
  prompt: string;
  tools: RunToolsProfile;
  resumeId?: string;
  insideGitRepo: boolean;
  /** Pinned playbook version, carried as a `-c` MCP override (NOT-537). */
  playbookPin?: RunPlaybookPin;
  /**
   * Run working directory. Always required: the per-run MCP override
   * (NOT-566) names it in the workspace header so the daemon can resolve
   * the folder assignment — there is no launcher to read it — and the edit
   * sandbox override names it as a writable root (NOT-672).
   */
  workspaceRoot: string;
  /**
   * Agent user's home directory. Required for edit runs: the edit sandbox
   * override names it as a writable root alongside the workspace
   * (NOT-672); ignored for readonly runs.
   */
  homeDir?: string;
  /** Launch deck header for the run's MCP session (see `AdapterStartArgs.launchDeckId`). */
  launchDeckId?: string;
  /** Worker token header for the run's MCP session (NOT-669; see `AdapterStartArgs.runToken`). */
  runToken?: string;
};

/** Escape one TOML basic-string value (the pin is `id=uuid`; belt and suspenders). */
export function tomlEscape(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/** One TOML inline string array (`["a","b"]`), values escaped. */
export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => `"${tomlEscape(value)}"`).join(',')}]`;
}

/**
 * Parse `codex --version` output (`codex-cli 0.169.0`) into a version tuple.
 * Null when no triple is found — unparseable means unverifiable, which
 * fails closed in `profileEnforcement`.
 */
export function parseCodexVersion(output: string): readonly [number, number, number] | null {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `version` is at least `CODEX_MIN_ENFORCEMENT_VERSION`. */
export function codexVersionSupportsEnforcement(version: readonly [number, number, number]): boolean {
  const [major, minor, patch] = version;
  const [wantMajor, wantMinor, wantPatch] = CODEX_MIN_ENFORCEMENT_VERSION;
  if (major !== wantMajor) {
    return major > wantMajor;
  }
  if (minor !== wantMinor) {
    return minor > wantMinor;
  }
  return patch >= wantPatch;
}

/**
 * MCP endpoint the pin override preserves. Codex starts MCP servers with a
 * restricted env, so the override must repeat the endpoint explicitly.
 * Malformed values fall back to the defaults rather than breaking a pinned
 * run.
 */
export function codexPinEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): { port: string; host: string } {
  const port = env.AGENT_DECK_MCP_PORT?.trim() ?? '';
  const host = env.AGENT_DECK_HOST?.trim() ?? '';
  return {
    port: /^\d{1,5}$/.test(port) && Number(port) >= 1 && Number(port) <= 65535 ? port : '1110',
    host: host ? host : '127.0.0.1',
  };
}

/**
 * Header names the pin override sends. Literals (not `@agent-deck/shared` —
 * this module imports node built-ins and siblings only, NOT-479); they must
 * match `AGENT_DECK_WORKSPACE_HEADER` / `AGENT_DECK_PLAYBOOK_PIN_HEADER`.
 */
export const CODEX_PIN_WORKSPACE_HEADER = 'x-agent-deck-workspace';
export const CODEX_PIN_PLAYBOOK_PIN_HEADER = 'x-agent-deck-playbook-pin';
/** Must match `AGENT_DECK_DECK_ID_HEADER`. */
export const CODEX_LAUNCH_DECK_HEADER = 'x-agent-deck-deck-id';
/** Must match `AGENT_DECK_RUN_TOKEN_HEADER`. */
export const CODEX_RUN_TOKEN_HEADER = 'x-agent-deck-run-token';

/**
 * The `-c` override value carrying the run's playbook pin (NOT-537). A full
 * `mcp_servers.agent-deck` definition in pure-HTTP form (NOT-566): the
 * daemon resolves the deck from the folder assignment named by the workspace
 * header (NOT-562) and reads the pin header for the playbook version — no
 * launcher process is involved. A full definition because partial overrides
 * fail codex bootstrap with "invalid transport" (verified on codex-cli
 * 0.157.1).
 */
export function buildCodexPinConfigOverride(
  pin: RunPlaybookPin,
  workspaceRoot: string,
  endpoint: { port: string; host: string } = codexPinEndpoint(),
): string {
  return buildCodexMcpConfigOverride({ workspaceRoot, tools: 'readonly', playbookPin: pin }, endpoint);
}

/**
 * Agent Deck MCP tools the worker may call under `profile` (NOT-672): the
 * shared profile allow set, passed as the per-run table's `enabled_tools`
 * so the model only sees what the profile permits. The MCP server still
 * enforces the same set call-by-call (NOT-669) — the table is the
 * client-side half, the server the authoritative half.
 */
export function codexEnabledMcpTools(profile: RunToolsProfile): readonly string[] {
  return WORKER_PROFILES[profile].mcpAllowTools;
}

/**
 * The run's `mcp_servers.agent-deck` override: the workspace header, plus
 * the playbook pin, the launch deck header, and/or the worker token header
 * when the run has them. The launch deck header makes the daemon bind the
 * run's deck directly instead of re-resolving it from the folder assignment
 * or the user default; the worker token header binds the MCP session to the
 * run's effective worker profile (NOT-669).
 *
 * NOT-672: the table also carries `default_tools_approval_mode="approve"`
 * (worker MCP calls never wait on approvals), the profile's explicit
 * `enabled_tools` allow set, and a per-tool `approval_mode="approve"` entry
 * for each allowed tool. Verified against codex-cli 0.169.0
 * (`codex mcp get` renders the table; unknown `enabled_tools` names are
 * tolerated, so a tool the server does not advertise cannot break
 * bootstrap).
 */
export function buildCodexMcpConfigOverride(
  input: {
    workspaceRoot: string;
    tools: RunToolsProfile;
    playbookPin?: RunPlaybookPin;
    launchDeckId?: string;
    runToken?: string;
  },
  endpoint: { port: string; host: string } = codexPinEndpoint(),
): string {
  const headers = [
    `"${CODEX_PIN_WORKSPACE_HEADER}"="${tomlEscape(input.workspaceRoot)}"`,
    ...(input.playbookPin
      ? [`"${CODEX_PIN_PLAYBOOK_PIN_HEADER}"="${tomlEscape(formatRunPlaybookPin(input.playbookPin))}"`]
      : []),
    ...(input.launchDeckId
      ? [`"${CODEX_LAUNCH_DECK_HEADER}"="${tomlEscape(input.launchDeckId)}"`]
      : []),
    ...(input.runToken
      ? [`"${CODEX_RUN_TOKEN_HEADER}"="${tomlEscape(input.runToken)}"`]
      : []),
  ].join(',');
  const enabled = codexEnabledMcpTools(input.tools);
  const toolApprovals = enabled.map((tool) => `"${tomlEscape(tool)}"={approval_mode="approve"}`).join(',');
  return (
    `mcp_servers.agent-deck={url="http://${tomlEscape(endpoint.host)}:${tomlEscape(endpoint.port)}/mcp",` +
    `http_headers={${headers}},` +
    `default_tools_approval_mode="approve",` +
    `enabled_tools=${tomlStringArray(enabled)},` +
    `tools={${toolApprovals}}}`
  );
}

/** `-c approval_policy="never"`: headless runs never wait on approvals (NOT-672). */
export function buildCodexApprovalPolicyOverride(): string {
  return `approval_policy="${CODEX_APPROVAL_POLICY}"`;
}

/**
 * Edit sandbox overrides (NOT-672): explicit network access and exactly the
 * workspace-plus-agent-home writable roots. Passed as `-c` pairs (flag and
 * value interleaved) on edit starts and resumes; readonly runs pass none
 * (the read-only sandbox is fixed — there is no `sandbox_read_only`
 * override table, and codex ignores one).
 */
export function buildCodexEditSandboxOverrides(workspaceRoot: string, homeDir: string): string[] {
  return [
    '-c',
    'sandbox_workspace_write.network_access=true',
    '-c',
    `sandbox_workspace_write.writable_roots=${tomlStringArray([workspaceRoot, homeDir])}`,
  ];
}

/**
 * Resume ids are codex thread ids (UUIDs); a leading `-` is never legitimate
 * and would be parsed as a resume option (resume accepts
 * `--dangerously-bypass-approvals-and-sandbox`, `-c`, ...), so it fails
 * closed in planStart and throws here. Belt and suspenders with the `--`
 * placement below: this builder never emits a dash-leading id at all.
 */
export function assertSafeResumeId(resumeId: string): void {
  if (resumeId.startsWith('-')) {
    throw new Error(
      `Invalid --resume id ${JSON.stringify(resumeId)}: session ids never start with '-'. ` +
        'Pass the thread id printed as sessionId in a previous run log.',
    );
  }
}

/**
 * Pure argv builder (everything after the `codex` binary). Start:
 * `exec -c <mcp> -c <approval> [-c <sandbox> -c <sandbox>] --json
 * [--skip-git-repo-check] -s <mode> -- <prompt>`; resume:
 * `exec resume -c <mcp> -c <approval> [-c <sandbox> -c <sandbox>] --json
 * [--skip-git-repo-check] -- <thread> <prompt>`
 * (`codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` takes both positionals
 * after `--`; verified `--help` after `--` is treated as a positional, not
 * the help flag, on codex-cli 0.157.1; `-c` accepted by both `exec` and
 * `exec resume` on codex-cli 0.169.0).
 * Resume takes no `-s`: the thread keeps its original sandbox.
 * The `--` terminator keeps dash-leading prompts (markdown bullets, YAML
 * frontmatter, or a literal `--dangerously-...` string) from being parsed
 * as codex options.
 * Every run passes the full `-c mcp_servers.agent-deck` table (a process
 * env var would never arrive — restricted MCP env): the workspace header
 * (pure HTTP, NOT-566 — without it the daemon cannot resolve the folder
 * assignment), the pin/deck/token headers when the run carries them, and
 * the NOT-672 enforcement half (`default_tools_approval_mode`,
 * `enabled_tools`, per-tool approvals). Every run also passes
 * `-c approval_policy="never"`; edit runs additionally pass the explicit
 * `-c sandbox_workspace_write.*` overrides. An edit run without `homeDir`
 * fails closed: the writable-roots override cannot be built.
 */
export function buildCodexArgv(args: CodexArgvArgs): string[] {
  const argv = ['exec'];
  const resuming = args.resumeId !== undefined;
  if (resuming) {
    assertSafeResumeId(args.resumeId as string);
    argv.push('resume');
  }
  if (!args.workspaceRoot) {
    throw new Error(
      'Cannot build a codex run without workspaceRoot: the per-run MCP override ' +
        'needs the run directory for the x-agent-deck-workspace header.',
    );
  }
  argv.push(
    '-c',
    buildCodexMcpConfigOverride({
      workspaceRoot: args.workspaceRoot,
      tools: args.tools,
      ...(args.playbookPin ? { playbookPin: args.playbookPin } : {}),
      ...(args.launchDeckId ? { launchDeckId: args.launchDeckId } : {}),
      ...(args.runToken ? { runToken: args.runToken } : {}),
    }),
    '-c',
    buildCodexApprovalPolicyOverride(),
  );
  if (args.tools === 'edit') {
    if (!args.homeDir) {
      throw new Error(
        'Cannot build an edit codex run without homeDir: the writable-roots override ' +
          'needs the agent home directory alongside the workspace.',
      );
    }
    argv.push(...buildCodexEditSandboxOverrides(args.workspaceRoot, args.homeDir));
  }
  argv.push('--json');
  if (!args.insideGitRepo) {
    argv.push('--skip-git-repo-check');
  }
  if (!resuming) {
    argv.push('-s', CODEX_SANDBOX_FOR_PROFILE[args.tools]);
  }
  argv.push('--');
  if (resuming) {
    argv.push(args.resumeId as string);
  }
  argv.push(args.prompt);
  return argv;
}

export function defaultIsGitRepo(cwd: string): boolean {
  try {
    const probed = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return probed.status === 0 && (probed.stdout ?? '').trim() === 'true';
  } catch {
    return false;
  }
}

export type CodexProbeResult = { code: number; stdout: string; stderr: string };
export type CodexProbe = (bin: string, argv: string[]) => CodexProbeResult;

export function defaultCodexProbe(bin: string, argv: string[]): CodexProbeResult {
  try {
    const probed = spawnSync(bin, argv, { encoding: 'utf8', timeout: 15000 });
    return { code: probed.status ?? 1, stdout: probed.stdout ?? '', stderr: probed.stderr ?? '' };
  } catch {
    return { code: 127, stdout: '', stderr: '' };
  }
}

export type CodexChild = {
  /** Stdout split into lines (without line terminators). */
  stdout: AsyncIterable<string>;
  wait: () => Promise<{ code: number | null; stderrTail: string }>;
};

/** `control` (NOT-481): spawn as a new process-group leader and report its id. */
export type CodexSpawnOptions = { cwd: string; control?: RunProcessControl; env?: NodeJS.ProcessEnv };

export type CodexSpawn = (bin: string, argv: string[], opts: CodexSpawnOptions) => CodexChild;

export function defaultCodexSpawn(bin: string, argv: string[], opts: CodexSpawnOptions): CodexChild {
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

export type CodexLineContext = {
  threadId: string | null;
  /**
   * Text of the latest `agent_message` in the current turn. Codex emits
   * commentary and the final answer as the same item type, so the last one
   * before `turn.completed` is the final answer.
   */
  lastAgentMessage?: string | null;
};

export const CODEX_NO_FINAL_MESSAGE =
  'codex turn completed without a final assistant message: re-run the prompt, or read the text and tool lines above for what the session did.';

function withSession<T extends object>(event: T, ctx: CodexLineContext): T & { sessionId?: string } {
  return ctx.threadId ? { ...event, sessionId: ctx.threadId } : event;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Map one `codex exec --json` stdout line onto normalized events:
 * `thread.started.thread_id` becomes the session id (no log line);
 * `agent_message` items become `text`; command/tool items become `tool`;
 * `turn.completed` becomes `result` (subtype `success`) whose `result` is the
 * last `agent_message` text of the turn and whose `usage` is the codex usage
 * object. A turn that completes with no agent message becomes a `failed`
 * result, never an empty success. Provider `error`
 * events become `notice` (non-fatal). Unknown kinds are ignored so a newer
 * CLI cannot break the log. Never throws: unparseable lines become `notice`.
 */
export function codexEventsFromLine(line: string, ctx: CodexLineContext): NormalizedEvent[] {
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
        { kind: 'notice', message: `unparseable codex output: ${trimmed.slice(0, 300)}` },
        ctx,
      ),
    ];
  }
  const record = asRecord(event);
  if (!record) {
    return [];
  }

  switch (record.type) {
    case 'thread.started': {
      const threadId = nonEmptyString(record.thread_id);
      if (threadId) {
        ctx.threadId = threadId;
      }
      return [];
    }
    case 'item.completed': {
      const item = asRecord(record.item);
      if (!item) {
        return [];
      }
      if (item.type === 'agent_message') {
        const text = nonEmptyString(item.text) ?? nonEmptyString(item.content);
        if (!text) {
          return [];
        }
        ctx.lastAgentMessage = text;
        return [withSession({ kind: 'text', text }, ctx)];
      }
      if (item.type === 'reasoning') {
        return [];
      }
      const name =
        nonEmptyString(item.name) ??
        (nonEmptyString(item.command) ? `command:${item.command as string}`.slice(0, 200) : null) ??
        nonEmptyString(item.type) ??
        'item';
      return [withSession({ kind: 'tool', name }, ctx)];
    }
    case 'turn.started': {
      ctx.lastAgentMessage = null;
      return [];
    }
    case 'turn.completed': {
      const finalText = ctx.lastAgentMessage ?? null;
      ctx.lastAgentMessage = null;
      const usage = record.usage === undefined ? {} : { usage: record.usage };
      if (!finalText) {
        return [
          withSession({ kind: 'result', subtype: 'failed', result: CODEX_NO_FINAL_MESSAGE, ...usage }, ctx),
        ];
      }
      return [withSession({ kind: 'result', subtype: 'success', result: finalText, ...usage }, ctx)];
    }
    case 'turn.failed': {
      const detail = record.error ?? record.usage ?? null;
      return [withSession({ kind: 'result', subtype: 'failed', result: detail }, ctx)];
    }
    case 'error': {
      const message =
        nonEmptyString(record.message) ?? `codex error: ${trimmed.slice(0, 300)}`;
      return [withSession({ kind: 'notice', message: message.slice(0, 500) }, ctx)];
    }
    default:
      // Future kinds carry nothing the log needs.
      return [];
  }
}

export function codexTrustOverride(cwd: string, isGitRepo: (cwd: string) => boolean): boolean {
  try {
    return !isGitRepo(cwd);
  } catch {
    return true;
  }
}

/**
 * A thread's recorded effective policy: one `turn_context` payload from its
 * rollout file (codex-cli 0.169.0). `codex exec resume` accepts no `-s`
 * flag, so the thread keeps whatever sandbox it started with — the resume
 * gate verifies the recording instead of trusting the thread.
 */
export type CodexRecordedPolicy = {
  approvalPolicy: unknown;
  sandboxType: unknown;
  networkAccess: unknown;
  writableRoots: unknown;
};

export type CodexResumePolicyCheck = {
  /** `$CODEX_HOME` (or `~/.codex`): rollouts live under `<codexHome>/sessions/`. */
  codexHome: string;
  /** The thread id being resumed. */
  threadId: string;
  /** The requested worker profile, which the recording must satisfy. */
  tools: RunToolsProfile;
  /** The resume's working directory: an edit thread must cover it for writes. */
  cwd: string;
  /** The agent user's home: an edit thread must cover it for writes. */
  homeDir: string;
};

/**
 * Rollout files that may record `threadId`: `<codexHome>/sessions/**` files
 * named `rollout-*-<threadId>.jsonl`. Content is verified separately
 * (`readCodexTurnPolicies` matches the recorded session id); a filename
 * alone proves nothing. Unreadable directories contribute nothing — a
 * missing recording fails closed in `verifyCodexResumePolicy`.
 */
export function findCodexRollouts(codexHome: string, threadId: string): string[] {
  const suffix = `-${threadId}.jsonl`;
  const found: string[] = [];
  const queue: string[] = [path.join(codexHome, 'sessions')];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const dir = queue.pop() as string;
    if (seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
        found.push(full);
      }
    }
  }
  return found.sort();
}

/**
 * The recorded effective policies in one rollout file: every `turn_context`
 * payload. Returns null when the file does not prove it records `threadId`
 * (no `session_meta` naming it) or cannot be read — the caller treats that
 * file as no provenance. Unparseable lines are skipped: a corrupt line must
 * not invalidate the policies the intact lines record.
 */
export function readCodexTurnPolicies(
  rolloutPath: string,
  threadId: string,
): CodexRecordedPolicy[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(rolloutPath, 'utf8');
  } catch {
    return null;
  }
  let provesThread = false;
  const policies: CodexRecordedPolicy[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    const payload = record ? asRecord(record.payload) : null;
    if (!record || !payload) {
      continue;
    }
    if (record.type === 'session_meta') {
      if (payload.session_id === threadId || payload.id === threadId) {
        provesThread = true;
      }
      continue;
    }
    if (record.type === 'turn_context') {
      const sandbox = asRecord(payload.sandbox_policy);
      policies.push({
        approvalPolicy: payload.approval_policy,
        sandboxType: sandbox?.type,
        networkAccess: sandbox?.network_access,
        writableRoots: sandbox?.writable_roots,
      });
    }
  }
  return provesThread ? policies : null;
}

/** Realpath when it resolves, else the path as given. */
function resolveForPolicyCover(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * True when `roots` covers `dir` for writes: one entry equals it or is a
 * parent of it (compared after realpath, so a symlinked cwd still matches
 * the recorded canonical root).
 */
export function codexWritableRootsCover(roots: readonly string[], dir: string): boolean {
  const target = resolveForPolicyCover(dir);
  return roots.some((root) => {
    if (typeof root !== 'string' || !root) {
      return false;
    }
    const resolved = resolveForPolicyCover(root);
    return target === resolved || target.startsWith(`${resolved}${path.sep}`);
  });
}

/**
 * Verify the thread's recorded effective policy satisfies `check.tools`
 * (NOT-672): readonly needs `approval_policy: "never"` and a `read-only`
 * sandbox on every recorded turn; edit needs `approval_policy: "never"`,
 * a `workspace-write` sandbox with network access, and writable roots
 * covering both the resume cwd and the agent home on every recorded turn.
 * Missing rollouts, unproven threads, turns without a policy record, and
 * any incompatible turn all fail closed — the thread is never trusted.
 */
export function verifyCodexResumePolicy(
  check: CodexResumePolicyCheck,
): { ok: true } | { ok: false; remedy: string } {
  const missingRemedy =
    `Cannot resume codex thread ${check.threadId}: its effective sandbox cannot be verified ` +
    `(no codex rollout under ${path.join(check.codexHome, 'sessions')} proves it started with ` +
    `--tools ${check.tools}). Resume only a thread this host's codex started through \`agent-deck run\`, or start a new run.`;
  let rollouts: string[];
  try {
    rollouts = findCodexRollouts(check.codexHome, check.threadId);
  } catch {
    rollouts = [];
  }
  if (rollouts.length === 0) {
    return { ok: false, remedy: missingRemedy };
  }
  const policies: CodexRecordedPolicy[] = [];
  for (const rollout of rollouts) {
    const parsed = readCodexTurnPolicies(rollout, check.threadId);
    if (parsed) {
      policies.push(...parsed);
    }
  }
  if (policies.length === 0) {
    return { ok: false, remedy: missingRemedy };
  }
  const want =
    check.tools === 'edit'
      ? 'approval never, workspace-write sandbox, network access, and writable roots covering the workspace and the agent home'
      : 'approval never and a read-only sandbox';
  for (const policy of policies) {
    const reasons: string[] = [];
    if (policy.approvalPolicy !== CODEX_APPROVAL_POLICY) {
      reasons.push(`approval_policy ${JSON.stringify(policy.approvalPolicy)} (want ${JSON.stringify(CODEX_APPROVAL_POLICY)})`);
    }
    if (check.tools === 'readonly') {
      if (policy.sandboxType !== CODEX_SANDBOX_FOR_PROFILE.readonly) {
        reasons.push(`sandbox ${JSON.stringify(policy.sandboxType)} (want "read-only")`);
      }
    } else {
      if (policy.sandboxType !== CODEX_SANDBOX_FOR_PROFILE.edit) {
        reasons.push(`sandbox ${JSON.stringify(policy.sandboxType)} (want "workspace-write")`);
      }
      if (policy.networkAccess !== true) {
        reasons.push(`network_access ${JSON.stringify(policy.networkAccess)} (want true)`);
      }
      const roots = policy.writableRoots;
      if (!Array.isArray(roots)) {
        reasons.push(`writable_roots ${JSON.stringify(roots)} (want workspace and agent-home coverage)`);
      } else {
        const strings = roots.filter((entry): entry is string => typeof entry === 'string');
        if (!codexWritableRootsCover(strings, check.cwd)) {
          reasons.push(`writable_roots ${JSON.stringify(roots)} (missing the workspace ${check.cwd})`);
        }
        if (!codexWritableRootsCover(strings, check.homeDir)) {
          reasons.push(`writable_roots ${JSON.stringify(roots)} (missing the agent home ${check.homeDir})`);
        }
      }
    }
    if (reasons.length > 0) {
      return {
        ok: false,
        remedy:
          `Cannot resume codex thread ${check.threadId} with --tools ${check.tools}: its recorded effective policy ` +
          `does not satisfy the profile (want ${want}): ${reasons.join('; ')}. ` +
          `Resume it with the profile it started with, or start a new run with --tools ${check.tools}.`,
      };
    }
  }
  return { ok: true };
}

export type CodexAdapterDeps = {
  bin?: string;
  probe?: CodexProbe;
  spawn?: CodexSpawn;
  isGitRepo?: (cwd: string) => boolean;
  /** Codex home for rollout verification; defaults to `resolveCodexHome()`. */
  codexHome?: string;
  /** Agent user's home for the edit writable-roots override; defaults to `os.homedir()`. */
  homeDir?: string;
};

export function createCodexAdapter(deps: CodexAdapterDeps = {}): ClientAdapter {
  const bin = deps.bin ?? resolveCodexBin();
  const probe = deps.probe ?? defaultCodexProbe;
  const spawnFn = deps.spawn ?? defaultCodexSpawn;
  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;
  const codexHome = deps.codexHome ?? resolveCodexHome();
  const homeDir = deps.homeDir ?? defaultWorkerHomeDir();

  return {
    id: 'codex',

    async preflight() {
      const version = probe(bin, ['--version']);
      if (version.code !== 0) {
        return {
          ok: false,
          remedy:
            `codex CLI not found (tried "${bin}"): install codex-cli 0.157+ and ensure 'codex' is on PATH (or set CODEX_BIN=/path/to/codex), then retry.`,
        };
      }
      const login = probe(bin, ['login', 'status']);
      // `login status` reports on stderr ("Logged in using ChatGPT" on 0.157.1),
      // so both streams count; the anchored match rejects "Not logged in".
      const loginText = `${login.stdout}\n${login.stderr}`;
      if (login.code !== 0 || !/^\s*logged in/im.test(loginText)) {
        return {
          ok: false,
          remedy: 'codex is not signed in: run `codex login`, then retry.',
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
            'Pass the thread id printed as sessionId in a previous run log.',
        };
      }
      if (args.resumeId !== undefined) {
        const origin = args.resumedFrom;
        if (!origin || origin.sessionId !== args.resumeId) {
          return {
            ok: false,
            remedy:
              `Cannot resume codex thread ${args.resumeId}: no trusted Agent Deck run is known to have started it, ` +
              "and 'codex exec resume' accepts no sandbox flag. Resume a sessionId printed by `agent-deck run`, or start a new run.",
          };
        }
        if (origin.tools !== args.tools) {
          return {
            ok: false,
            remedy:
              `Cannot resume codex thread ${args.resumeId} with --tools ${args.tools}: run ${origin.runId} started it with ` +
              `--tools ${origin.tools}, and 'codex exec resume' accepts no sandbox flag. Resume with --tools ${origin.tools}, or start a new run.`,
          };
        }
      }
      return { ok: true, trustOverride: codexTrustOverride(args.cwd, isGitRepo) };
    },

    profileEnforcement(args: AdapterStartArgs) {
      // NOT-672: the enforcement surface (`-c approval_policy`, the MCP
      // table's approval/enabled-tools keys, the edit sandbox overrides,
      // rollout `turn_context` records) is verified against
      // CODEX_MIN_ENFORCEMENT_VERSION. Older or unparseable versions fail
      // closed: an ignored `-c` key would silently drop enforcement.
      const version = probe(bin, ['--version']);
      const parsed =
        version.code === 0 ? parseCodexVersion(`${version.stdout}\n${version.stderr}`) : null;
      if (!parsed || !codexVersionSupportsEnforcement(parsed)) {
        const [wantMajor, wantMinor, wantPatch] = CODEX_MIN_ENFORCEMENT_VERSION;
        const found = parsed ? parsed.join('.') : 'unknown';
        return {
          ok: false,
          remedy:
            `codex ${wantMajor}.${wantMinor}.${wantPatch}+ is required for worker profile enforcement ` +
            `(found ${found}): upgrade codex (it auto-updates; \`codex --version\` shows the release), then retry. ` +
            'Refusing to start a run whose sandbox and approval policy cannot be proven.',
        };
      }
      if (args.resumeId === undefined) {
        return { ok: true };
      }
      // Defense in depth behind planStart: no resume without trusted
      // same-profile provenance, and no trust without the thread's own
      // recorded effective policy.
      const origin = args.resumedFrom;
      if (!origin || origin.sessionId !== args.resumeId || origin.tools !== args.tools) {
        return {
          ok: false,
          remedy:
            `Cannot resume codex thread ${args.resumeId}: no trusted Agent Deck run is known to have started it with ` +
            `--tools ${args.tools}. Resume a sessionId printed by \`agent-deck run\`, or start a new run.`,
        };
      }
      return verifyCodexResumePolicy({
        codexHome,
        threadId: args.resumeId,
        tools: args.tools,
        cwd: args.cwd,
        homeDir,
      });
    },

    async *start(args: AdapterStartArgs): AsyncGenerator<NormalizedEvent> {
      const insideGitRepo = !codexTrustOverride(args.cwd, isGitRepo);
      const argv = buildCodexArgv({
        prompt: args.prompt,
        tools: args.tools,
        ...(args.resumeId !== undefined ? { resumeId: args.resumeId } : {}),
        insideGitRepo,
        workspaceRoot: args.cwd,
        ...(args.tools === 'edit' ? { homeDir } : {}),
        ...(args.playbookPin ? { playbookPin: args.playbookPin } : {}),
        ...(args.launchDeckId ? { launchDeckId: args.launchDeckId } : {}),
        ...(args.runToken ? { runToken: args.runToken } : {}),
      });
      // planStart rejects a resume without a matching resumedFrom.
      if (args.resumeId !== undefined && args.resumedFrom) {
        yield {
          kind: 'notice',
          message:
            `Resuming codex thread ${args.resumeId} started by run ${args.resumedFrom.runId}: the thread keeps its original sandbox ` +
            `(--tools ${args.resumedFrom.tools}, ${CODEX_SANDBOX_FOR_PROFILE[args.resumedFrom.tools]}).`,
          sessionId: args.resumeId,
        };
      }
      const wrapSpawnError = (error: unknown): Error =>
        new Error(
          `codex run failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
        );
      let child: CodexChild;
      try {
        // No pin env on the child: the `-c` argv override above is the only
        // carrier (Codex MCP servers never see inherited env).
        child = spawnFn(bin, argv, {
          cwd: args.cwd,
          ...(args.control ? { control: args.control } : {}),
        });
      } catch (error) {
        throw wrapSpawnError(error);
      }
      const ctx: CodexLineContext = { threadId: args.resumeId ?? null };
      try {
        for await (const line of child.stdout) {
          for (const event of codexEventsFromLine(line, ctx)) {
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
          `codex exited with code ${code}${stderrTail ? `: ${stderrTail.slice(0, 300)}` : ''}`,
        );
      }
    },
  };
}
