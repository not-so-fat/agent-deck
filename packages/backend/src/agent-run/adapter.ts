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
 * thread id) whenever the adapter learns it.
 */
export type NormalizedEvent =
  | { kind: 'text'; text: string; sessionId?: string }
  | { kind: 'tool'; name: string; sessionId?: string }
  | { kind: 'result'; subtype: string; result: unknown; sessionId?: string }
  | { kind: 'notice'; message: string; sessionId?: string };

export type AdapterStartArgs = {
  cwd: string;
  prompt: string;
  tools: RunToolsProfile;
  resumeId?: string;
};

export type AdapterPreflight = { ok: true } | { ok: false; remedy: string };

/**
 * Pure start plan, computed before any model call. `trustOverride` records
 * whether the launch bypasses a client workspace-trust guard (Codex
 * `--skip-git-repo-check`); `{ ok: false }` fails closed with a remedy and
 * the run exits before spawning anything.
 */
export type AdapterStartPlan = { ok: true; trustOverride: boolean } | { ok: false; remedy: string };

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
