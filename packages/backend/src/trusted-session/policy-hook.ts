import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { trustedSessionError } from '@agent-deck/shared';

import { isExecutionAuthorityHttpAllowed } from '../lib/execution-authority-http';
import {
  enforcePolicy,
  requireTrustedWriterBearer,
  resolveRequestPrincipal,
  sendTrustedAuthError,
  TrustedAuthError,
  type RequestPrincipal,
} from './auth';
import {
  findUnmatchedRoutes,
  resolveRoutePolicy,
  shouldApplyHttpPolicy,
  type RegisteredRoute,
} from './route-policy-registry';

declare module 'fastify' {
  interface FastifyRequest {
    requestPrincipal?: RequestPrincipal;
  }
}

export const registeredHttpRoutes: RegisteredRoute[] = [];

export function registerHttpPolicyHook(fastify: FastifyInstance): void {
  registeredHttpRoutes.length = 0;

  fastify.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      registeredHttpRoutes.push({
        method: String(method).toUpperCase(),
        url: routeOptions.url,
      });
    }
  });

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = request.url.split('?')[0];
    if (!shouldApplyHttpPolicy(pathname)) {
      return;
    }
    if (request.method === 'HEAD') {
      return;
    }

    const policy = resolveRoutePolicy(request.method, pathname);
    if (!policy) {
      return sendTrustedAuthError(
        reply,
        new TrustedAuthError('DASHBOARD_REQUIRED', `No authorization policy for ${request.method} ${pathname}`),
      );
    }

    if (policy === 'allowPublic') {
      request.requestPrincipal = { kind: 'public' };
      return;
    }

    if (policy === 'requireTrustedWriter') {
      try {
        await requireTrustedWriterBearer(request);
        request.requestPrincipal = { kind: 'dashboard' };
      } catch (error) {
        if (error instanceof TrustedAuthError) {
          return sendTrustedAuthError(reply, error);
        }
        throw error;
      }
      return;
    }

    try {
      const principal = await resolveRequestPrincipal(
        request,
        fastify.trustedSessionStore,
        fastify.executionAuthorityStore,
      );
      enforcePolicy(policy, principal);
      request.requestPrincipal = principal;

      // NOT-86: authority bearers must not inherit full agent HTTP surface.
      if (
        principal.kind === 'execution-authority' &&
        !isExecutionAuthorityHttpAllowed(request.method, pathname)
      ) {
        const body = trustedSessionError(
          'INTERACTION_REQUIRED',
          'Control-plane decision required; do not hold the worker',
        );
        return reply.status(403).send({ ...body, ok: false });
      }
    } catch (error) {
      if (error instanceof TrustedAuthError) {
        return sendTrustedAuthError(reply, error);
      }
      throw error;
    }
  });
}

export function assertAllRoutesHavePolicies(routes: RegisteredRoute[] = registeredHttpRoutes): void {
  const unmatched = findUnmatchedRoutes(routes);
  if (unmatched.length > 0) {
    const lines = unmatched.map((route) => `${route.method} ${route.url}`).join('\n');
    throw new Error(`HTTP routes missing authorization policy:\n${lines}`);
  }
}
