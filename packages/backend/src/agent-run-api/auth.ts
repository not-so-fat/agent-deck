import type { FastifyInstance, FastifyRequest } from 'fastify';

import { AgentRunIdSchema } from '@agent-deck/shared';

import type { AuditActor, AuditReasonCode } from '../audit/store';
import type { GrantPrincipal } from '../auth/client-grants';
import { parseBearerToken } from '../lib/http-auth';
import { TrustedAuthError } from '../trusted-session/auth';

/** Actor for a request whose bearer did not authenticate (no oracle, no forged id). */
export const UNAUTHENTICATED_RUN_ACTOR: AuditActor = 'ag_unknown';

/**
 * Audit target for a run route: the run id when the path carries a
 * well-formed one, `agent-runs` for the collection. Never echoes an
 * untrusted path segment.
 */
export function auditRunTarget(pathname: string): string {
  const match = /^\/api\/agent-runs\/([^/]+)/.exec(pathname);
  if (!match) {
    return 'agent-runs';
  }
  return AgentRunIdSchema.safeParse(match[1]).success ? match[1] : 'invalid-run-id';
}

/**
 * NOT-480: authenticate an agent-run route. The caller must present an
 * `adg_` grant bearer that is live (not revoked or expired) and explicitly
 * run-enabled; MCP-only grants never gain model-spend or filesystem
 * authority. Every unauthenticated case returns the same 401. Deck scope is
 * checked per run by the route, because the deck lives in the body or the
 * run record.
 */
export function authenticateRunGrant(
  request: FastifyRequest,
  fastify: FastifyInstance,
): GrantPrincipal | TrustedAuthError {
  const bearer = parseBearerToken(request);
  const grant = bearer ? fastify.grantStore?.authenticateToken(bearer) ?? null : null;
  const target = auditRunTarget(request.url.split('?')[0]);
  const deny = (actor: AuditActor, reasonCode: AuditReasonCode): void => {
    fastify.auditStore?.append({
      actor,
      event: 'agent_run.denied',
      targetId: target,
      outcome: 'denied',
      reasonCode,
    });
  };
  if (!grant) {
    deny(UNAUTHENTICATED_RUN_ACTOR, 'invalid_credentials');
    return new TrustedAuthError('GRANT_REQUIRED', 'A valid agent grant bearer token is required');
  }
  if (!grant.runsEnabled) {
    deny(grant.grantId as AuditActor, 'run_capability_required');
    return new TrustedAuthError('RUN_CAPABILITY_REQUIRED', 'This grant is not enabled for agent runs');
  }
  return grant;
}
