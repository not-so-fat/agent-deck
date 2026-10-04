import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { parseDashboardCookie } from '../lib/dashboard-auth';

export const HOSTED_DASHBOARD_IDLE_MS = 12 * 60 * 60 * 1000;
export const HOSTED_DASHBOARD_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

export type HostedModeConfig = {
  enabled: boolean;
  publicOrigin?: string;
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

/** Hosted-mode owner gate. Registered before the legacy route-policy hook. */
export function registerHostedModeGuard(
  fastify: FastifyInstance,
  config: HostedModeConfig,
): void {
  if (!config.enabled) {
    return;
  }
  const publicOrigin = config.publicOrigin!;

  fastify.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (HOSTED_PUBLIC_ROUTES.has(`${request.method.toUpperCase()} ${pathname}`)) {
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
  });
}
