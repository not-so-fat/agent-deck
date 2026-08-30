import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENT_DECK_DASHBOARD_COOKIE,
  DASHBOARD_NONCE_TTL_MS,
  canonicalizeWorkspacePath,
  digestCanonicalWorkspacePath,
} from '@agent-deck/shared';

import {
  createDashboardSessionToken,
  sendTrustedAuthError,
  TrustedAuthError,
} from '../trusted-session/auth';
import { readAdminSecretFromEnvOrFile, verifyAdminSecret } from '../trusted-session/admin-secret';
import { parseDashboardCookie, validateDashboardSessionToken } from '../lib/dashboard-auth';
import type { TrustedSessionStore } from '../trusted-session/store';
import { generateGrantSecret } from '../trusted-session/store';

const dashboardNonces = new Map<string, number>();

function parseBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice('Bearer '.length).trim() || null;
}

export async function registerTrustedSessionRoutes(fastify: FastifyInstance) {
  const store = fastify.trustedSessionStore;

  fastify.post<{ Body: { workspaceRoot: string; deckId: string } }>(
    '/workspace-grants/issue',
    async (request, reply) => {
      try {
        const bearer = parseBearerToken(request);
        const expected = await readAdminSecretFromEnvOrFile();
        if (!bearer || !expected || !verifyAdminSecret(bearer, expected)) {
          throw new TrustedAuthError('DASHBOARD_REQUIRED', 'Trusted writer authentication required');
        }

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
        const activated = store.activateGrant(pending.id);

        return reply.send({
          success: true,
          data: {
            workspaceKey: workspaceKey.id,
            grantId: pending.id,
            deckId,
            deckName: deck.name,
            secret,
            status: activated?.status ?? 'pending',
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
      const { runtimeSessionId } = request.body;
      if (!runtimeSessionId?.trim()) {
        return reply.status(400).send({ success: false, error: 'runtimeSessionId required' });
      }

      const downgraded = store.downgradeSessionToNormal(runtimeSessionId);
      if (!downgraded) {
        return reply.status(404).send({ success: false, error: 'Session not found' });
      }

      return reply.send({ success: true, data: { session: downgraded } });
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

        const session = store.createRuntimeSession({
          workspaceKeyId: grant.workspace_key_id,
          workspaceGrantId: grant.id,
          deckId: grant.deck_id,
          mcpSessionId,
        });

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
  fastify.post('/bootstrap/nonce', async (request, reply) => {
    const bearer = parseBearerToken(request);
    const expected = await readAdminSecretFromEnvOrFile();
    if (!bearer || !expected || !verifyAdminSecret(bearer, expected)) {
      return sendTrustedAuthError(
        reply,
        new TrustedAuthError('DASHBOARD_REQUIRED', 'Dashboard bootstrap authentication required'),
      );
    }

    const nonce = randomBytes(24).toString('base64url');
    dashboardNonces.set(nonce, Date.now() + DASHBOARD_NONCE_TTL_MS);

    return reply.send({ success: true, data: { nonce, expiresInMs: DASHBOARD_NONCE_TTL_MS } });
  });

  fastify.post<{ Body: { nonce: string } }>('/bootstrap/session', async (request, reply) => {
    const { nonce } = request.body;
    const expiresAt = dashboardNonces.get(nonce);
    dashboardNonces.delete(nonce);

    if (!expiresAt || expiresAt <= Date.now()) {
      return reply.status(410).send({ success: false, error: 'Bootstrap nonce expired or invalid' });
    }

    const token = createDashboardSessionToken();
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
