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
  /** Explicit agent-run capability (NOT-480); omitted = MCP-only. */
  runsEnabled?: boolean;
  /** Explicit run-finalization capability (NOT-486); omitted = cannot finalize. */
  finalizationEnabled?: boolean;
  expiresAt?: string | null;
};

export async function registerAgentGrantRoutes(fastify: FastifyInstance) {
  const grants = grantStoreOf(fastify);

  fastify.get('/agent-grants', async (_request, reply) => {
    return reply.send({ success: true, data: grants.listGrants() });
  });

  fastify.post<{ Body: CreateGrantBody }>('/agent-grants', async (request, reply) => {
    const { label, defaultDeck, allowedDecks, runsEnabled, finalizationEnabled, expiresAt } = request.body ?? {};

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

    if (runsEnabled !== undefined && typeof runsEnabled !== 'boolean') {
      return reply.status(400).send({ success: false, error: 'runsEnabled must be a boolean' });
    }
    if (finalizationEnabled !== undefined && typeof finalizationEnabled !== 'boolean') {
      return reply.status(400).send({ success: false, error: 'finalizationEnabled must be a boolean' });
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
      runsEnabled: runsEnabled === true,
      finalizationEnabled: finalizationEnabled === true,
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

  // NOT-480: the owner opts one grant into (or out of) agent runs. NOT-486:
  // the same route toggles run finalization, a separate capability; a body
  // may set either or both, and an omitted field is unchanged. Deck
  // allowlists are unchanged and still constrain every run.
  fastify.put<{ Params: { id: string }; Body: { runsEnabled?: unknown; finalizationEnabled?: unknown } }>(
    '/agent-grants/:id/capabilities',
    async (request, reply) => {
      const id = request.params.id?.trim();
      const runsEnabled = request.body?.runsEnabled;
      const finalizationEnabled = request.body?.finalizationEnabled;
      if (runsEnabled === undefined && finalizationEnabled === undefined) {
        return reply.status(400).send({ success: false, error: 'runsEnabled must be a boolean' });
      }
      if (runsEnabled !== undefined && typeof runsEnabled !== 'boolean') {
        return reply.status(400).send({ success: false, error: 'runsEnabled must be a boolean' });
      }
      if (finalizationEnabled !== undefined && typeof finalizationEnabled !== 'boolean') {
        return reply.status(400).send({ success: false, error: 'finalizationEnabled must be a boolean' });
      }
      const existing = grants.getGrant(id);
      if (!existing) {
        return reply.status(404).send({ success: false, error: 'Grant not found' });
      }
      if (existing.revokedAt) {
        return reply.status(409).send({ success: false, error: 'Grant is revoked' });
      }
      if (typeof runsEnabled === 'boolean') {
        if (!grants.setRunsEnabled(id, runsEnabled)) {
          return reply.status(409).send({ success: false, error: 'Grant is revoked' });
        }
        if (existing.runsEnabled !== runsEnabled) {
          fastify.auditStore?.append({
            actor: 'owner',
            event: runsEnabled ? 'grant.runs_enabled' : 'grant.runs_disabled',
            targetId: id,
            outcome: 'succeeded',
            reasonCode: null,
          });
        }
      }
      if (typeof finalizationEnabled === 'boolean') {
        if (!grants.setFinalizationEnabled(id, finalizationEnabled)) {
          return reply.status(409).send({ success: false, error: 'Grant is revoked' });
        }
        if (existing.finalizationEnabled !== finalizationEnabled) {
          fastify.auditStore?.append({
            actor: 'owner',
            event: finalizationEnabled ? 'grant.finalization_enabled' : 'grant.finalization_disabled',
            targetId: id,
            outcome: 'succeeded',
            reasonCode: null,
          });
        }
      }
      return reply.send({ success: true, data: grants.getGrant(id) });
    },
  );

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
