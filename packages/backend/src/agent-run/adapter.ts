/**
 * Client adapters for the host-local agent run service (NOT-404, NOT-479).
 *
 * All client-specific launching lives behind {@link ClientAdapter}; the run,
 * log, and status code only sees normalized events. New clients plug in by
 * adding an adapter plus a registry entry in `service.ts` — the run record
 * and status paths need no changes.
 *
 * Tool profiles (`readonly`/`edit`) and meta.json stay owned by the shared run
 * service: adapters receive the profile name and map it to client flags.
 */
import type { RunResumeOrigin } from './records';

/** Read-only profile: exactly the botmancers prototype allowlist. */
export const RUN_READONLY_TOOLS: readonly string[] = [
  'mcp__agent-deck__*',
  'Read',
  'Glob',
  'Grep',
  'Bash(git log:*)',
  'Bash(git status:*)',
  'Bash(ls:*)',
];

/**
 * Edit profile: readonly plus file writes and git-scoped Bash. No `git push`,
 * no unscoped `Bash`, no network tools. One-line reason per git entry:
 * - `git diff` reviews local changes before staging or committing;
 * - `git add` stages the files the session created or edited;
 * - `git commit` records the work as a commit for handoff;
 * - `git checkout -b` starts delegated work on a fresh branch.
 */
export const RUN_EDIT_TOOLS: readonly string[] = [
  ...RUN_READONLY_TOOLS,
  'Edit',
  'Write',
  'Bash(git diff:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git checkout -b:*)',
];

/** Both profiles run with `acceptEdits`; `bypassPermissions` is never used. */
export const RUN_PERMISSION_MODE = 'acceptEdits';

/** Setting sources copied from the prototype. */
export const RUN_SETTING_SOURCES: readonly string[] = ['project', 'user'];

export const RUN_TOOL_PROFILES = ['readonly', 'edit'] as const;
export type RunToolsProfile = (typeof RUN_TOOL_PROFILES)[number];

export function allowedToolsForProfile(profile: RunToolsProfile): readonly string[] {
  return profile === 'edit' ? RUN_EDIT_TOOLS : RUN_READONLY_TOOLS;
}

/** Clients with a working adapter. */
export const RUN_SUPPORTED_CLIENTS = ['claude', 'codex', 'cursor', 'muse'] as const;
export type RunClient = (typeof RUN_SUPPORTED_CLIENTS)[number];

/** Clients with a ticket but no adapter yet (separate tickets, blocked by NOT-404). */
export const RUN_FUTURE_CLIENTS = [] as const;

export function isSupportedRunClient(value: string): value is RunClient {
  return (RUN_SUPPORTED_CLIENTS as readonly string[]).includes(value);
}

export function isFutureRunClient(value: string): boolean {
  return (RUN_FUTURE_CLIENTS as readonly string[]).includes(value);
}

export function missingRunClientMessage(): string {
  return '--client is required: pass --client claude, --client codex, --client cursor, or --client muse';
}

export function runClientMessage(client: string): string {
  if (isFutureRunClient(client)) {
    return `Client adapter "${client}" is not available yet (supported clients: claude, codex, cursor, muse)`;
  }
  return `--client must be one of: claude, codex, cursor, muse (got "${client}")`;
}

/**
 * Normalized session event. Adapters map client-specific streams onto this
 * envelope; only the envelope is shared (text/tool names stay client-native).
 * `sessionId` carries the client session id (Claude session id, Codex
 * thread id) whenever the adapter learns it. A `success` result carries the
 * final assistant answer as a string for claude, codex, and muse; token
 * usage, when the client reports it, travels in `usage`, never in `result`.
 */
export type NormalizedEvent =
  | { kind: 'text'; text: string; sessionId?: string }
  | { kind: 'tool'; name: string; sessionId?: string }
  | { kind: 'result'; subtype: string; result: unknown; usage?: unknown; sessionId?: string }
  | { kind: 'notice'; message: string; sessionId?: string };

/**
 * Which tool profiles a client can enforce on a fresh start and on a resume
 * (NOT-481 capability discovery). Mirrors each adapter's `planStart` gates;
 * `same_profile_provenance` means a resume continues only a session an Agent
 * Deck run on this host started with the same client, deck, cwd, and tools.
 */
export type RunClientProfiles = {
  start: readonly RunToolsProfile[];
  resume: readonly RunToolsProfile[];
  resumeRequires: 'none' | 'same_profile_provenance';
};

export const RUN_CLIENT_PROFILES: Record<RunClient, RunClientProfiles> = {
  claude: { start: RUN_TOOL_PROFILES, resume: RUN_TOOL_PROFILES, resumeRequires: 'none' },
  // `codex exec resume` accepts no sandbox flag, so resume keeps the origin run's sandbox.
  codex: { start: RUN_TOOL_PROFILES, resume: RUN_TOOL_PROFILES, resumeRequires: 'same_profile_provenance' },
  cursor: { start: RUN_TOOL_PROFILES, resume: RUN_TOOL_PROFILES, resumeRequires: 'none' },
  muse: { start: RUN_TOOL_PROFILES, resume: RUN_TOOL_PROFILES, resumeRequires: 'none' },
};

/**
 * Process ownership for one run (NOT-481). When present, an adapter spawns
 * its client as the leader of a new process group and reports the group id,
 * so cancellation can stop the client and everything it started — and
 * nothing else. In-process clients (the Claude SDK) honor `signal` instead.
 * The CLI omits this, so foreground runs keep receiving the terminal's ^C.
 */
export type RunProcessControl = {
  signal: AbortSignal;
  onProcessGroup(pgid: number): void;
};

export type AdapterStartArgs = {
  cwd: string;
  prompt: string;
  tools: RunToolsProfile;
  resumeId?: string;
  /**
   * The trusted run that started `resumeId`, resolved by the run service for
   * clients whose resume cannot re-apply the profile (codex; NOT-484).
   */
  resumedFrom?: RunResumeOrigin;
  control?: RunProcessControl;
  /**
   * Pinned playbook version for this run (NOT-537). Each adapter carries it
   * to its MCP launch through that client's explicit per-server env
   * mechanism — inherited process env never reaches an MCP stdio server
   * (Codex documents a restricted env; the MCP SDK's StdioClientTransport
   * only inherits a safe allowlist plus the configured server `env`). Clients
   * with no per-run override fail closed in `planStart`. The pin lives only
   * as long as the run's MCP session.
   */
  playbookPin?: RunPlaybookPin;
};

export type AdapterPreflight = { ok: true } | { ok: false; remedy: string };

/**
 * Pure start plan, computed before any model call. `trustOverride` records
 * whether the launch bypasses a client workspace-trust guard (Codex
 * `--skip-git-repo-check`); `{ ok: false }` fails closed with a remedy and
 * the run exits before spawning anything.
 */
export type AdapterStartPlan = { ok: true; trustOverride: boolean } | { ok: false; remedy: string };

/**
 * Pinned playbook version for one run (NOT-537). Same shape as the shared
 * `PlaybookPin`, declared here because agent-run imports nothing outside
 * node built-ins and its own modules (see the module-boundary test).
 */
export type RunPlaybookPin = {
  playbookId: string;
  versionId: string;
};

/**
 * Env var the run adapters set in their client's explicit per-server MCP env
 * and `mcp-launch` reads (NOT-537). Never carried by process inheritance:
 * MCP stdio servers start with a restricted env, so an inherited variable
 * would silently never arrive and the run would read the live playbook.
 */
export const PLAYBOOK_PIN_ENV_VAR = 'AGENT_DECK_PLAYBOOK_PIN';

/** Canonical `<playbookId>=<versionId>` form for the pin env value. */
export function formatRunPlaybookPin(pin: RunPlaybookPin): string {
  return `${pin.playbookId}=${pin.versionId}`;
}

export type ClientAdapter = {
  readonly id: RunClient;
  /** Binary/auth checks. Must make no model call and spawn no session. */
  preflight(): Promise<AdapterPreflight>;
  /** Pure per-start plan (sandbox mapping, trust decision, fail-closed gates). */
  planStart(args: AdapterStartArgs): AdapterStartPlan;
  /**
   * Stream normalized events for one session. Rejects (or the iterator
   * throws) when the client process fails, so the shared run code marks the
   * run `error`. A stream that ends without a `result` event is also `error`.
   */
  start(args: AdapterStartArgs): AsyncIterable<NormalizedEvent>;
};
