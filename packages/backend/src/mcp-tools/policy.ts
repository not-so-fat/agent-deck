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

export function mcpContractError(error_code: string, message: string, correlation?: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ ok: false, error_code, message, correlation }),
      },
    ],
    isError: true,
  };
}

/** Control-plane ops are never available under short-lived execution authority. */
export function denyControlPlaneUnderAuthority(
  host: McpToolHost,
): ReturnType<typeof mcpContractError> | null {
  const auth = host.sessionBinding.getExecutionAuthority?.(host.getSessionId());
  if (!auth) return null;
  return mcpContractError(
    'INTERACTION_REQUIRED',
    'Control-plane decision required; do not hold the worker',
    { authorityId: auth.authorityId, requestId: `req_authority_control_${Date.now()}` },
  );
}

export async function authorizeExecutionAuthorityTool(
  host: McpToolHost,
  serviceId: string,
  toolName: string,
): Promise<ReturnType<typeof mcpContractError> | null> {
  const auth = host.sessionBinding.getExecutionAuthority?.(host.getSessionId());
  if (!auth) return null;
  const res = await fetch(`${host.backendUrl}/api/execution-authority/authorize-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      authorityId: auth.authorityId,
      authoritySecret: auth.authoritySecret,
      audience: auth.audience,
      serviceId,
      toolName,
    }),
  });
  const body = (await res.json()) as {
    ok?: boolean;
    error_code?: string;
    message?: string;
    correlation?: Record<string, unknown>;
  };
  if (!res.ok || !body.ok) {
    return mcpContractError(
      body.error_code ?? 'RESOURCE_OUT_OF_SCOPE',
      body.message ?? 'Authority denied tool call',
      body.correlation,
    );
  }
  return null;
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
