import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  httpStatusForTrustedError,
  trustedSessionError,
  type TrustedSessionErrorCode,
} from '@agent-deck/shared';

import { resolveAgentDeckId } from './agent-deck-context';
import { isDashboardClient } from './client-scope';
import type { DatabaseManager } from '../models/database';

export class RoutePolicyError extends Error {
  constructor(
    public readonly code: TrustedSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoutePolicyError';
  }
}

export function sendRoutePolicyError(reply: FastifyReply, error: RoutePolicyError): void {
  reply.status(httpStatusForTrustedError(error.code)).send(trustedSessionError(error.code, error.message));
}

export function requireDashboard(request: FastifyRequest): void {
  if (!isDashboardClient(request)) {
    throw new RoutePolicyError('DASHBOARD_REQUIRED', 'Dashboard authentication required');
  }
}

export async function requireAgentBoundDeck(
  request: FastifyRequest,
  db: DatabaseManager,
): Promise<string> {
  return resolveAgentDeckId(request, db);
}

export function requireAgentAdmin(request: FastifyRequest): void {
  const sessionId = request.headers['x-agent-deck-session-id'];
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new RoutePolicyError('GRANT_REQUIRED', 'No valid workspace grant');
  }

  const row = request.server.trustedSessionStore.getRuntimeSessionRow(sessionId.trim());
  if (!row || row.revoked_at || row.mode !== 'agent-admin') {
    throw new RoutePolicyError('ADMIN_REQUIRED', 'Deck-admin elevation is required');
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new RoutePolicyError('SESSION_INVALID', 'Runtime session absent or expired');
  }
  if (row.admin_expires_at && Date.parse(row.admin_expires_at) <= Date.now()) {
    throw new RoutePolicyError('ADMIN_REQUIRED', 'Deck-admin elevation is required');
  }
}

export async function getBoundDeckServices(
  request: FastifyRequest,
  db: DatabaseManager,
) {
  const deckId = await requireAgentBoundDeck(request, db);
  const deck = await db.getDeck(deckId);
  if (!deck) {
    throw new RoutePolicyError('GRANT_REQUIRED', 'No valid workspace grant');
  }
  return deck.services ?? [];
}
