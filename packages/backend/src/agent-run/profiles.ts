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
 * Enforcement is fail-closed: a tool is denied when it is in the profile's
 * explicit deny set OR when it is not in the profile's explicit allow set,
 * so a newly registered tool is denied until it is classified here. The
 * backend partition test fails when a registered tool is in neither set.
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
 * Deprecated deck-card mutators (legacy profile): compat aliases that link
 * or unlink collection cards on the bound deck — the same operation as the
 * admin-gated `manage_deck_card`. Denied in both profiles like the tool
 * they alias, so a worker never reaches an admin operation through a
 * compat name.
 */
export const WORKER_LEGACY_DECK_CARD_MUTATING_MCP_TOOLS: readonly string[] = [
  'add_service_to_bound_deck',
  'remove_service_from_bound_deck',
  'add_credential_to_bound_deck',
  'remove_credential_from_bound_deck',
  'add_playbook_to_bound_deck',
  'remove_playbook_from_bound_deck',
];

/** Deprecated read-only aliases (legacy profile): pure reads, allowed in both profiles. */
export const WORKER_LEGACY_READ_MCP_TOOLS: readonly string[] = [
  'get_active_deck',
  'list_bound_deck_services',
  'list_active_deck_services',
  'list_bound_deck_credentials',
  'list_active_deck_credentials',
  'list_playbooks',
  'list_collection_services',
  'list_collection_credentials',
  'list_collection_playbooks',
];

/**
 * Tools both profiles deny: the admin-only surface, deck switching
 * (including the retired direct-switch alias, which must never move a
 * worker), `start_run` (workers must not re-delegate),
 * `request_deck_assignment` (the unassigned-session counterpart of
 * `switch_deck` — it opens a pending human approval, and a headless worker
 * must never wait on one), and the legacy deck-card mutators.
 */
export const WORKER_SHARED_DENY_MCP_TOOLS: readonly string[] = [
  ...WORKER_ADMIN_ONLY_MCP_TOOLS,
  'switch_deck',
  'switch_bound_deck',
  'start_run',
  'request_deck_assignment',
  ...WORKER_LEGACY_DECK_CARD_MUTATING_MCP_TOOLS,
];

/**
 * Extra tools `readonly` denies on top of the shared set: every mutating
 * Agent Deck tool — `propose_playbook_patch`, the deck/card/service writes
 * (denied here instead of at the dashboard gate so the denial is recorded
 * against the profile), `cancel_run` (a POST that cancels another run), and
 * `bind_workspace` (a same-deck re-bind synchronizes stub files into the
 * workspace). No writes, no outbound mutations.
 */
export const WORKER_READONLY_DENY_MCP_TOOLS: readonly string[] = [
  ...WORKER_SHARED_DENY_MCP_TOOLS,
  'propose_playbook_patch',
  ...WORKER_DASHBOARD_ONLY_MUTATING_MCP_TOOLS,
  'cancel_run',
  'bind_workspace',
];

/** `edit` denies exactly the shared set — no more, no less. */
export const WORKER_EDIT_DENY_MCP_TOOLS: readonly string[] = [...WORKER_SHARED_DENY_MCP_TOOLS];

/**
 * `readonly` allows read-only Agent Deck tools only. `call_service_tool` is
 * listed here but additionally gated per call: only a target service tool
 * annotated `readOnlyHint: true` is allowed (see `mcpCallServiceTool`).
 */
export const WORKER_READONLY_ALLOW_MCP_TOOLS: readonly string[] = [
  'get_session_binding',
  'get_decks',
  'get_bound_deck',
  'get_session_context',
  'get_playbook',
  'get_card_usage_events',
  'list_service_tools',
  'call_service_tool',
  'get_run',
  ...WORKER_LEGACY_READ_MCP_TOOLS,
];

/**
 * `edit` allows every Agent Deck MCP tool outside the shared deny set: the
 * readonly reads plus `bind_workspace`, `propose_playbook_patch`,
 * `cancel_run`, and the dashboard-only writes (which still answer
 * `DASHBOARD_REQUIRED` downstream — the profile does not grant them).
 */
export const WORKER_EDIT_ALLOW_MCP_TOOLS: readonly string[] = [
  ...WORKER_READONLY_ALLOW_MCP_TOOLS,
  'bind_workspace',
  'update_playbook',
  'propose_playbook_patch',
  'register_playbook',
  'register_service',
  'update_service',
  'update_service_tool_settings',
  'cancel_run',
];

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
 * `mcpAllowTools`/`mcpDenyTools` are the explicit Agent Deck MCP tool sets
 * and `mcpCallServiceTool` gates `call_service_tool` (`'any'` in `edit`;
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
  readonly mcpAllowTools: readonly string[];
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
    mcpAllowTools: WORKER_READONLY_ALLOW_MCP_TOOLS,
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
    mcpAllowTools: WORKER_EDIT_ALLOW_MCP_TOOLS,
    mcpDenyTools: WORKER_EDIT_DENY_MCP_TOOLS,
    mcpCallServiceTool: 'any',
  },
};

/**
 * Why `tool` is outside `profile`, or null when the profile allows it.
 * Fail-closed: an explicitly denied tool and an unlisted (unknown) tool are
 * both denied — a newly registered tool stays denied until it is classified
 * in the allow/deny sets above.
 */
export function mcpToolDenialReason(profile: RunToolsProfile, tool: string): string | null {
  if (WORKER_PROFILES[profile].mcpDenyTools.includes(tool)) {
    return `Tool "${tool}" is not allowed for worker profile "${profile}"`;
  }
  if (!WORKER_PROFILES[profile].mcpAllowTools.includes(tool)) {
    return `Tool "${tool}" is not in the worker profile "${profile}" allow set`;
  }
  return null;
}

/** True when `tool` is outside `profile` and must be denied immediately. */
export function isMcpToolDeniedByProfile(profile: RunToolsProfile, tool: string): boolean {
  return mcpToolDenialReason(profile, tool) !== null;
}
