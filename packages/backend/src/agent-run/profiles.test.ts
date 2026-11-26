import { describe, expect, it } from 'vitest';

import {
  isMcpToolDeniedByProfile,
  RUN_TOOL_PROFILES,
  WORKER_ADMIN_ONLY_MCP_TOOLS,
  WORKER_DASHBOARD_ONLY_MUTATING_MCP_TOOLS,
  WORKER_EDIT_DENY_MCP_TOOLS,
  WORKER_PROFILES,
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
    ]) {
      expect(isMcpToolDeniedByProfile('edit', tool), `edit ${tool}`).toBe(false);
    }
  });

  it('readonly additionally denies propose_playbook_patch and every deck/card/service write', () => {
    expect(isMcpToolDeniedByProfile('readonly', 'propose_playbook_patch')).toBe(true);
    for (const tool of WORKER_DASHBOARD_ONLY_MUTATING_MCP_TOOLS) {
      expect(isMcpToolDeniedByProfile('readonly', tool), `readonly ${tool}`).toBe(true);
      // edit leaves the dashboard-only writes to the existing dashboard gate.
      expect(isMcpToolDeniedByProfile('edit', tool), `edit ${tool}`).toBe(false);
    }
    expect([...WORKER_READONLY_DENY_MCP_TOOLS].sort()).toEqual(
      [...WORKER_SHARED_DENY_MCP_TOOLS, 'propose_playbook_patch', ...WORKER_DASHBOARD_ONLY_MUTATING_MCP_TOOLS].sort(),
    );
    // Reads stay allowed in readonly.
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
    ]) {
      expect(isMcpToolDeniedByProfile('readonly', tool), `readonly ${tool}`).toBe(false);
    }
  });
});
