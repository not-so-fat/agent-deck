/**
 * Worker profiles for headless Agent Deck runs (NOT-669).
 *
 * The single source of truth for the two worker profiles, `readonly` and
 * `edit`, expressed as client-neutral capabilities. Every client adapter
 * maps these onto its own flags (sibling tickets); the MCP server enforces
 * the Agent Deck tool sets server-side for worker sessions.
 *
 * Contents are the Yusuke decision of 2026-11-25: one profile pair mapped
 * consistently onto claude, codex, cursor and muse, and not tightened beyond
 * this — workers on the box do what Yusuke does.
 *
 * Node built-ins and sibling modules only (see the module-boundary test):
 * the header literal below must match `AGENT_DECK_RUN_TOKEN_HEADER`.
 */

export const RUN_TOOL_PROFILES = ['readonly', 'edit'] as const;
export type RunToolsProfile = (typeof RUN_TOOL_PROFILES)[number];

/** Must match `AGENT_DECK_RUN_TOKEN_HEADER`. */
export const RUN_TOKEN_HEADER = 'x-agent-deck-run-token';

/**
 * Agent Deck MCP tools only an agent-admin session may use: the elevation
 * surface itself (`request_admin_elevation`, `exit_admin_mode`) plus the
 * tools gated by `requireMcpAdmin` (deck/card administration). Workers are
 * never elevated, so both profiles deny all of these.
 */
export const WORKER_ADMIN_ONLY_MCP_TOOLS: readonly string[] = [
  'request_admin_elevation',
  'exit_admin_mode',
  'manage_deck_card',
  'list_collection',
  'create_deck',
];

/**
 * Agent Deck MCP tools that mutate deck, card, or service state but are not
 * admin-gated: they answer `DASHBOARD_REQUIRED` to every MCP session, leader
 * or worker. `edit` leaves them to that existing gate; `readonly` denies
 * them up front as `PROFILE_DENIED` with a recorded denial.
 */
export const WORKER_DASHBOARD_ONLY_MUTATING_MCP_TOOLS: readonly string[] = [
  'update_playbook',
  'register_playbook',
  'register_service',
  'update_service',
  'update_service_tool_settings',
];

/**
 * Tools both profiles deny: the admin-only surface, deck switching
 * (including the retired direct-switch alias, which must never move a
 * worker), and `start_run` (workers must not re-delegate).
 */
export const WORKER_SHARED_DENY_MCP_TOOLS: readonly string[] = [
  ...WORKER_ADMIN_ONLY_MCP_TOOLS,
  'switch_deck',
  'switch_bound_deck',
  'start_run',
];

/**
 * Extra tools `readonly` denies on top of the shared set: every mutating
 * Agent Deck tool — `propose_playbook_patch` and the deck/card/service
 * writes (`manage_deck_card` and `create_deck` are already denied as
 * admin-only; the dashboard-only writes are denied here instead of at the
 * dashboard gate so the denial is recorded against the profile).
 */
export const WORKER_READONLY_DENY_MCP_TOOLS: readonly string[] = [
  ...WORKER_SHARED_DENY_MCP_TOOLS,
  'propose_playbook_patch',
  ...WORKER_DASHBOARD_ONLY_MUTATING_MCP_TOOLS,
];

/** `edit` denies exactly the shared set — no more, no less. */
export const WORKER_EDIT_DENY_MCP_TOOLS: readonly string[] = [...WORKER_SHARED_DENY_MCP_TOOLS];

/** Shell capability: read-only commands, or any command. */
export type WorkerShellCapability = 'readonly-commands' | 'any';

/** File-write scope: none, or the run workspace plus the agent user's home. */
export type WorkerFileWriteScope = 'none' | 'workspace-and-agent-home';

/** Network and web capability: reads, or full access. */
export type WorkerNetworkCapability = 'read' | 'full';

/**
 * One worker profile. `gitMutations` covers git commit and push;
 * `hostCliMutations` covers `gh`, `npm`, and `curl` (including `curl` to
 * Agent Dealer at `127.0.0.1:2222`); `monitor` covers Claude `Monitor`.
 * `mcpDenyTools` is the explicit Agent Deck MCP tool deny set and
 * `mcpCallServiceTool` gates `call_service_tool` (`'any'` in `edit`;
 * `'read-only-annotated'` in `readonly`, where only a target service tool
 * annotated `readOnlyHint: true` is allowed).
 */
export type WorkerProfile = {
  readonly profile: RunToolsProfile;
  readonly shell: WorkerShellCapability;
  readonly fileWrites: WorkerFileWriteScope;
  readonly network: WorkerNetworkCapability;
  readonly gitMutations: boolean;
  readonly hostCliMutations: boolean;
  readonly monitor: boolean;
  readonly mcpDenyTools: readonly string[];
  readonly mcpCallServiceTool: 'any' | 'read-only-annotated';
};

export const WORKER_PROFILES: Record<RunToolsProfile, WorkerProfile> = {
  readonly: {
    profile: 'readonly',
    shell: 'readonly-commands',
    fileWrites: 'none',
    network: 'read',
    gitMutations: false,
    hostCliMutations: false,
    monitor: false,
    mcpDenyTools: WORKER_READONLY_DENY_MCP_TOOLS,
    mcpCallServiceTool: 'read-only-annotated',
  },
  edit: {
    profile: 'edit',
    shell: 'any',
    fileWrites: 'workspace-and-agent-home',
    network: 'full',
    gitMutations: true,
    hostCliMutations: true,
    monitor: true,
    mcpDenyTools: WORKER_EDIT_DENY_MCP_TOOLS,
    mcpCallServiceTool: 'any',
  },
};

/** True when `tool` is outside `profile` and must be denied immediately. */
export function isMcpToolDeniedByProfile(profile: RunToolsProfile, tool: string): boolean {
  return WORKER_PROFILES[profile].mcpDenyTools.includes(tool);
}
