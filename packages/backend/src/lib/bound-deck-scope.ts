import { FastifyRequest } from 'fastify';
import { DatabaseManager } from '../models/database';
import { AgentDeckContextError, resolveAgentDeckId } from './agent-deck-context';
import { isDashboardClient } from './client-scope';
import { trustedSessionError, type TrustedSessionErrorCode } from '@agent-deck/shared';

export class BoundDeckScopeError extends Error {
  constructor(
    message = 'Resource is outside the bound deck',
    public readonly errorCode: TrustedSessionErrorCode = 'RESOURCE_OUT_OF_SCOPE',
  ) {
    super(message);
    this.name = 'BoundDeckScopeError';
  }
}

/** Agent clients may only mutate the workspace-bound deck; dashboard may use any deck id. */
export async function requireBoundDeckScope(
  request: FastifyRequest,
  db: DatabaseManager,
  deckId: string,
): Promise<string> {
  if (isDashboardClient(request)) {
    return deckId;
  }

  const boundDeckId = await resolveAgentDeckId(request, db);
  if (deckId !== boundDeckId) {
    throw new BoundDeckScopeError(
      `Agent may only modify bound deck ${boundDeckId}, not ${deckId}`,
    );
  }

  return boundDeckId;
}

export async function requireServiceOnBoundDeck(
  request: FastifyRequest,
  db: DatabaseManager,
  serviceId: string,
): Promise<void> {
  if (isDashboardClient(request)) {
    return;
  }

  const deckId = await resolveAgentDeckId(request, db);
  const deck = await db.getDeck(deckId);
  if (!deck) {
    throw new AgentDeckContextError(`Deck not found: ${deckId}`);
  }

  const onDeck = deck.services?.some((service) => service.id === serviceId) ?? false;
  if (!onDeck) {
    throw new BoundDeckScopeError('Service is not on the bound deck');
  }
}

export async function requireCredentialOnBoundDeck(
  request: FastifyRequest,
  db: DatabaseManager,
  credentialId: string,
): Promise<void> {
  if (isDashboardClient(request)) {
    return;
  }

  const deckId = await resolveAgentDeckId(request, db);
  const onDeck = await db.getDeck(deckId).then(
    (deck) => deck?.credentials?.some((credential) => credential.id === credentialId) ?? false,
  );
  if (!onDeck) {
    throw new BoundDeckScopeError('Credential is not on the bound deck');
  }
}

export async function requirePlaybookOnBoundDeck(
  request: FastifyRequest,
  db: DatabaseManager,
  playbookId: string,
): Promise<void> {
  if (isDashboardClient(request)) {
    return;
  }

  const deckId = await resolveAgentDeckId(request, db);
  const deck = await db.getDeck(deckId);
  if (!deck) {
    throw new AgentDeckContextError(`Deck not found: ${deckId}`);
  }

  const onDeck = deck.playbooks?.some((playbook) => playbook.id === playbookId) ?? false;
  if (!onDeck) {
    throw new BoundDeckScopeError('Playbook is not on the bound deck');
  }
}

function boundDeckScopeResponse(error: unknown): {
  status: number;
  message: string;
  error_code?: TrustedSessionErrorCode;
  body?: ReturnType<typeof trustedSessionError>;
} {
  if (error instanceof BoundDeckScopeError) {
    return {
      status: 403,
      message: error.message,
      error_code: error.errorCode,
      body: trustedSessionError(error.errorCode, error.message),
    };
  }
  if (error instanceof AgentDeckContextError) {
    return { status: 400, message: error.message };
  }
  return {
    status: 400,
    message: error instanceof Error ? error.message : 'Unknown error',
  };
}

export { boundDeckScopeResponse };
