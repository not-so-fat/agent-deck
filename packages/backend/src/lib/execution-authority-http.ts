import type { FastifyRequest } from 'fastify';

import { BoundDeckScopeError } from './bound-deck-scope';

/**
 * HTTP routes an execution-authority principal may use (worker-facing reads + tool call).
 * Everything else is control-plane / out of containment → INTERACTION_REQUIRED.
 */
const ALLOWED: Array<{ methods: string[]; pattern: RegExp }> = [
  { methods: ['GET'], pattern: /^\/api\/scope\/deck$/ },
  { methods: ['POST'], pattern: /^\/api\/scope\/live-display$/ },
  { methods: ['DELETE'], pattern: /^\/api\/scope\/live-display\/[^/]+$/ },
  { methods: ['POST'], pattern: /^\/api\/scope\/live-display\/[^/]+\/touch$/ },
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

/** Enforce minted tool snapshot on service tool calls. No-op for other principals. */
export function requireAuthorityToolAllowed(
  request: FastifyRequest,
  serviceId: string,
  toolName: string,
): void {
  const principal = request.requestPrincipal;
  if (principal?.kind !== 'execution-authority') {
    return;
  }
  const authority = principal.authority;
  const serviceOk = authority.allowedServices.includes(serviceId);
  const toolOk = authority.allowedTools.some(
    (t) => t.serviceId === serviceId && t.toolName === toolName,
  );
  if (!serviceOk || !toolOk) {
    throw new BoundDeckScopeError(
      'Tool not in authority snapshot',
      'RESOURCE_OUT_OF_SCOPE',
    );
  }
}
