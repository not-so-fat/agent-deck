import { trustedSessionError, type TrustedSessionErrorCode } from '@agent-deck/shared';

import type { McpToolHost } from './register';

export function mcpPolicyError(code: TrustedSessionErrorCode) {
  const body = trustedSessionError(code, bodyMessage(code));
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    isError: true,
  };
}

function bodyMessage(code: TrustedSessionErrorCode): string {
  switch (code) {
    case 'ADMIN_REQUIRED':
      return 'Deck-admin elevation is required';
    case 'DASHBOARD_REQUIRED':
      return 'Operation is never available to an agent';
    case 'GRANT_REQUIRED':
      return 'No valid workspace grant';
    default:
      return code;
  }
}

export function requireMcpAdmin(host: McpToolHost): ReturnType<typeof mcpPolicyError> | null {
  if (process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK === '1') {
    return null;
  }
  if (host.getMode() !== 'agent-admin') {
    return mcpPolicyError('ADMIN_REQUIRED');
  }
  return null;
}

export function requireMcpDashboard(): ReturnType<typeof mcpPolicyError> | null {
  if (process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK === '1') {
    return null;
  }
  return mcpPolicyError('DASHBOARD_REQUIRED');
}
