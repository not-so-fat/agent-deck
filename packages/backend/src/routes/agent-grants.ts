import type { FastifyInstance } from 'fastify';

import type { ClientGrantStore } from '../auth/client-grants';
import { resolveDeckRef } from '../lib/deck-resolve';

/**
 * NOT-318: owner-only per-agent remote grant issuance.
 *
 * All three routes are dashboard-authenticated (see the route-policy
 * registry): the owner's dashboard cookie or admin-secret bearer. Remote
 * agent tokens can never mint grants.
 *
 * The bearer secret exists in exactly one response: the create response,
 * shown once. List/revoke responses carry ids and labels only — never the
 * secret, never the verifier, never an Authorization value.
 */

type CreateGrantBody = {
  label?: string;
  defaultDeck?: string;
  allowedDecks?: string[];
  expiresAt?: string | null;
};

export async function registerAgentGrantRoutes(fastify: FastifyInstance) {
  const grants = grantStoreOf(fastify);

  fastify.get('/agent-grants', async (_request, reply) => {
    return reply.send({ success: true, data: grants.listGrants() });
  });

  fastify.post<{ Body: CreateGrantBody }>('/agent-grants', async (request, reply) => {
    const { label, defaultDeck, allowedDecks, expiresAt } = request.body ?? {};

    if (!label?.trim()) {
      return reply.status(400).send({ success: false, error: 'label required' });
    }
    if (!defaultDeck?.trim()) {
      return reply.status(400).send({ success: false, error: 'defaultDeck required' });
    }

    const resolvedDefault = await resolveDeckRef(fastify.db, defaultDeck.trim());
    if (!resolvedDefault) {
      return reply.status(404).send({ success: false, error: 'defaultDeck not found' });
    }

    const resolvedAllowed: string[] = [];
    for (const ref of allowedDecks ?? []) {
      if (typeof ref !== 'string' || !ref.trim()) {
        return reply.status(400).send({ success: false, error: 'allowedDecks must be deck ids or names' });
      }
      const deck = await resolveDeckRef(fastify.db, ref.trim());
      if (!deck) {
        return reply.status(404).send({ success: false, error: `allowed deck not found: ${ref.trim()}` });
      }
      resolvedAllowed.push(deck.id);
    }

    if (expiresAt !== undefined && expiresAt !== null) {
      if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
        return reply.status(400).send({ success: false, error: 'expiresAt must be an ISO timestamp' });
      }
      if (Date.parse(expiresAt) <= Date.now()) {
        return reply.status(400).send({ success: false, error: 'expiresAt must be in the future' });
      }
    }

    const issued = grants.issueGrant({
      label: label.trim(),
      defaultDeck: resolvedDefault.id,
      allowedDecks: resolvedAllowed.length > 0 ? resolvedAllowed : [resolvedDefault.id],
      ...(expiresAt ? { expiresAt } : {}),
    });

    fastify.auditStore?.append({
      actor: 'owner',
      event: 'grant.created',
      targetId: issued.grant.id,
      outcome: 'succeeded',
      reasonCode: null,
    });

    // Log the issuance by id/label only — the bearer value is never logged.
    fastify.log.info(
      { grantId: issued.grant.id },
      'agent grant issued',
    );

    return reply.header('Cache-Control', 'no-store').status(201).send({
      success: true,
      data: {
        grant: issued.grant,
        token: issued.token,
      },
    });
  });

  fastify.post<{ Params: { id: string } }>('/agent-grants/:id/revoke', async (request, reply) => {
    const id = request.params.id?.trim();
    if (!id) {
      return reply.status(400).send({ success: false, error: 'id required' });
    }
    const existing = grants.getGrant(id);
    if (!existing) {
      return reply.status(404).send({ success: false, error: 'Grant not found' });
    }
    grants.revokeGrant(id);
    // Fail closed immediately: established runtime sessions bound to this
    // grant end now (the MCP per-request revalidation is the second layer).
    const sessionsRevoked = fastify.trustedSessionStore.revokeRuntimeSessionsByGrant(id);

    if (!existing.revokedAt) {
      fastify.auditStore?.append({
        actor: 'owner',
        event: 'grant.revoked',
        targetId: id,
        outcome: 'succeeded',
        reasonCode: null,
      });
    }

    fastify.log.info({ grantId: id, sessionsRevoked }, 'agent grant revoked');

    return reply.send({ success: true, data: { revoked: true, sessionsRevoked } });
  });
}

function grantStoreOf(fastify: FastifyInstance): ClientGrantStore {
  const store = (fastify as unknown as { grantStore?: ClientGrantStore }).grantStore;
  if (!store) {
    throw new Error('Internal: grant store not registered');
  }
  return store;
}

declare module 'fastify' {
  interface FastifyInstance {
    grantStore: ClientGrantStore;
  }
}
