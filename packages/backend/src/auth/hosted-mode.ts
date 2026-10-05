import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { parseDashboardCookie } from '../lib/dashboard-auth';
import { RequestLimiter } from './request-limiter';

export const HOSTED_DASHBOARD_IDLE_MS = 12 * 60 * 60 * 1000;
export const HOSTED_DASHBOARD_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const HOSTED_RATE_LIMIT_WINDOW_MS = 60_000;
export const HOSTED_SIGN_IN_FAILURE_LIMIT = 5;
export const HOSTED_PUBLIC_MUTATION_LIMIT = 60;
export const HOSTED_PUBLIC_BODY_LIMIT_BYTES = 1024 * 1024;

export type HostedModeConfig = {
  enabled: boolean;
  publicOrigin?: string;
  now?: () => number;
};

export function resolveHostedModeConfig(
  env: NodeJS.ProcessEnv = process.env,
): HostedModeConfig {
  if (env.AGENT_DECK_HOSTED_MODE !== '1') {
    return { enabled: false };
  }

  const rawPublicUrl = env.AGENT_DECK_PUBLIC_URL?.trim();
  if (!rawPublicUrl) {
    throw new Error('AGENT_DECK_PUBLIC_URL is required when AGENT_DECK_HOSTED_MODE=1');
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(rawPublicUrl);
  } catch {
    throw new Error('AGENT_DECK_PUBLIC_URL must be a valid HTTPS URL in hosted mode');
  }
  if (publicUrl.protocol !== 'https:') {
    throw new Error('AGENT_DECK_PUBLIC_URL must use HTTPS in hosted mode');
  }
  return { enabled: true, publicOrigin: publicUrl.origin };
}

const HOSTED_PUBLIC_ROUTES = new Set([
  'GET /health',
  'HEAD /health',
  'GET /healthz',
  'HEAD /healthz',
  'GET /readyz',
  'HEAD /readyz',
  'POST /api/dashboard-auth/sign-in',
]);

function sendSignInRequired(reply: FastifyReply): void {
  reply.status(401).send({ success: false, error: 'Sign-in required' });
}

function hasSameOrigin(request: FastifyRequest, publicOrigin: string): boolean {
  const origin = request.headers.origin;
  if (typeof origin === 'string') {
    try {
      return new URL(origin).origin === publicOrigin;
    } catch {
      return false;
    }
  }
  return request.headers['sec-fetch-site'] === 'same-origin';
}

function isStateChanging(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function socketClientKey(request: FastifyRequest): string {
  return `ip:${request.raw.socket.remoteAddress ?? 'unknown'}`;
}

function rateLimitClientKey(
  request: FastifyRequest,
  fastify: FastifyInstance,
  now: () => number,
): string {
  const rawSessionId = request.headers[AGENT_DECK_SESSION_HEADER];
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
  if (sessionId) {
    const row = fastify.trustedSessionStore.getRuntimeSessionRow(sessionId);
    if (
      row?.grant_id &&
      !row.revoked_at &&
      Date.parse(row.expires_at) > now()
    ) {
      return `grant:${row.grant_id}`;
    }
  }
  return socketClientKey(request);
}

function sendRateLimited(reply: FastifyReply, retryAfterSeconds: number): void {
  reply
    .header('Retry-After', String(retryAfterSeconds))
    .status(429)
    .send({ success: false, error: 'Too many requests' });
}

/** Hosted-mode owner gate. Registered before the legacy route-policy hook. */
export function registerHostedModeGuard(
  fastify: FastifyInstance,
  config: HostedModeConfig,
): void {
  if (!config.enabled) {
    return;
  }
  const publicOrigin = config.publicOrigin!;
  const now = config.now ?? Date.now;
  const limiter = new RequestLimiter(HOSTED_RATE_LIMIT_WINDOW_MS, now);

  fastify.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    const routeKey = `${request.method.toUpperCase()} ${pathname}`;

    if (isStateChanging(request.method) && pathname.startsWith('/api/')) {
      const rawLength = request.headers['content-length'];
      const contentLength = typeof rawLength === 'string' ? Number(rawLength) : 0;
      if (Number.isFinite(contentLength) && contentLength > HOSTED_PUBLIC_BODY_LIMIT_BYTES) {
        return reply.status(413).send({ success: false, error: 'Request body too large' });
      }
    }

    if (routeKey === 'POST /api/dashboard-auth/sign-in') {
      const result = limiter.check(`sign-in:${socketClientKey(request)}`, HOSTED_SIGN_IN_FAILURE_LIMIT);
      if (!result.allowed) {
        return sendRateLimited(reply, result.retryAfterSeconds);
      }
      return;
    }
    if (HOSTED_PUBLIC_ROUTES.has(routeKey)) {
      return;
    }

    const token = parseDashboardCookie(request);
    if (
      !token ||
      !fastify.trustedSessionStore.validateAndTouchDashboardSession(
        token,
        HOSTED_DASHBOARD_IDLE_MS,
      )
    ) {
      return sendSignInRequired(reply);
    }

    if (isStateChanging(request.method) && !hasSameOrigin(request, publicOrigin)) {
      return reply.status(403).send({ success: false, error: 'Cross-site request rejected' });
    }

    if (isStateChanging(request.method)) {
      const result = limiter.consume(
        `mutation:${rateLimitClientKey(request, fastify, now)}`,
        HOSTED_PUBLIC_MUTATION_LIMIT,
      );
      if (!result.allowed) {
        return sendRateLimited(reply, result.retryAfterSeconds);
      }
    }
  });

  fastify.addHook('onSend', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (
      request.method.toUpperCase() === 'POST' &&
      pathname === '/api/dashboard-auth/sign-in' &&
      reply.statusCode === 401
    ) {
      limiter.consume(`sign-in:${socketClientKey(request)}`, HOSTED_SIGN_IN_FAILURE_LIMIT);
    }
  });
}
