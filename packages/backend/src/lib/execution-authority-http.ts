import type { FastifyReply, FastifyRequest } from 'fastify';

import { parseBearerToken } from './http-auth';
import { parseAuthorityBearer } from '../execution-authority/bearer';
import type { ContractError } from '../execution-authority/types';
import type { ExecutionAuthorityStore } from '../execution-authority/store';

/**
 * HTTP routes an execution-authority principal may use (worker-facing reads + tool call).
 * Live-display is intentionally excluded — unattended workers must not mutate global
 * session display state (NOT-86 containment).
 * Everything else is control-plane / out of containment → INTERACTION_REQUIRED.
 */
const ALLOWED: Array<{ methods: string[]; pattern: RegExp }> = [
  { methods: ['GET'], pattern: /^\/api\/scope\/deck$/ },
  { methods: ['GET'], pattern: /^\/api\/decks\/[^/]+$/ },
  { methods: ['GET'], pattern: /^\/api\/decks\/[^/]+\/services$/ },
  { methods: ['GET'], pattern: /^\/api\/services\/[^/]+$/ },
  { methods: ['GET'], pattern: /^\/api\/services\/[^/]+\/tools$/ },
  { methods: ['POST'], pattern: /^\/api\/services\/[^/]+\/call$/ },
  { methods: ['GET'], pattern: /^\/api\/playbooks\/[^/]+$/ },
  { methods: ['GET'], pattern: /^\/api\/playbooks$/ },
  { methods: ['GET'], pattern: /^\/api\/playbooks\/summaries$/ },
  { methods: ['GET'], pattern: /^\/api\/credentials\/[^/]+$/ },
];

export function isExecutionAuthorityHttpAllowed(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return ALLOWED.some((rule) => rule.methods.includes(m) && rule.pattern.test(pathname));
}

/** Contract-shaped auth/containment failure for execution-authority principals. */
export class AuthorityContractAuthError extends Error {
  constructor(public readonly contract: ContractError) {
    super(contract.message);
    this.name = 'AuthorityContractAuthError';
  }
}

export function statusForContract(error: ContractError): number {
  switch (error.error_code) {
    case 'COORDINATOR_NOT_ENROLLED':
    case 'AUTHORITY_UNKNOWN':
      return 404;
    case 'INVALID_MINT_REQUEST':
    case 'IDEMPOTENCY_KEY_CONFLICT':
      return 400;
    case 'AUTHORITY_SECRET_INVALID':
      return 401;
    default:
      return 403;
  }
}

export function sendContractError(
  reply: FastifyReply,
  error: ContractError,
  status = statusForContract(error),
) {
  return reply.status(status).send(error);
}

/**
 * Authorize one service tool call via the ledger (audience + audit).
 * No-op for non-authority principals.
 */
export function authorizeAuthorityServiceCall(
  request: FastifyRequest,
  store: ExecutionAuthorityStore,
  serviceId: string,
  toolName: string,
): void {
  const principal = request.requestPrincipal;
  if (principal?.kind !== 'execution-authority') {
    return;
  }

  const bearer = parseBearerToken(request);
  const creds = bearer ? parseAuthorityBearer(bearer) : null;
  if (!creds) {
    throw new AuthorityContractAuthError({
      ok: false,
      error_code: 'AUTHORITY_SECRET_INVALID',
      message: 'Invalid authority secret',
      correlation: { authorityId: principal.authority.authorityId },
    });
  }

  const result = store.invokeAuthorizedCall({
    authorityId: creds.authorityId,
    authoritySecret: creds.secret,
    audience: principal.authority.audience,
    serviceId,
    toolName,
  });
  if (!result.ok) {
    throw new AuthorityContractAuthError(result);
  }
}

/** Filter discovered tools to the minted authority snapshot. */
export function filterToolsForAuthority(
  request: FastifyRequest,
  serviceId: string,
  tools: Array<{ name: string }>,
): Array<{ name: string }> {
  const principal = request.requestPrincipal;
  if (principal?.kind !== 'execution-authority') {
    return tools;
  }
  const allowed = new Set(
    principal.authority.allowedTools
      .filter((t) => t.serviceId === serviceId)
      .map((t) => t.toolName),
  );
  return tools.filter((t) => allowed.has(t.name));
}
