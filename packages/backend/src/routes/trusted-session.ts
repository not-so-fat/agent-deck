import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DeckSwitchResolveBodySchema,
  type RuntimeSession,
} from '@agent-deck/shared';
import {
  AGENT_DECK_DASHBOARD_COOKIE,
  AGENT_DECK_SESSION_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
  DASHBOARD_NONCE_TTL_MS,
  DASHBOARD_COOKIE_MAX_AGE_MS,
} from '@agent-deck/shared';

import { resolveDeckRef } from '../lib/deck-resolve';
import { parseBearerToken } from '../lib/http-auth';
import {
  requireTrustedWriterBearer,
  sendTrustedAuthError,
  TrustedAuthError,
} from '../trusted-session/auth';
import { isDashboardAuthenticated } from '../lib/dashboard-auth';
import type { TrustedSessionStore } from '../trusted-session/store';
import { readAdminSecretFromEnvOrFile, verifyAdminSecret } from '../trusted-session/admin-secret';

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

  fastify.post<{ Body: { deckId: string; mcpSessionId?: string } }>(
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
        const result = store.applyDeckSwitchResolution(
          requestId,
          runtimeSessionId.trim(),
          decision,
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
  }
}
