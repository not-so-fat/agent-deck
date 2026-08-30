/**
 * MCP tool exposure tiers — keep the agent runtime path small.
 *
 * AGENT_DECK_MCP_TOOL_PROFILE:
 *   runtime  — bind, read bound deck, playbooks, proxy (~12 tools)
 *   standard — runtime + deck editing + admin elevation (~20 tools)
 *   legacy   — standard + deprecated aliases (compat during host cache refresh)
 *
 * Rare ops (delete card, import/export) are CLI / dashboard — not MCP profiles.
 * Dynamic tool loading (host tool-search) remains a future option when hosts support it.
 *
 * Secrets (API key values, OAuth tokens) are never MCP tools — dashboard/CLI only.
 */
export type McpToolProfile = 'runtime' | 'standard' | 'legacy';

const VALID: McpToolProfile[] = ['runtime', 'standard', 'legacy'];

export function resolveMcpToolProfile(raw?: string): McpToolProfile {
  const value = (raw ?? process.env.AGENT_DECK_MCP_TOOL_PROFILE ?? 'standard').toLowerCase();
  if (VALID.includes(value as McpToolProfile)) {
    return value as McpToolProfile;
  }
  return 'standard';
}

export function profileIncludes(
  profile: McpToolProfile,
  tier: 'runtime' | 'editing' | 'legacy',
): boolean {
  switch (tier) {
    case 'runtime':
      return true;
    case 'editing':
      return profile === 'standard' || profile === 'legacy';
    case 'legacy':
      return profile === 'legacy';
    default:
      return false;
  }
}
