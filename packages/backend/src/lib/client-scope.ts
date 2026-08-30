import { FastifyRequest } from 'fastify';
import {
  AGENT_DECK_AGENT_CLIENT,
  AGENT_DECK_CLIENT_HEADER,
  Deck,
  Service,
} from '@agent-deck/shared';
import { stripAuthorizationHeader } from '../export-import/sanitize-for-export';
import { isDashboardAuthenticated } from './dashboard-auth';

export type ClientScope = 'dashboard' | 'agent';

/** Remove secrets from service payloads returned to agent clients. */
export function sanitizeServiceForAgent(service: Service): Service {
  return {
    ...service,
    oauthClientSecret: undefined,
    oauthAccessToken: undefined,
    oauthRefreshToken: undefined,
    oauthState: undefined,
    // Same secret-header classifier as the vault split + git store — one source of truth.
    headers: stripAuthorizationHeader(service.headers),
    localEnv: undefined,
  };
}

export function sanitizeDeckForAgent(deck: Deck): Deck {
  return {
    ...deck,
    services: deck.services?.map(sanitizeServiceForAgent) ?? [],
  };
}

export function getClientScope(request: FastifyRequest): ClientScope {
  if (isDashboardAuthenticated(request)) {
    return 'dashboard';
  }
  return 'agent';
}

export function isDashboardClient(request: FastifyRequest): boolean {
  return isDashboardAuthenticated(request);
}

export function requireDashboardClient(request: FastifyRequest): void {
  if (!isDashboardClient(request)) {
    throw new DashboardOnlyError();
  }
}

export function requireAgentClient(request: FastifyRequest): void {
  const value = request.headers[AGENT_DECK_CLIENT_HEADER];
  if (typeof value !== 'string' || value.toLowerCase() !== AGENT_DECK_AGENT_CLIENT) {
    throw new AgentClientOnlyError();
  }
}

export class AgentClientOnlyError extends Error {
  constructor(message = 'This operation requires an Agent Deck agent client') {
    super(message);
    this.name = 'AgentClientOnlyError';
  }
}

export class DashboardOnlyError extends Error {
  constructor(message = 'This operation requires the Agent Deck dashboard client') {
    super(message);
    this.name = 'DashboardOnlyError';
  }
}

/** Agent clients only see deck-scoped cards for decks other than the bound deck. */
export function applyDeckScope(
  deck: Deck,
  scope: ClientScope,
  visibleDeckId?: string,
): Deck {
  if (scope === 'dashboard') {
    return deck;
  }
  const sanitized = sanitizeDeckForAgent(deck);
  if (visibleDeckId && deck.id === visibleDeckId) {
    return sanitized;
  }
  return { ...sanitized, credentials: [], playbooks: [] };
}

/** @deprecated Use applyDeckScope */
export function applyDeckCredentialScope(
  deck: Deck,
  scope: ClientScope,
  visibleDeckId?: string,
): Deck {
  return applyDeckScope(deck, scope, visibleDeckId);
}
