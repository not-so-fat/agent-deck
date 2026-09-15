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

const GRANT_REQUIRED_MESSAGE = 'No deck selected for this connection';

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
    throw new TrustedAuthError('SESSION_REVOKED', 'Session was revoked');
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

export async function resolveRequestPrincipal(
  request: FastifyRequest,
  store: TrustedSessionStore,
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
    };
  }

  throw new TrustedAuthError('GRANT_REQUIRED', GRANT_REQUIRED_MESSAGE);
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
    if (principal.kind === 'dashboard' || principal.kind === 'agent') {
      return;
    }
    throw new TrustedAuthError('GRANT_REQUIRED', GRANT_REQUIRED_MESSAGE);
  }

  if (principal.kind !== 'agent') {
    throw new TrustedAuthError('GRANT_REQUIRED', GRANT_REQUIRED_MESSAGE);
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
  return null;
}

export function isDashboardPrincipal(principal: RequestPrincipal): boolean {
  return principal.kind === 'dashboard';
}

export function isAgentAdmin(principal: RequestPrincipal): boolean {
  return principal.kind === 'agent' && principal.mode === 'agent-admin';
}
