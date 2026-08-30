import { FastifyRequest } from 'fastify';
import { AGENT_DECK_SESSION_HEADER, trustedSessionError } from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { TrustedAuthError } from '../trusted-session/auth';

export class AgentDeckContextError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: string,
  ) {
    super(message);
    this.name = 'AgentDeckContextError';
  }
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Resolve bound deck from authenticated runtime session (PRD C3). */
export async function resolveAgentDeckId(
  request: FastifyRequest,
  db: DatabaseManager,
): Promise<string> {
  const sessionId = headerValue(request, AGENT_DECK_SESSION_HEADER);
  if (!sessionId) {
    throw new AgentDeckContextError(
      trustedSessionError('GRANT_REQUIRED', 'No valid workspace grant').error,
      'GRANT_REQUIRED',
    );
  }

  const store = request.server.trustedSessionStore;
  const row = store.getRuntimeSessionRow(sessionId);
  if (!row) {
    throw new AgentDeckContextError(
      trustedSessionError('SESSION_INVALID', 'Runtime session absent or expired').error,
      'SESSION_INVALID',
    );
  }
  if (row.revoked_at) {
    throw new AgentDeckContextError(
      trustedSessionError('SESSION_REVOKED', 'Grant rotation or explicit revocation ended the session').error,
      'SESSION_REVOKED',
    );
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new AgentDeckContextError(
      trustedSessionError('SESSION_INVALID', 'Runtime session absent or expired').error,
      'SESSION_INVALID',
    );
  }

  const session = store.touchRuntimeSession(sessionId);
  if (!session) {
    throw new AgentDeckContextError(
      trustedSessionError('SESSION_INVALID', 'Runtime session absent or expired').error,
      'SESSION_INVALID',
    );
  }

  const deck = await db.getDeck(session.deckId);
  if (!deck) {
    throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
  }

  return session.deckId;
}

export async function resolveAgentMode(
  request: FastifyRequest,
): Promise<'normal' | 'agent-admin'> {
  const sessionId = headerValue(request, AGENT_DECK_SESSION_HEADER);
  if (!sessionId) {
    return 'normal';
  }
  const row = request.server.trustedSessionStore.getRuntimeSessionRow(sessionId);
  return row?.mode ?? 'normal';
}
