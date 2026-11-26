import { describe, expect, it } from 'vitest';

import {
  isMcpToolDeniedByProfile,
  RUN_TOOL_PROFILES,
  WORKER_ADMIN_ONLY_MCP_TOOLS,
  WORKER_DASHBOARD_ONLY_MUTATING_MCP_TOOLS,
  WORKER_EDIT_ALLOW_MCP_TOOLS,
  WORKER_EDIT_DENY_MCP_TOOLS,
  WORKER_LEGACY_DECK_CARD_MUTATING_MCP_TOOLS,
  WORKER_LEGACY_READ_MCP_TOOLS,
  WORKER_PROFILES,
  WORKER_READONLY_ALLOW_MCP_TOOLS,
  WORKER_READONLY_DENY_MCP_TOOLS,
  WORKER_SHARED_DENY_MCP_TOOLS,
} from './profiles';

describe('worker profiles (NOT-669)', () => {
  it('defines exactly the readonly and edit profiles', () => {
    expect([...RUN_TOOL_PROFILES].sort()).toEqual(['edit', 'readonly']);
    expect(Object.keys(WORKER_PROFILES).sort()).toEqual(['edit', 'readonly']);
  });

  it('edit: any shell, workspace + agent-home writes, full network, git/gh/npm/curl, Monitor', () => {
    expect(WORKER_PROFILES.edit).toMatchObject({
      profile: 'edit',
      shell: 'any',
      fileWrites: 'workspace-and-agent-home',
      network: 'full',
      gitMutations: true,
      hostCliMutations: true,
      monitor: true,
      mcpCallServiceTool: 'any',
    });
  });

  it('readonly: read-only shell, no writes, read-only network, no mutations, read-only service tools', () => {
    expect(WORKER_PROFILES.readonly).toMatchObject({
      profile: 'readonly',
      shell: 'readonly-commands',
      fileWrites: 'none',
      network: 'read',
      gitMutations: false,
      hostCliMutations: false,
      monitor: false,
      mcpCallServiceTool: 'read-only-annotated',
    });
  });

  it('denies switch_deck, request_admin_elevation, start_run, and every admin-only tool in both profiles', () => {
    for (const tool of ['switch_deck', 'request_admin_elevation', 'start_run', ...WORKER_ADMIN_ONLY_MCP_TOOLS]) {
      expect(isMcpToolDeniedByProfile('edit', tool), `edit ${tool}`).toBe(true);
      expect(isMcpToolDeniedByProfile('readonly', tool), `readonly ${tool}`).toBe(true);
    }
    // The retired direct-switch alias is a switch path too.
    expect(isMcpToolDeniedByProfile('edit', 'switch_bound_deck')).toBe(true);
    expect(isMcpToolDeniedByProfile('readonly', 'switch_bound_deck')).toBe(true);
    // The unassigned-session counterpart of switch_deck opens a pending
    // human approval — a headless worker must never wait on one.
    expect(isMcpToolDeniedByProfile('edit', 'request_deck_assignment')).toBe(true);
    expect(isMcpToolDeniedByProfile('readonly', 'request_deck_assignment')).toBe(true);
    // Compat aliases of the admin-gated deck-card operation are denied like it.
    for (const tool of WORKER_LEGACY_DECK_CARD_MUTATING_MCP_TOOLS) {
      expect(isMcpToolDeniedByProfile('edit', tool), `edit ${tool}`).toBe(true);
      expect(isMcpToolDeniedByProfile('readonly', tool), `readonly ${tool}`).toBe(true);
    }
  });

  it('edit denies exactly the shared set — call_service_tool and propose_playbook_patch are allowed', () => {
    expect([...WORKER_EDIT_DENY_MCP_TOOLS].sort()).toEqual([...WORKER_SHARED_DENY_MCP_TOOLS].sort());
    expect(isMcpToolDeniedByProfile('edit', 'call_service_tool')).toBe(false);
    expect(isMcpToolDeniedByProfile('edit', 'propose_playbook_patch')).toBe(false);
    // Reads stay allowed in edit.
    for (const tool of [
      'bind_workspace',
      'get_session_context',
      'get_session_binding',
      'get_bound_deck',
      'get_decks',
      'get_playbook',
      'get_card_usage_events',
      'list_service_tools',
      'get_run',
      'cancel_run',
      ...WORKER_LEGACY_READ_MCP_TOOLS,
    ]) {
      expect(isMcpToolDeniedByProfile('edit', tool), `edit ${tool}`).toBe(false);
    }
  });

  it('readonly additionally denies every mutating Agent Deck tool', () => {
    expect(isMcpToolDeniedByProfile('readonly', 'propose_playbook_patch')).toBe(true);
    for (const tool of WORKER_DASHBOARD_ONLY_MUTATING_MCP_TOOLS) {
      expect(isMcpToolDeniedByProfile('readonly', tool), `readonly ${tool}`).toBe(true);
      // edit leaves the dashboard-only writes to the existing dashboard gate.
      expect(isMcpToolDeniedByProfile('edit', tool), `edit ${tool}`).toBe(false);
    }
    // cancel_run POSTs a cancel, bind_workspace synchronizes files.
    for (const tool of ['cancel_run', 'bind_workspace']) {
      expect(isMcpToolDeniedByProfile('readonly', tool), `readonly ${tool}`).toBe(true);
      expect(isMcpToolDeniedByProfile('edit', tool), `edit ${tool}`).toBe(false);
    }
    expect([...WORKER_READONLY_DENY_MCP_TOOLS].sort()).toEqual(
      [
        ...WORKER_SHARED_DENY_MCP_TOOLS,
        'propose_playbook_patch',
        ...WORKER_DASHBOARD_ONLY_MUTATING_MCP_TOOLS,
        'cancel_run',
        'bind_workspace',
      ].sort(),
    );
    // Reads stay allowed in readonly.
    for (const tool of [
      'get_session_context',
      'get_session_binding',
      'get_bound_deck',
      'get_decks',
      'get_playbook',
      'get_card_usage_events',
      'list_service_tools',
      'get_run',
      ...WORKER_LEGACY_READ_MCP_TOOLS,
    ]) {
      expect(isMcpToolDeniedByProfile('readonly', tool), `readonly ${tool}`).toBe(false);
    }
  });

  it('fail-closed: unknown tools are denied in both profiles', () => {
    for (const tool of ['no_such_tool', '', 'Start_Run']) {
      expect(isMcpToolDeniedByProfile('edit', tool), `edit ${tool}`).toBe(true);
      expect(isMcpToolDeniedByProfile('readonly', tool), `readonly ${tool}`).toBe(true);
    }
  });

  it('allow and deny sets never overlap', () => {
    for (const profile of RUN_TOOL_PROFILES) {
      const allow = new Set(WORKER_PROFILES[profile].mcpAllowTools);
      for (const tool of WORKER_PROFILES[profile].mcpDenyTools) {
        expect(allow.has(tool), `${profile} ${tool}`).toBe(false);
      }
    }
    expect(new Set(WORKER_EDIT_ALLOW_MCP_TOOLS).size).toBe(WORKER_EDIT_ALLOW_MCP_TOOLS.length);
    expect(new Set(WORKER_READONLY_ALLOW_MCP_TOOLS).size).toBe(WORKER_READONLY_ALLOW_MCP_TOOLS.length);
  });
});
