import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RuntimeSession } from '@agent-deck/shared';
import {
  AGENT_DECK_DASHBOARD_COOKIE,
  AGENT_DECK_SESSION_HEADER,
  DASHBOARD_NONCE_TTL_MS,
  canonicalizeWorkspacePath,
  digestCanonicalWorkspacePath,
} from '@agent-deck/shared';

import { parseBearerToken } from '../lib/http-auth';
import {
  createDashboardSessionToken,
  sendTrustedAuthError,
  TrustedAuthError,
} from '../trusted-session/auth';
import { readAdminSecretFromEnvOrFile, verifyAdminSecret } from '../trusted-session/admin-secret';
import { parseDashboardCookie, validateDashboardSessionToken } from '../lib/dashboard-auth';
import type { TrustedSessionStore } from '../trusted-session/store';
import { generateGrantSecret } from '../trusted-session/store';

async function requireTrustedWriterBearer(request: FastifyRequest): Promise<void> {
  const bearer = parseBearerToken(request);
  const expected = await readAdminSecretFromEnvOrFile();
  if (!bearer || !expected || !verifyAdminSecret(bearer, expected)) {
    throw new TrustedAuthError('DASHBOARD_REQUIRED', 'Trusted writer authentication required');
  }
}

/** Caller must own the runtime session (session header matches body id). */
function requireRuntimeSessionOwnership(request: FastifyRequest, runtimeSessionId: string): void {
  const header = request.headers[AGENT_DECK_SESSION_HEADER];
  const sessionHeader = typeof header === 'string' ? header.trim() : '';
  if (!sessionHeader || sessionHeader !== runtimeSessionId.trim()) {
    throw new TrustedAuthError('GRANT_REQUIRED', 'Runtime session ownership required');
  }
}

function assertWorkspaceScope(
  store: TrustedSessionStore,
  workspaceKeyId: string,
  workspaceRoot: string,
): void {
  const key = store.getWorkspaceKeyById(workspaceKeyId);
  if (!key) {
    throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
  }
  const digest = digestCanonicalWorkspacePath(canonicalizeWorkspacePath(workspaceRoot));
  if (key.path_digest !== digest) {
    throw new TrustedAuthError(
      'WORKSPACE_SCOPE_MISMATCH',
      'Request targets a different workspace; elevation cannot override it',
    );
  }
}

function resolveRuntimeSessionFromHeader(
  request: FastifyRequest,
  store: TrustedSessionStore,
): RuntimeSession {
  const sessionHeader = request.headers[AGENT_DECK_SESSION_HEADER];
  const sessionId = typeof sessionHeader === 'string' ? sessionHeader.trim() : '';
  if (!sessionId) {
    throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
  }
  const row = store.getRuntimeSessionRow(sessionId);
  if (!row || row.revoked_at) {
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

export async function registerTrustedSessionRoutes(fastify: FastifyInstance) {
  const store = fastify.trustedSessionStore;

  fastify.post<{ Body: { workspaceRoot: string; deckId: string } }>(
    '/workspace-grants/issue',
    async (request, reply) => {
      try {
        await requireTrustedWriterBearer(request);

        const { workspaceRoot, deckId } = request.body;
        if (!workspaceRoot?.trim() || !deckId?.trim()) {
          return reply.status(400).send({ success: false, error: 'workspaceRoot and deckId required' });
        }

        const deck = await fastify.db.getDeck(deckId);
        if (!deck) {
          return reply.status(404).send({ success: false, error: 'Deck not found' });
        }

        const canonical = canonicalizeWorkspacePath(workspaceRoot);
        const digest = digestCanonicalWorkspacePath(canonical);
        const workspaceKey = store.getOrCreateWorkspaceKey(digest);
        const secret = generateGrantSecret();
        const pending = store.createPendingGrant(workspaceKey.id, deckId, secret);

        return reply.send({
          success: true,
          data: {
            workspaceKey: workspaceKey.id,
            grantId: pending.id,
            deckId,
            deckName: deck.name,
            secret,
            status: 'pending' as const,
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

  fastify.post<{ Params: { grantId: string } }>(
    '/workspace-grants/:grantId/revoke-pending',
    async (request, reply) => {
      try {
        await requireTrustedWriterBearer(request);
        store.revokePendingGrant(request.params.grantId);
        return reply.send({ success: true });
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
    },
  );

  fastify.post<{ Params: { grantId: string } }>(
    '/workspace-grants/:grantId/activate',
    async (request, reply) => {
      try {
        await requireTrustedWriterBearer(request);

        const { grantId } = request.params;
        const activated = store.activateGrant(grantId);
        if (!activated) {
          return reply.status(409).send({
            success: false,
            error: 'Grant not pending or not found',
          });
        }

        const deck = await fastify.db.getDeck(activated.deck_id);

        return reply.send({
          success: true,
          data: {
            grantId: activated.id,
            deckId: activated.deck_id,
            deckName: deck?.name,
            status: activated.status,
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

  fastify.get('/runtime-session', async (request, reply) => {
    try {
      const sessionHeader = request.headers[AGENT_DECK_SESSION_HEADER];
      const sessionId = typeof sessionHeader === 'string' ? sessionHeader.trim() : '';
      if (!sessionId) {
        throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
      }

      const row = store.getRuntimeSessionRow(sessionId);
      if (!row || row.revoked_at) {
        throw new TrustedAuthError('SESSION_REVOKED', 'Grant rotation or explicit revocation ended the session');
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

  fastify.post<{ Body: { workspaceRoot: string; deckId: string } }>(
    '/bind-workspace',
    async (request, reply) => {
      try {
        const { workspaceRoot, deckId } = request.body;
        if (!workspaceRoot?.trim() || !deckId?.trim()) {
          return reply.status(400).send({ success: false, error: 'workspaceRoot and deckId required' });
        }

        const session = resolveRuntimeSessionFromHeader(request, store);
        assertWorkspaceScope(store, session.workspaceKey, workspaceRoot);

        const deck = await fastify.db.getDeck(deckId);
        if (!deck) {
          return reply.status(404).send({ success: false, error: 'Deck not found' });
        }

        if (session.deckId === deckId) {
          return reply.send({
            success: true,
            data: {
              deckId: session.deckId,
              deckName: deck.name,
              mode: session.mode,
              grantRotated: false,
              peersRevoked: 0,
            },
          });
        }

        if (session.mode !== 'agent-admin') {
          throw new TrustedAuthError('ADMIN_REQUIRED', 'Deck-admin elevation is required');
        }

        const workspaceCount = store.countWorkspacesForDeck(session.deckId);
        const rotated = store.rotateGrantForElevatedSession(session.sessionId, deckId);
        if (!rotated) {
          throw new TrustedAuthError('SESSION_INVALID', 'Runtime session absent or expired');
        }

        const newDeck = await fastify.db.getDeck(rotated.session.deckId);

        return reply.send({
          success: true,
          data: {
            deckId: rotated.session.deckId,
            deckName: newDeck?.name ?? deck.name,
            mode: rotated.session.mode,
            grantRotated: true,
            peersRevoked: rotated.peersRevoked,
            previousDeckWorkspaceCount: workspaceCount,
            grantRefreshNote:
              'Run `agent-deck use <deck>` in this workspace to refresh the local grant file before the next MCP reconnect.',
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
          const token = parseDashboardCookie(request);
          if (!token || !validateDashboardSessionToken(token)) {
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

  fastify.post<{ Body: { grantSecret: string; mcpSessionId?: string } }>(
    '/mcp/connect',
    async (request, reply) => {
      try {
        const { grantSecret, mcpSessionId } = request.body;
        if (!grantSecret?.trim()) {
          throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
        }

        const grant = store.findActiveGrantBySecret(grantSecret);
        if (!grant) {
          throw new TrustedAuthError('GRANT_REQUIRED', 'No valid workspace grant');
        }

        let session;
        if (mcpSessionId?.trim()) {
          session = store.findActiveRuntimeSessionForMcp(mcpSessionId.trim(), grant.id);
        }
        if (!session) {
          session = store.createRuntimeSession({
            workspaceKeyId: grant.workspace_key_id,
            workspaceGrantId: grant.id,
            deckId: grant.deck_id,
            mcpSessionId: mcpSessionId?.trim(),
          });
        }

        const deck = await fastify.db.getDeck(session.deckId);

        return reply.send({
          success: true,
          data: {
            sessionId: session.sessionId,
            workspaceKey: session.workspaceKey,
            deckId: session.deckId,
            deckName: deck?.name,
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

    const token = createDashboardSessionToken();
    // Secure omitted intentionally — dashboard is localhost-http in v1.
    reply.header(
      'Set-Cookie',
      `${AGENT_DECK_DASHBOARD_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`,
    );

    return reply.send({ success: true, data: { authenticated: true } });
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    trustedSessionStore: TrustedSessionStore;
  }
}
