import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  AGENT_DECK_SESSION_HEADER,
  type AgentSessionMode,
  type RuntimeSession,
  type TrustedSessionErrorCode,
  httpStatusForTrustedError,
  trustedSessionError,
} from '@agent-deck/shared';

import { parseBearerToken } from '../lib/http-auth';
import { parseDashboardCookie } from '../lib/dashboard-auth';
import { parseAuthorityBearer } from '../execution-authority/bearer';
import type { ExecutionAuthority } from '../execution-authority/types';
import type { ExecutionAuthorityStore } from '../execution-authority/store';
import { readAdminSecretFromEnvOrFile, verifyAdminSecret } from './admin-secret';
import type { TrustedSessionStore } from './store';

export type AuthPolicy =
  | 'allowPublic'
  | 'requireTrustedWriter'
  | 'requireAgentResource'
  | 'requireAgentOrDashboard'
  | 'requireDeckAdmin'
  | 'requireDashboard';

export type RequestPrincipal =
  | { kind: 'public' }
  | { kind: 'dashboard' }
  | {
      kind: 'agent';
      session: RuntimeSession;
      mode: AgentSessionMode;
      deckId: string;
      workspaceKey: string;
    }
  | {
      kind: 'execution-authority';
      authority: ExecutionAuthority;
    };

export class TrustedAuthError extends Error {
  constructor(
    public readonly code: TrustedSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TrustedAuthError';
  }
}

async function resolveDashboardPrincipal(
  request: FastifyRequest,
  store: TrustedSessionStore,
): Promise<RequestPrincipal | null> {
  const dashboardToken = parseDashboardCookie(request);
  if (dashboardToken && store.validateAndTouchDashboardSession(dashboardToken)) {
    return { kind: 'dashboard' };
  }

  const bearer = parseBearerToken(request);
  if (bearer) {
    const expected = await readAdminSecretFromEnvOrFile();
    if (expected && verifyAdminSecret(bearer, expected)) {
      return { kind: 'dashboard' };
    }
  }

  return null;
}

function resolveAgentFromSessionHeader(
  request: FastifyRequest,
  store: TrustedSessionStore,
): RuntimeSession | null {
  const sessionHeader = request.headers[AGENT_DECK_SESSION_HEADER];
  const sessionId = typeof sessionHeader === 'string' ? sessionHeader.trim() : '';
  if (!sessionId) {
    return null;
  }

  const row = store.getRuntimeSessionRow(sessionId);
  if (!row) {
    throw new TrustedAuthError('SESSION_INVALID', 'Runtime session absent or expired');
  }
  if (row.revoked_at) {
    throw new TrustedAuthError('SESSION_REVOKED', 'Grant rotation or explicit revocation ended the session');
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new TrustedAuthError('SESSION_INVALID', 'Runtime session absent or expired');
  }

  const session = store.touchRuntimeSession(sessionId);
  if (!session) {
    throw new TrustedAuthError('SESSION_INVALID', 'Runtime session absent or expired');
  }
  return session;
}

function resolveAgentFromGrantSecret(
  grantSecret: string,
  store: TrustedSessionStore,
): RuntimeSession {
  const grant = store.findActiveGrantBySecret(grantSecret);
  if (!grant) {
    throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
  }

  return store.createRuntimeSession({
    workspaceKeyId: grant.workspace_key_id,
    workspaceGrantId: grant.id,
    deckId: grant.deck_id,
  });
}

export async function resolveRequestPrincipal(
  request: FastifyRequest,
  store: TrustedSessionStore,
  executionAuthorityStore?: ExecutionAuthorityStore,
): Promise<RequestPrincipal> {
  const dashboard = await resolveDashboardPrincipal(request, store);
  if (dashboard) {
    return dashboard;
  }

  const sessionFromHeader = resolveAgentFromSessionHeader(request, store);
  if (sessionFromHeader) {
    return {
      kind: 'agent',
      session: sessionFromHeader,
      mode: sessionFromHeader.mode,
      deckId: sessionFromHeader.deckId,
      workspaceKey: sessionFromHeader.workspaceKey,
    };
  }

  const bearer = parseBearerToken(request);
  if (bearer && executionAuthorityStore) {
    const authorityCreds = parseAuthorityBearer(bearer);
    if (authorityCreds) {
      const auth = executionAuthorityStore.authenticateAuthority(
        authorityCreds.authorityId,
        authorityCreds.secret,
      );
      if (!auth.ok) {
        throw new TrustedAuthError(
          auth.error_code === 'AUTHORITY_SECRET_INVALID' ? 'GRANT_REQUIRED' : 'GRANT_REQUIRED',
          auth.message,
        );
      }
      if (auth.data.status !== 'live') {
        throw new TrustedAuthError('GRANT_REQUIRED', `Authority is ${auth.data.status}`);
      }
      return { kind: 'execution-authority', authority: auth.data };
    }
  }

  if (bearer) {
    const session = resolveAgentFromGrantSecret(bearer, store);
    return {
      kind: 'agent',
      session,
      mode: session.mode,
      deckId: session.deckId,
      workspaceKey: session.workspaceKey,
    };
  }

  throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
}

export async function requireTrustedWriterBearer(request: FastifyRequest): Promise<void> {
  const bearer = parseBearerToken(request);
  const expected = await readAdminSecretFromEnvOrFile();
  if (!bearer || !expected || !verifyAdminSecret(bearer, expected)) {
    throw new TrustedAuthError('DASHBOARD_REQUIRED', 'Trusted writer authentication required');
  }
}

export function enforcePolicy(policy: AuthPolicy, principal: RequestPrincipal): void {
  if (policy === 'allowPublic') {
    return;
  }

  if (policy === 'requireDashboard') {
    if (principal.kind !== 'dashboard') {
      throw new TrustedAuthError('DASHBOARD_REQUIRED', 'Dashboard authentication required');
    }
    return;
  }

  if (policy === 'requireAgentOrDashboard') {
    if (
      principal.kind === 'dashboard' ||
      principal.kind === 'agent' ||
      principal.kind === 'execution-authority'
    ) {
      return;
    }
    throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
  }

  if (principal.kind === 'execution-authority') {
    if (policy === 'requireDeckAdmin') {
      throw new TrustedAuthError('ADMIN_REQUIRED', 'Deck-admin elevation is required');
    }
    if (policy === 'requireAgentResource') {
      return;
    }
    throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
  }

  if (principal.kind !== 'agent') {
    throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
  }

  if (policy === 'requireDeckAdmin' && principal.mode !== 'agent-admin') {
    throw new TrustedAuthError('ADMIN_REQUIRED', 'Deck-admin elevation is required');
  }
}

export function sendTrustedAuthError(reply: FastifyReply, error: TrustedAuthError): void {
  const body = trustedSessionError(error.code, error.message);
  reply.status(httpStatusForTrustedError(error.code)).send(body);
}

export function getAgentDeckId(principal: RequestPrincipal): string | null {
  if (principal.kind === 'agent') return principal.deckId;
  if (principal.kind === 'execution-authority') return principal.authority.deckId;
  return null;
}

export function isDashboardPrincipal(principal: RequestPrincipal): boolean {
  return principal.kind === 'dashboard';
}

export function isAgentAdmin(principal: RequestPrincipal): boolean {
  return principal.kind === 'agent' && principal.mode === 'agent-admin';
}
