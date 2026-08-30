import { trustedSessionError, type TrustedSessionErrorCode } from '@agent-deck/shared';

import { BackendApiError } from '../lib/backend-api-error';
import type { McpToolHost } from './register';

export function formatMcpToolError(error: unknown) {
  if (error instanceof BackendApiError && error.errorCode) {
    return mcpPolicyError(error.errorCode);
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }],
    isError: true,
  };
}

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
    case 'RESOURCE_OUT_OF_SCOPE':
      return 'Resource is outside the bound deck';
    default:
      return code;
  }
}

/** Reads live runtime session mode from backend (source of truth after dashboard approval). */
export async function requireMcpAdmin(host: McpToolHost): Promise<ReturnType<typeof mcpPolicyError> | null> {
  if (process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK === '1') {
    return null;
  }
  try {
    const { mode } = await host.refreshRuntimeSession();
    if (mode !== 'agent-admin') {
      return mcpPolicyError('ADMIN_REQUIRED');
    }
    return null;
  } catch {
    return mcpPolicyError('GRANT_REQUIRED');
  }
}

export function requireMcpDashboard(): ReturnType<typeof mcpPolicyError> | null {
  if (process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK === '1') {
    return null;
  }
  return mcpPolicyError('DASHBOARD_REQUIRED');
}
