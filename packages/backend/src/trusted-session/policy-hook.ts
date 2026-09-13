import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { trustedSessionError } from '@agent-deck/shared';

import { parseAuthorityBearer } from '../execution-authority/bearer';
import { parseBearerToken } from '../lib/http-auth';
import {
  AuthorityContractAuthError,
  isExecutionAuthorityHttpAllowed,
  sendContractError,
} from '../lib/execution-authority-http';
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

    // NOT-86: authority bearers get INTERACTION_REQUIRED before dashboard/admin/trusted-writer
    // policy branches (those would otherwise return DASHBOARD_REQUIRED / GRANT_REQUIRED).
    const bearer = parseBearerToken(request);
    const authorityCreds = bearer ? parseAuthorityBearer(bearer) : null;
    if (authorityCreds && fastify.executionAuthorityStore) {
      const auth = fastify.executionAuthorityStore.authenticateAuthority(
        authorityCreds.authorityId,
        authorityCreds.secret,
      );
      if (!auth.ok) {
        return sendContractError(reply, auth);
      }
      request.requestPrincipal = { kind: 'execution-authority', authority: auth.data };

      if (policy === 'allowPublic') {
        // Issuer routes (connect / authorize-call) authenticate again in-handler.
        return;
      }

      if (!isExecutionAuthorityHttpAllowed(request.method, pathname)) {
        return sendContractError(reply, {
          ok: false,
          error_code: 'INTERACTION_REQUIRED',
          message: 'Control-plane decision required; do not hold the worker',
          correlation: { authorityId: auth.data.authorityId },
        });
      }
      return;
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
    } catch (error) {
      if (error instanceof AuthorityContractAuthError) {
        return sendContractError(reply, error.contract);
      }
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
