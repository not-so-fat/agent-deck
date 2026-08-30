import { randomBytes } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  AGENT_DECK_DASHBOARD_COOKIE,
  AGENT_DECK_SESSION_HEADER,
  type AgentSessionMode,
  type RuntimeSession,
  type TrustedSessionErrorCode,
  httpStatusForTrustedError,
  trustedSessionError,
} from '@agent-deck/shared';

import { readAdminSecretFromEnvOrFile, verifyAdminSecret } from './admin-secret';
import type { TrustedSessionStore } from './store';

export type AuthPolicy =
  | 'allowPublic'
  | 'requireAgentResource'
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

const dashboardSessions = new Map<string, { expiresAt: number }>();
const DASHBOARD_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function parseBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice('Bearer '.length).trim() || null;
}

function parseDashboardCookie(request: FastifyRequest): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return null;
  }
  const prefix = `${AGENT_DECK_DASHBOARD_COOKIE}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}

export function createDashboardSessionToken(): string {
  const token = randomBytes(32).toString('base64url');
  dashboardSessions.set(token, { expiresAt: Date.now() + DASHBOARD_SESSION_TTL_MS });
  return token;
}

export function validateDashboardSessionToken(token: string): boolean {
  const entry = dashboardSessions.get(token);
  if (!entry) {
    return false;
  }
  if (entry.expiresAt <= Date.now()) {
    dashboardSessions.delete(token);
    return false;
  }
  return true;
}

async function resolveDashboardPrincipal(request: FastifyRequest): Promise<RequestPrincipal | null> {
  const dashboardToken = parseDashboardCookie(request);
  if (dashboardToken && validateDashboardSessionToken(dashboardToken)) {
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
): Promise<RequestPrincipal> {
  const dashboard = await resolveDashboardPrincipal(request);
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

  const grantSecret = parseBearerToken(request);
  if (grantSecret) {
    const session = resolveAgentFromGrantSecret(grantSecret, store);
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
  return principal.kind === 'agent' ? principal.deckId : null;
}

export function isDashboardPrincipal(principal: RequestPrincipal): boolean {
  return principal.kind === 'dashboard';
}

export function isAgentAdmin(principal: RequestPrincipal): boolean {
  return principal.kind === 'agent' && principal.mode === 'agent-admin';
}
