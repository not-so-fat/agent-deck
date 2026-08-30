import type { FastifyRequest } from 'fastify';

import { AGENT_DECK_DASHBOARD_COOKIE } from '@agent-deck/shared';

import { parseBearerToken } from '../lib/http-auth';
import { validateDashboardSessionToken } from '../trusted-session/auth';
import { readAdminSecretFromEnvOrFile, verifyAdminSecret } from '../trusted-session/admin-secret';

export { validateDashboardSessionToken };

export function parseDashboardCookie(request: FastifyRequest): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return null;
  }
  const prefix = `${AGENT_DECK_DASHBOARD_COOKIE}=`;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return null;
}

export function isDashboardAuthenticated(request: FastifyRequest): boolean {
  const token = parseDashboardCookie(request);
  return token !== null && validateDashboardSessionToken(token);
}

export async function isTrustedWriterBearer(request: FastifyRequest): Promise<boolean> {
  const bearer = parseBearerToken(request);
  if (!bearer) {
    return false;
  }
  const expected = await readAdminSecretFromEnvOrFile();
  return Boolean(expected && verifyAdminSecret(bearer, expected));
}
