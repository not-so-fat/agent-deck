import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DeckSwitchResolveBodySchema,
  type RuntimeSession,
  countDeckCards,
} from '@agent-deck/shared';
import {
  AGENT_DECK_DASHBOARD_COOKIE,
  AGENT_DECK_SESSION_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
  DASHBOARD_NONCE_TTL_MS,
  DASHBOARD_COOKIE_MAX_AGE_MS,
} from '@agent-deck/shared';

import { resolveDeckRef } from '../lib/deck-resolve';
import type { ClientGrantStore } from '../auth/client-grants';
import { refreshLiveDisplayAfterDeckSwitch } from '../scope/display';
import type { LiveDisplayRegistry } from '../scope/live-display-registry';
import { parseBearerToken } from '../lib/http-auth';
import {
  requireTrustedWriterBearer,
  sendTrustedAuthError,
  TrustedAuthError,
} from '../trusted-session/auth';
import { isDashboardAuthenticated, parseDashboardCookie } from '../lib/dashboard-auth';
import type { TrustedSessionStore } from '../trusted-session/store';
import { readAdminSecretFromEnvOrFile, verifyAdminSecret } from '../trusted-session/admin-secret';
import type { OwnerAuthProvider } from '../auth/owner-auth';
import {
  HOSTED_DASHBOARD_ABSOLUTE_MS,
  HOSTED_DASHBOARD_IDLE_MS,
} from '../auth/hosted-mode';

const GRANT_REQUIRED_MESSAGE = 'No deck selected for this connection';

/** Caller must own the runtime session (session header matches body id). */
function requireRuntimeSessionOwnership(request: FastifyRequest, runtimeSessionId: string): void {
  const header = request.headers[AGENT_DECK_SESSION_HEADER];
  const sessionHeader = typeof header === 'string' ? header.trim() : '';
  if (!sessionHeader || sessionHeader !== runtimeSessionId.trim()) {
    throw new TrustedAuthError('GRANT_REQUIRED', 'Runtime session ownership required');
  }
}

function resolveRuntimeSessionFromHeader(
  request: FastifyRequest,
  store: TrustedSessionStore,
): RuntimeSession {
  const sessionHeader = request.headers[AGENT_DECK_SESSION_HEADER];
  const sessionId = typeof sessionHeader === 'string' ? sessionHeader.trim() : '';
  if (!sessionId) {
    throw new TrustedAuthError('GRANT_REQUIRED', GRANT_REQUIRED_MESSAGE);
  }
  const row = store.getRuntimeSessionRow(sessionId);
  if (!row || row.revoked_at) {
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

/**
 * NOT-318: grant-allowlist gate shared by the deck-switch creation,
 * approval-commit, and bind-workspace deck-change paths.
 *
 * No grant on the session (loopback launcher, tests without a grant
 * store) means unconstrained — exactly today's behavior. A session bound
 * to a live grant may only name decks inside the grant allowlist; a
 * missing, revoked, or expired grant fails closed with GRANT_REQUIRED.
 * The helper never throws for unconstrained sessions.
 */
function grantStoreOf(fastify: FastifyInstance): ClientGrantStore | null {
  return (fastify as unknown as { grantStore?: ClientGrantStore }).grantStore ?? null;
}

function requireGrantDeckScope(
  fastify: FastifyInstance,
  runtimeSessionId: string,
  deckId: string,
): void {
  const grants = grantStoreOf(fastify);
  if (!grants) {
    return;
  }
  const row = fastify.trustedSessionStore.getRuntimeSessionRow(runtimeSessionId);
  const grantId = row?.grant_id;
  if (!grantId) {
    return;
  }
  const grant = grants.getGrant(grantId);
  if (!grant || grant.revokedAt || (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())) {
    throw new TrustedAuthError('GRANT_REQUIRED', 'Grant expired or revoked');
  }
  if (!grant.allowedDecks.includes(deckId)) {
    throw new TrustedAuthError(
      'RESOURCE_OUT_OF_SCOPE',
      "Deck is outside this grant's allowed decks",
    );
  }
}

export async function registerTrustedSessionRoutes(fastify: FastifyInstance) {
  const store = fastify.trustedSessionStore;

  fastify.get('/runtime-session', async (request, reply) => {
    try {
      const sessionHeader = request.headers[AGENT_DECK_SESSION_HEADER];
      const sessionId = typeof sessionHeader === 'string' ? sessionHeader.trim() : '';
      if (!sessionId) {
        throw new TrustedAuthError('GRANT_REQUIRED', GRANT_REQUIRED_MESSAGE);
      }

      const row = store.getRuntimeSessionRow(sessionId);
      if (!row || row.revoked_at) {
        throw new TrustedAuthError('SESSION_REVOKED', 'Session was revoked');
      }
      if (Date.parse(row.expires_at) <= Date.now()) {
        throw new TrustedAuthError('SESSION_INVALID', 'Runtime session absent or expired');
      }

      const session = store.touchRuntimeSession(sessionId);
      if (!session) {
        throw new TrustedAuthError('SESSION_INVALID', 'Runtime session absent or expired');
      }

      const deck = await fastify.db.getDeck(session.deckId);

      return reply.send({
        success: true,
        data: {
          sessionId: session.sessionId,
          deckId: session.deckId,
          deckName: deck?.name,
          mode: session.mode,
          expiresAt: session.expiresAt,
          adminExpiresAt: session.adminExpiresAt,
        },
      });
    } catch (error) {
      if (error instanceof TrustedAuthError) {
        return sendTrustedAuthError(reply, error);
      }
      throw error;
    }
  });

  fastify.post<{ Body: { workspaceRoot: string; deckId: string; updateAssignment?: boolean } }>(
    '/bind-workspace',
    async (request, reply) => {
      try {
        const { workspaceRoot, deckId, updateAssignment } = request.body;
        if (!workspaceRoot?.trim() || !deckId?.trim()) {
          return reply.status(400).send({ success: false, error: 'workspaceRoot and deckId required' });
        }

        const session = resolveRuntimeSessionFromHeader(request, store);

        // Launch session: deck fixed at connect unless elevated assignment update.
        if (deckId !== session.deckId) {
          if (updateAssignment !== true) {
            throw new TrustedAuthError(
              'DECK_FIXED',
              "This connection's deck was set when it was launched and cannot be changed by the agent",
            );
          }
          if (session.mode !== 'agent-admin') {
            throw new TrustedAuthError('ADMIN_REQUIRED', 'Deck-admin elevation is required');
          }
          // NOT-318: even an elevated grant session cannot leave its allowlist.
          requireGrantDeckScope(fastify, session.sessionId, deckId);
          const updated = store.setRuntimeSessionDeck(session.sessionId, deckId);
          if (!updated) {
            throw new TrustedAuthError('SESSION_INVALID', 'Runtime session absent or expired');
          }
          const newDeck = await fastify.db.getDeck(updated.deckId);
          if (!newDeck) {
            return reply.status(404).send({ success: false, error: 'Deck not found' });
          }
          return reply.send({
            success: true,
            data: {
              deckId: updated.deckId,
              deckName: newDeck.name,
              mode: updated.mode,
              assignmentUpdated: true,
            },
          });
        }
        const deck = await fastify.db.getDeck(deckId);
        if (!deck) {
          return reply.status(404).send({ success: false, error: 'Deck not found' });
        }
        return reply.send({
          success: true,
          data: {
            deckId: session.deckId,
            deckName: deck.name,
            mode: session.mode,
            deckFixed: true,
          },
        });
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
    },
  );

  fastify.get('/admin/challenges', async (_request, reply) => {
    const pending = store.listPendingAdminChallenges();
    const data = await Promise.all(
      pending.map(async (row) => {
        const deck = await fastify.db.getDeck(row.deckId);
        const approvalPath = `/admin/approve?challenge=${encodeURIComponent(row.challengeId)}&session=${encodeURIComponent(row.runtimeSessionId)}`;
        return {
          challengeId: row.challengeId,
          runtimeSessionId: row.runtimeSessionId,
          deckId: row.deckId,
          deckName: deck?.name,
          expiresAt: row.expiresAt,
          approvalPath,
        };
      }),
    );
    return reply.send({ success: true, data });
  });

  // NOT-212: menubar approval inbox. Lists every pending deck-switch
  // request with display-safe labels and a secret-free approval path, so a
  // missed auto-open tab stays recoverable. Lazy expiry in the store means
  // resolved/expired requests drop out on refresh. Mirrors the allowPublic
  // admin/challenges endpoint the menubar already polls.
  fastify.get('/deck-switch/pending', async (_request, reply) => {
    const pending = store.listPendingDeckSwitchRequests();
    const data = await Promise.all(
      pending.map(async (record) => {
        const current = await fastify.db.getDeck(record.currentDeckId);
        const requested = await fastify.db.getDeck(record.requestedDeckId);
        const approvalPath = `/deck-switch/approve?request=${encodeURIComponent(record.requestId)}&session=${encodeURIComponent(record.runtimeSessionId)}`;
        return {
          requestId: record.requestId,
          runtimeSessionId: record.runtimeSessionId,
          status: record.status,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          ...(current ? { currentDeckName: current.name } : {}),
          ...(requested ? { requestedDeckName: requested.name } : {}),
          approvalPath,
        };
      }),
    );
    return reply.send({ success: true, data });
  });

  fastify.post<{ Body: { runtimeSessionId: string } }>(
    '/admin/request-elevation',
    async (request, reply) => {
      try {
        const { runtimeSessionId } = request.body;
        if (!runtimeSessionId?.trim()) {
          return reply.status(400).send({ success: false, error: 'runtimeSessionId required' });
        }

        requireRuntimeSessionOwnership(request, runtimeSessionId);

        const row = store.getRuntimeSessionRow(runtimeSessionId);
        if (!row || row.revoked_at) {
          throw new TrustedAuthError('SESSION_INVALID', 'Runtime session absent or expired');
        }

        const challenge = store.createAdminChallenge(runtimeSessionId);
        const approvalUrl = `/admin/approve?challenge=${encodeURIComponent(challenge.id)}&session=${encodeURIComponent(runtimeSessionId)}`;

        return reply.send({
          success: true,
          data: {
            challengeId: challenge.id,
            runtimeSessionId,
            expiresAt: challenge.expires_at,
            approvalUrl,
          },
        });
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
    },
  );

  fastify.post<{ Body: { challengeId: string; runtimeSessionId: string } }>(
    '/admin/approve',
    async (request, reply) => {
      try {
        const bearer = parseBearerToken(request);
        const expected = await readAdminSecretFromEnvOrFile();
        if (!bearer || !expected || !verifyAdminSecret(bearer, expected)) {
          if (!isDashboardAuthenticated(request)) {
            throw new TrustedAuthError('DASHBOARD_REQUIRED', 'Dashboard authentication required');
          }
        }

        const { challengeId, runtimeSessionId } = request.body;
        const consumed = store.consumeAdminChallenge(challengeId, runtimeSessionId);
        if (!consumed) {
          throw new TrustedAuthError('ADMIN_CHALLENGE_EXPIRED', 'Approval challenge expired or was already consumed');
        }

        const elevated = store.elevateSessionToAdmin(runtimeSessionId);
        if (!elevated) {
          throw new TrustedAuthError('SESSION_INVALID', 'Runtime session absent or expired');
        }

        return reply.send({ success: true, data: { session: elevated } });
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
    },
  );

  fastify.post<{ Body: { runtimeSessionId: string } }>(
    '/admin/exit',
    async (request, reply) => {
      try {
        const { runtimeSessionId } = request.body;
        if (!runtimeSessionId?.trim()) {
          return reply.status(400).send({ success: false, error: 'runtimeSessionId required' });
        }

        requireRuntimeSessionOwnership(request, runtimeSessionId);

        const downgraded = store.downgradeSessionToNormal(runtimeSessionId);
        if (!downgraded) {
          return reply.status(404).send({ success: false, error: 'Session not found' });
        }

        return reply.send({ success: true, data: { session: downgraded } });
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
    },
  );

  fastify.post<{ Body: { deckId: string; mcpSessionId?: string; grantId?: string } }>(
    '/mcp/connect-deck',
    async (request, reply) => {
      try {
        const deckId = request.body.deckId?.trim();
        if (!deckId) {
          return reply.status(400).send({ success: false, error: 'deckId required' });
        }

        const deck = await fastify.db.getDeck(deckId);
        if (!deck) {
          return reply.status(404).send({ success: false, error: 'Deck not found' });
        }

        const mcpId = request.body.mcpSessionId?.trim();
        // NOT-318: owning-grant link for bearer-grant sessions. Verified
        // grant-side by the MCP bearer gate before this call; stored here
        // so deck-switch creation/approval can enforce the same allowlist.
        // Loopback launcher calls omit it and stay unconstrained.
        const grantId = request.body.grantId?.trim() || undefined;
        let session;
        if (mcpId) {
          const historical = store.findLatestRuntimeSessionByMcpSessionId(mcpId);
          if (historical && historical.deckId !== deckId) {
            throw new TrustedAuthError('GRANT_REQUIRED', 'Deck does not own this MCP session');
          }
          session = store.findActiveLaunchSessionForMcp(mcpId, deckId);
        }
        if (!session) {
          session = store.createRuntimeSession({
            deckId,
            mcpSessionId: mcpId,
            ...(grantId ? { grantId } : {}),
          });
        }

        return reply.send({
          success: true,
          data: {
            sessionId: session.sessionId,
            deckId: session.deckId,
            deckName: deck.name,
            mode: session.mode,
            expiresAt: session.expiresAt,
          },
        });
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
    },
  );

  fastify.post<{ Body: { target?: string } }>(
    '/deck-switch',
    async (request, reply) => {
      try {
        const session = resolveRuntimeSessionFromHeader(request, store);

        const target = request.body?.target?.trim();
        if (!target) {
          return reply.status(400).send({ success: false, error: 'target required' });
        }

        // NOT-209: request-only creation. The target is resolved server-side
        // by id or exact name; unknown/ambiguous refs fail with no deck
        // contents and no binding change. This endpoint never mutates the
        // session or workspace-default binding — approval commits later via
        // the dashboard-only resolve route (NOT-207).
        //
        // The request body carries only the target. The workspace stored on
        // the request — the future write target of a workspace-default
        // approval — comes solely from the bound-workspace header the MCP
        // server sets from its server-side session binding. A body-supplied
        // path is never trusted, so no caller can smuggle an arbitrary
        // directory into a human approval.
        const requested = await resolveDeckRef(fastify.db, target);
        if (!requested) {
          return reply.status(404).send({ success: false, error: 'Deck not found' });
        }

        // NOT-318: a grant session cannot even request a deck outside
        // its allowlist — the binding stays untouched.
        requireGrantDeckScope(fastify, session.sessionId, requested.id);

        const current = await fastify.db.getDeck(session.deckId);
        if (requested.id === session.deckId) {
          return reply.send({
            success: true,
            data: {
              status: 'already_on_deck',
              currentDeckId: session.deckId,
              ...(current ? { currentDeckName: current.name } : {}),
            },
          });
        }

        const workspaceHeader = request.headers[AGENT_DECK_WORKSPACE_HEADER];
        const workspaceRoot =
          (Array.isArray(workspaceHeader) ? workspaceHeader[0] : workspaceHeader)?.trim() ||
          undefined;
        const row = store.getRuntimeSessionRow(session.sessionId);
        const record = store.createDeckSwitchRequest({
          runtimeSessionId: session.sessionId,
          ...(row?.mcp_session_id ? { mcpSessionId: row.mcp_session_id } : {}),
          currentDeckId: session.deckId,
          requestedDeckId: requested.id,
          ...(workspaceRoot ? { workspaceRoot } : {}),
        });

        return reply.send({
          success: true,
          data: {
            requestId: record.requestId,
            status: record.status,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            currentDeckId: session.deckId,
            ...(current ? { currentDeckName: current.name } : {}),
            requestedDeckId: requested.id,
            requestedDeckName: requested.name,
            presentation: {
              kind: 'deck_switch_request',
              title: `Switch deck to "${requested.name}"?`,
              body: `Agent requested a switch from "${current?.name ?? session.deckId}" to "${requested.name}". The active deck is unchanged; a human decision is still required.`,
              status: record.status,
              expiresAt: record.expiresAt,
              channels: ['host-elicitation', 'browser'],
            },
          },
        });
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
    },
  );

  fastify.get<{ Params: { requestId: string } }>(
    '/deck-switch/:requestId',
    async (request, reply) => {
      try {
        const requestId = request.params.requestId?.trim();
        if (!requestId) {
          return reply.status(400).send({ success: false, error: 'requestId required' });
        }

        // NOT-207: opaque request inspection. Lazy expiry marks a past-TTL
        // request expired on read; bindings are never touched here.
        const record = store.getDeckSwitchRequest(requestId);
        if (!record) {
          return reply.status(404).send({ success: false, error: 'Deck-switch request not found' });
        }

        const principal = request.requestPrincipal;
        if (principal?.kind === 'agent' && principal.session.sessionId !== record.runtimeSessionId) {
          throw new TrustedAuthError(
            'RESOURCE_OUT_OF_SCOPE',
            'Deck-switch request belongs to a different session',
          );
        }

        if (principal?.kind !== 'dashboard') {
          return reply.send({
            success: true,
            data: {
              requestId: record.requestId,
              status: record.status,
              createdAt: record.createdAt,
              expiresAt: record.expiresAt,
            },
          });
        }

        const currentDeck = await fastify.db.getDeck(record.currentDeckId);
        const requestedDeck = await fastify.db.getDeck(record.requestedDeckId);
        return reply.send({
          success: true,
          data: {
            requestId: record.requestId,
            status: record.status,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            resolvedAt: record.resolvedAt,
            runtimeSessionId: record.runtimeSessionId,
            currentDeckId: record.currentDeckId,
            ...(currentDeck ? { currentDeckName: currentDeck.name } : {}),
            requestedDeckId: record.requestedDeckId,
            ...(requestedDeck ? { requestedDeckName: requestedDeck.name } : {}),
            ...(record.workspaceRoot ? { workspaceRoot: record.workspaceRoot } : {}),
          },
        });
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
    },
  );

  fastify.post<{ Params: { requestId: string } }>(
    '/deck-switch/:requestId/resolve',
    async (request, reply) => {
      try {
        const requestId = request.params.requestId?.trim();
        if (!requestId) {
          return reply.status(400).send({ success: false, error: 'requestId required' });
        }

        // Exactly three decisions exist; anything else is a 400.
        const parsed = DeckSwitchResolveBodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            success: false,
            error: parsed.error.issues.map((issue) => issue.message).join('; '),
          });
        }
        const { runtimeSessionId, decision } = parsed.data;

        // NOT-207: approval is the only commit point. Session rebind and
        // workspace-default assignment commit atomically inside the store;
        // every other outcome leaves both bindings unchanged.
        // Ownership check: the dashboard principal is intentionally not tied
        // to a runtime session (dashboard-only route per the policy registry),
        // so belonging is established by matching the body-supplied
        // runtimeSessionId against the request's owner. The request's
        // workspace is not compared; the stored workspaceRoot travels with
        // the request itself.
        //
        // NOT-318: approval never widens a grant. The allowlist is
        // re-checked at commit time (it may have narrowed since creation),
        // and a dead grant fails the approval closed.
        const grants = grantStoreOf(fastify);
        const sessionRow = store.getRuntimeSessionRow(runtimeSessionId.trim());
        const grantId = sessionRow?.grant_id ?? null;
        const grant = grantId && grants ? grants.getGrant(grantId) : null;
        if (grantId && grants) {
          if (
            !grant ||
            grant.revokedAt ||
            (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())
          ) {
            throw new TrustedAuthError('GRANT_REQUIRED', 'Grant expired or revoked');
          }
        }
        const result = store.applyDeckSwitchResolution(
          requestId,
          runtimeSessionId.trim(),
          decision,
          grant
            ? { isDeckAllowed: (deckId) => grant.allowedDecks.includes(deckId) }
            : undefined,
        );

        switch (result.outcome) {
          case 'not-found':
            return reply.status(404).send({ success: false, error: 'Deck-switch request not found' });
          case 'unauthorized':
            throw new TrustedAuthError(
              'RESOURCE_OUT_OF_SCOPE',
              'Deck-switch request belongs to a different session',
            );
          case 'expired':
            throw new TrustedAuthError('DECK_SWITCH_EXPIRED', 'Deck-switch request expired');
          case 'already-resolved':
            return reply.status(409).send({
              success: false,
              error: `Deck-switch request already resolved (status=${result.request.status})`,
              error_code: 'DECK_SWITCH_CONSUMED',
              status: result.request.status,
            });
          case 'target-missing':
            return reply.status(404).send({ success: false, error: 'Deck not found' });
          case 'out-of-scope':
            throw new TrustedAuthError(
              'RESOURCE_OUT_OF_SCOPE',
              "Deck is outside this grant's allowed decks",
            );
          case 'session-invalid':
            throw new TrustedAuthError('SESSION_INVALID', 'Runtime session absent or expired');
          case 'workspace-required':
            return reply.status(400).send({
              success: false,
              error: 'workspace-default requires a workspaceRoot on the request',
            });
          case 'assignment-failed':
            return reply.status(500).send({
              success: false,
              error: `Workspace assignment write failed: ${result.error}`,
            });
          case 'declined':
            return reply.send({
              success: true,
              data: { requestId, decision, status: 'declined' },
            });
          case 'resolved': {
            const deck = await fastify.db.getDeck(result.request.requestedDeckId);
            // NOT-233: the commit rebound the runtime session, but the
            // live-display entry the statusline reads still names the prior
            // deck. Refresh it to the newly-active deck (both session and
            // workspace-default decisions rebind the session) so the next
            // statusline render names it. Session-scope commits still leave
            // use.json untouched — only the in-memory live entry moves.
            const liveRegistry = fastify.liveDisplayRegistry as
              | LiveDisplayRegistry
              | undefined;
            if (deck && liveRegistry) {
              refreshLiveDisplayAfterDeckSwitch(liveRegistry, {
                mcpSessionId: result.request.mcpSessionId,
                deckId: deck.id,
                deckName: deck.name,
                cardCounts: countDeckCards(deck),
                ...(result.request.workspaceRoot
                  ? { workspaceRoot: result.request.workspaceRoot }
                  : {}),
                updatedAt: new Date().toISOString(),
              });
            }
            return reply.send({
              success: true,
              data: {
                requestId,
                decision,
                status: 'consumed',
                deckId: result.request.requestedDeckId,
                ...(deck ? { deckName: deck.name } : {}),
                ...(result.workspaceRoot ? { workspaceRoot: result.workspaceRoot } : {}),
              },
            });
          }
        }
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
    },
  );

  fastify.post<{ Body: { mcpSessionId: string } }>(
    '/mcp/disconnect-deck',
    async (request, reply) => {
      try {
        const mcpSessionId = request.body.mcpSessionId?.trim();
        if (!mcpSessionId) {
          return reply.status(400).send({ success: false, error: 'mcpSessionId required' });
        }

        const session = store.findActiveRuntimeSessionByMcpSessionId(mcpSessionId);
        if (session) {
          store.revokeRuntimeSession(session.sessionId);
        }

        return reply.send({ success: true, data: { revoked: Boolean(session) } });
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
    },
  );
}

export async function registerDashboardAuthRoutes(fastify: FastifyInstance) {
  const store = fastify.trustedSessionStore;

  const hostedCookie = (token: string, maxAgeSeconds: number) =>
    `${AGENT_DECK_DASHBOARD_COOKIE}=${encodeURIComponent(token)}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;

  // Authenticated dashboard capability discovery. The Grants navigation and
  // page use this rather than inferring deployment mode from the browser URL.
  fastify.get('/context', async (_request, reply) => {
    return reply.send({
      success: true,
      data: { hosted: process.env.AGENT_DECK_HOSTED_MODE === '1' },
    });
  });

  fastify.post<{
    Body: { owner?: unknown; credential?: unknown; bootstrapSecret?: unknown };
  }>('/sign-in', async (request, reply) => {
    if (process.env.AGENT_DECK_HOSTED_MODE !== '1') {
      return reply.status(404).send({ success: false, error: 'Not found' });
    }

    const owner = typeof request.body?.owner === 'string' ? request.body.owner : '';
    const credential =
      typeof request.body?.credential === 'string' ? request.body.credential : '';
    const bootstrapSecret =
      typeof request.body?.bootstrapSecret === 'string' ? request.body.bootstrapSecret : '';
    let authenticated = await fastify.ownerAuthProvider.authenticate({ owner, credential });
    if (!authenticated && bootstrapSecret) {
      await fastify.ownerAuthProvider.bootstrap({ owner, credential, bootstrapSecret });
      authenticated = await fastify.ownerAuthProvider.authenticate({ owner, credential });
    }
    if (!authenticated) {
      return reply.status(401).send({ success: false, error: 'Invalid owner credentials' });
    }

    const token = store.createDashboardSession({
      idleMs: HOSTED_DASHBOARD_IDLE_MS,
      absoluteMs: HOSTED_DASHBOARD_ABSOLUTE_MS,
    });
    reply.header(
      'Set-Cookie',
      hostedCookie(token, Math.floor(HOSTED_DASHBOARD_ABSOLUTE_MS / 1000)),
    );
    return reply.send({ success: true, data: { authenticated: true } });
  });

  fastify.post('/logout', async (request, reply) => {
    if (process.env.AGENT_DECK_HOSTED_MODE !== '1') {
      return reply.status(404).send({ success: false, error: 'Not found' });
    }
    const token = parseDashboardCookie(request);
    if (token) {
      store.revokeDashboardSession(token);
    }
    reply.header('Set-Cookie', hostedCookie('', 0));
    return reply.send({ success: true, data: { authenticated: false } });
  });

  fastify.post('/revoke-all', async (_request, reply) => {
    if (process.env.AGENT_DECK_HOSTED_MODE !== '1') {
      return reply.status(404).send({ success: false, error: 'Not found' });
    }
    store.revokeAllDashboardSessions();
    reply.header('Set-Cookie', hostedCookie('', 0));
    return reply.send({ success: true, data: { authenticated: false } });
  });

  fastify.post('/bootstrap/nonce', async (request, reply) => {
    try {
      await requireTrustedWriterBearer(request);

      const nonce = randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + DASHBOARD_NONCE_TTL_MS).toISOString();
      store.createDashboardNonce(nonce, expiresAt);

      return reply.send({ success: true, data: { nonce, expiresInMs: DASHBOARD_NONCE_TTL_MS } });
    } catch (error) {
      if (error instanceof TrustedAuthError) {
        return sendTrustedAuthError(reply, error);
      }
      throw error;
    }
  });

  fastify.post<{ Body: { nonce: string } }>('/bootstrap/session', async (request, reply) => {
    const { nonce } = request.body;
    if (!store.consumeDashboardNonce(nonce)) {
      return reply.status(410).send({ success: false, error: 'Bootstrap nonce expired or invalid' });
    }

    const token = store.createDashboardSession();
    // Secure omitted intentionally — dashboard is localhost-http in v1.
    reply.header(
      'Set-Cookie',
      `${AGENT_DECK_DASHBOARD_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(DASHBOARD_COOKIE_MAX_AGE_MS / 1000)}`,
    );

    return reply.send({ success: true, data: { authenticated: true } });
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    trustedSessionStore: TrustedSessionStore;
    ownerAuthProvider: OwnerAuthProvider;
  }
}
