import type { FastifyPluginAsync } from 'fastify';

import { parseBearerToken } from '../lib/http-auth';
import { requireTrustedWriterBearer, TrustedAuthError, sendTrustedAuthError } from '../trusted-session/auth';
import { parseAuthorityBearer, parseEnrollmentBearer } from '../execution-authority/bearer';
import type { AllowedTool, ContractError, MintAuthorityRequest } from '../execution-authority/types';
import { sendContractError, statusForContract } from '../lib/execution-authority-http';

export class EnrollmentAuthError extends Error {
  constructor(public readonly contract: ContractError) {
    super(contract.message);
    this.name = 'EnrollmentAuthError';
  }
}

function intersectTools(policy: AllowedTool[], hint: AllowedTool[] | undefined): AllowedTool[] {
  if (hint === undefined) return policy;
  const key = (t: AllowedTool) => `${t.serviceId}\0${t.toolName}`;
  const allowed = new Set(policy.map(key));
  return hint.filter((t) => allowed.has(key(t)));
}

type EnrollmentRecord = {
  enrollmentId: string;
  status: string;
  allowedDeckIds: string[];
};

type EnrollmentStore = {
  getEnrollment: (id: string) => EnrollmentRecord | undefined;
  verifyEnrollmentSecret: (id: string, secret: string) => boolean;
};

type EnrollmentAuthOk = {
  ok: true;
  enrollmentId: string;
  enrollment: EnrollmentRecord;
};

type EnrollmentAuthFail = { ok: false; contract: ContractError };

function requireEnrollmentAuth(
  request: { headers: Record<string, unknown> },
  store: EnrollmentStore,
): { enrollmentId: string } {
  const token = parseBearerToken({ headers: request.headers });
  if (!token) {
    throw new EnrollmentAuthError({
      ok: false,
      error_code: 'COORDINATOR_NOT_ENROLLED',
      message: 'Enrollment bearer required (enr_…:secret)',
    });
  }
  const parsed = parseEnrollmentBearer(token);
  if (!parsed) {
    throw new EnrollmentAuthError({
      ok: false,
      error_code: 'COORDINATOR_NOT_ENROLLED',
      message: 'Enrollment bearer required (enr_…:secret)',
    });
  }
  const enrollment = store.getEnrollment(parsed.enrollmentId);
  if (!enrollment) {
    throw new EnrollmentAuthError({
      ok: false,
      error_code: 'COORDINATOR_NOT_ENROLLED',
      message: 'Unknown enrollment',
      correlation: { enrollmentId: parsed.enrollmentId },
    });
  }
  if (enrollment.status !== 'active') {
    throw new EnrollmentAuthError({
      ok: false,
      error_code: 'ENROLLMENT_REVOKED',
      message: 'Enrollment is revoked',
      reason: 'enrollment_revoked',
      correlation: { enrollmentId: parsed.enrollmentId },
    });
  }
  if (!store.verifyEnrollmentSecret(parsed.enrollmentId, parsed.secret)) {
    throw new EnrollmentAuthError({
      ok: false,
      error_code: 'COORDINATOR_NOT_ENROLLED',
      message: 'Invalid enrollment secret',
      correlation: { enrollmentId: parsed.enrollmentId },
    });
  }
  return { enrollmentId: parsed.enrollmentId };
}

/** Shared enrollment bearer resolve used by coordinator metadata + mint routes. */
function resolveEnrollmentAuth(
  request: { headers: Record<string, unknown> },
  store: EnrollmentStore,
): EnrollmentAuthOk | EnrollmentAuthFail {
  try {
    const { enrollmentId } = requireEnrollmentAuth(request, store);
    const enrollment = store.getEnrollment(enrollmentId);
    if (!enrollment) {
      return {
        ok: false,
        contract: {
          ok: false,
          error_code: 'COORDINATOR_NOT_ENROLLED',
          message: 'Unknown enrollment',
          correlation: { enrollmentId },
        },
      };
    }
    return { ok: true, enrollmentId, enrollment };
  } catch (error) {
    if (error instanceof EnrollmentAuthError) {
      return { ok: false, contract: error.contract };
    }
    throw error;
  }
}

function deckNotPermittedError(enrollmentId: string, deckId: string): ContractError {
  return {
    ok: false,
    error_code: 'RESOURCE_OUT_OF_SCOPE',
    message: 'Deck is not in allowedDeckIds',
    reason: 'deck_not_permitted',
    correlation: { enrollmentId, deckId },
  };
}

function deckNotFoundError(enrollmentId: string, deckId: string): ContractError {
  return {
    ok: false,
    error_code: 'RESOURCE_OUT_OF_SCOPE',
    message: 'Deck not found',
    reason: 'deck_not_found',
    correlation: { enrollmentId, deckId },
  };
}

/**
 * Fastify decodes path params, so `/decks/x%2Fy/playbooks` yields `deckId === "x/y"`
 * while the route-policy `[^/]+` still matched one encoded segment. Reject before scope checks.
 */
function invalidDeckIdPathSegment(deckId: string): ContractError | null {
  if (!deckId.includes('/')) return null;
  return {
    ok: false,
    error_code: 'INVALID_MINT_REQUEST',
    message: 'deckId must be a single path segment',
    correlation: { deckId },
  };
}

/** Re-check enrollment after awaits so revoke cannot race a successful response. */
function revalidateActiveEnrollment(
  store: EnrollmentStore,
  enrollmentId: string,
  deckId?: string,
): ContractError | null {
  const enrollment = store.getEnrollment(enrollmentId);
  if (!enrollment || enrollment.status !== 'active') {
    return {
      ok: false,
      error_code: 'ENROLLMENT_REVOKED',
      message: 'Enrollment is revoked',
      reason: 'enrollment_revoked',
      correlation: { enrollmentId },
    };
  }
  if (deckId !== undefined && !enrollment.allowedDeckIds.includes(deckId)) {
    return deckNotPermittedError(enrollmentId, deckId);
  }
  return null;
}

type AuthzPrincipal =
  | { kind: 'enrollment'; enrollmentId: string }
  | { kind: 'trusted-writer' };

async function requireEnrollmentOrTrustedWriter(
  request: Parameters<typeof requireTrustedWriterBearer>[0] & { headers: Record<string, unknown> },
  store: EnrollmentStore,
): Promise<AuthzPrincipal> {
  try {
    return { kind: 'enrollment', ...requireEnrollmentAuth(request, store) };
  } catch (error) {
    if (!(error instanceof EnrollmentAuthError)) throw error;
    try {
      await requireTrustedWriterBearer(request);
      return { kind: 'trusted-writer' };
    } catch {
      throw error;
    }
  }
}

export const registerExecutionAuthorityRoutes: FastifyPluginAsync = async (fastify) => {
  const store = () => fastify.executionAuthorityStore;

  fastify.post('/enrollments', async (request, reply) => {
    try {
      await requireTrustedWriterBearer(request);
    } catch (error) {
      if (error instanceof TrustedAuthError) {
        return sendTrustedAuthError(reply, error);
      }
      throw error;
    }

    const body = (request.body ?? {}) as {
      coordinatorId?: string;
      allowedDeckIds?: string[];
    };
    if (!body.coordinatorId?.trim() || !Array.isArray(body.allowedDeckIds) || body.allowedDeckIds.length === 0) {
      return reply.status(400).send({
        ok: false,
        error_code: 'INVALID_MINT_REQUEST',
        message: 'coordinatorId and allowedDeckIds are required',
      });
    }

    const result = store().enrollCoordinator({
      coordinatorId: body.coordinatorId.trim(),
      allowedDeckIds: body.allowedDeckIds.map(String),
    });
    if (!result.ok) {
      return sendContractError(reply, result, statusForContract(result));
    }
    return { ok: true, data: result.data };
  });

  fastify.get<{ Params: { id: string } }>('/enrollments/:id', async (request, reply) => {
    try {
      await requireTrustedWriterBearer(request);
    } catch (error) {
      if (error instanceof TrustedAuthError) {
        return sendTrustedAuthError(reply, error);
      }
      throw error;
    }
    const enrollment = store().getEnrollment(request.params.id);
    if (!enrollment) {
      return reply.status(404).send({
        ok: false,
        error_code: 'COORDINATOR_NOT_ENROLLED',
        message: 'Unknown enrollment',
      });
    }
    return { ok: true, data: enrollment };
  });

  fastify.post<{ Params: { id: string } }>('/enrollments/:id/revoke', async (request, reply) => {
    try {
      await requireTrustedWriterBearer(request);
    } catch (error) {
      if (error instanceof TrustedAuthError) {
        return sendTrustedAuthError(reply, error);
      }
      throw error;
    }
    const result = store().revokeEnrollment(request.params.id);
    if (!result.ok) {
      return sendContractError(reply, result, statusForContract(result));
    }
    return { ok: true, data: result.data };
  });

  fastify.get('/decks', async (request, reply) => {
    const auth = resolveEnrollmentAuth(request, store());
    if (!auth.ok) {
      return sendContractError(reply, auth.contract, statusForContract(auth.contract));
    }
    const decks: Array<{ id: string; name: string }> = [];
    for (const id of auth.enrollment.allowedDeckIds) {
      const deck = await fastify.db.getDeck(id);
      if (deck) {
        decks.push({ id: deck.id, name: deck.name });
      }
    }
    const stale = revalidateActiveEnrollment(store(), auth.enrollmentId);
    if (stale) {
      return sendContractError(reply, stale, statusForContract(stale));
    }
    return { ok: true, data: { decks } };
  });

  fastify.get<{ Params: { deckId: string } }>(
    '/decks/:deckId/playbooks',
    async (request, reply) => {
      const auth = resolveEnrollmentAuth(request, store());
      if (!auth.ok) {
        return sendContractError(reply, auth.contract, statusForContract(auth.contract));
      }

      const { deckId } = request.params;
      const badSegment = invalidDeckIdPathSegment(deckId);
      if (badSegment) {
        return sendContractError(reply, badSegment, statusForContract(badSegment));
      }
      if (!auth.enrollment.allowedDeckIds.includes(deckId)) {
        return sendContractError(reply, deckNotPermittedError(auth.enrollmentId, deckId));
      }

      // Fail closed for deleted-but-still-allowed decks (distinct from not-in-allowedDeckIds).
      // Sibling GET /decks omits missing ids from the list; path-param discovery must not.
      if (!(await fastify.db.hasDeck(deckId))) {
        return sendContractError(reply, deckNotFoundError(auth.enrollmentId, deckId));
      }

      const playbooks = await fastify.playbookManager.listSummariesForDeck(deckId);
      const stale = revalidateActiveEnrollment(store(), auth.enrollmentId, deckId);
      if (stale) {
        return sendContractError(reply, stale, statusForContract(stale));
      }
      return { ok: true, data: playbooks };
    },
  );

  fastify.post('/authorities', async (request, reply) => {
    const auth = resolveEnrollmentAuth(request, store());
    if (!auth.ok) {
      return sendContractError(reply, auth.contract, statusForContract(auth.contract));
    }
    const { enrollmentId } = auth;

    const body = (request.body ?? {}) as MintAuthorityRequest;
    if (body.enrollmentId && body.enrollmentId !== enrollmentId) {
      return reply.status(400).send({
        ok: false,
        error_code: 'INVALID_MINT_REQUEST',
        message: 'enrollmentId does not match bearer',
      });
    }
    if (
      !body.runId?.trim() ||
      !body.attemptId?.trim() ||
      !body.deckId?.trim() ||
      !body.idempotencyKey?.trim() ||
      body.audience !== 'dealer-worker' ||
      !(body.ttlMs > 0)
    ) {
      return reply.status(400).send({
        ok: false,
        error_code: 'INVALID_MINT_REQUEST',
        message: 'runId, attemptId, deckId, audience=dealer-worker, idempotencyKey, ttlMs>0 required',
      });
    }

    const deckId = body.deckId.trim();
    // Scope check before existence so missing out-of-scope ids stay deck_not_permitted.
    if (!auth.enrollment.allowedDeckIds.includes(deckId)) {
      return sendContractError(reply, deckNotPermittedError(enrollmentId, deckId));
    }
    const deck = await fastify.db.getDeck(deckId);
    if (!deck) {
      return sendContractError(reply, deckNotFoundError(enrollmentId, deckId));
    }

    const services = deck.services ?? [];
    const allowedTools: AllowedTool[] = [];
    const allowedServices: string[] = [];
    for (const service of services) {
      allowedServices.push(service.id);
      const discovered = await fastify.serviceManager.discoverServiceTools(service.id, {
        forAgent: true,
      });
      if (Array.isArray(discovered)) {
        for (const tool of discovered) {
          allowedTools.push({ serviceId: service.id, toolName: tool.name });
        }
      }
    }

    const narrowedTools = intersectTools(allowedTools, body.toolScopeHint);
    const narrowedServiceIds = [...new Set(narrowedTools.map((t) => t.serviceId))];
    // undefined hint → full deck services; explicit hint (incl. []) → services from snapshot only
    const mintServices =
      body.toolScopeHint === undefined ? allowedServices : narrowedServiceIds;

    const stale = revalidateActiveEnrollment(store(), enrollmentId, deckId);
    if (stale) {
      return sendContractError(reply, stale, statusForContract(stale));
    }

    const result = store().mintAuthority({
      enrollmentId,
      runId: body.runId.trim(),
      attemptId: body.attemptId.trim(),
      deckId,
      audience: 'dealer-worker',
      idempotencyKey: body.idempotencyKey.trim(),
      allowedServices: mintServices,
      allowedTools: narrowedTools,
      ttlMs: body.ttlMs,
    });
    if (!result.ok) {
      return sendContractError(reply, result, statusForContract(result));
    }
    return { ok: true, data: result.data };
  });

  fastify.get<{ Params: { id: string } }>('/authorities/:id', async (request, reply) => {
    let principal: AuthzPrincipal;
    try {
      principal = await requireEnrollmentOrTrustedWriter(request, store());
    } catch (error) {
      if (error instanceof EnrollmentAuthError) {
        return sendContractError(reply, error.contract, statusForContract(error.contract));
      }
      throw error;
    }
    const peeked = store().peekAuthority(request.params.id);
    if (
      !peeked ||
      (principal.kind === 'enrollment' && peeked.enrollmentId !== principal.enrollmentId)
    ) {
      return sendContractError(
        reply,
        {
          ok: false,
          error_code: 'AUTHORITY_UNKNOWN',
          message: 'Unknown authority',
          correlation: { authorityId: request.params.id },
        },
        404,
      );
    }
    const result = store().inspectAuthority(request.params.id);
    if (!result.ok) {
      return sendContractError(reply, result, statusForContract(result));
    }
    return { ok: true, data: result.data };
  });

  fastify.post<{ Params: { id: string } }>('/authorities/:id/revoke', async (request, reply) => {
    let principal: AuthzPrincipal;
    try {
      principal = await requireEnrollmentOrTrustedWriter(request, store());
    } catch (error) {
      if (error instanceof EnrollmentAuthError) {
        return sendContractError(reply, error.contract, statusForContract(error.contract));
      }
      throw error;
    }
    const peeked = store().peekAuthority(request.params.id);
    if (
      !peeked ||
      (principal.kind === 'enrollment' && peeked.enrollmentId !== principal.enrollmentId)
    ) {
      return sendContractError(
        reply,
        {
          ok: false,
          error_code: 'AUTHORITY_UNKNOWN',
          message: 'Unknown authority',
          correlation: { authorityId: request.params.id },
        },
        404,
      );
    }
    const result = store().revokeAuthority(request.params.id);
    if (!result.ok) {
      return sendContractError(reply, result, statusForContract(result));
    }
    return { ok: true, data: result.data };
  });

  fastify.get('/audit', async (request, reply) => {
    let principal: AuthzPrincipal;
    try {
      principal = await requireEnrollmentOrTrustedWriter(request, store());
    } catch (error) {
      if (error instanceof EnrollmentAuthError) {
        return sendContractError(reply, error.contract, statusForContract(error.contract));
      }
      throw error;
    }
    const q = request.query as Record<string, string | undefined>;
    if (principal.kind === 'enrollment') {
      if (q.enrollmentId && q.enrollmentId !== principal.enrollmentId) {
        return sendContractError(
          reply,
          {
            ok: false,
            error_code: 'RESOURCE_OUT_OF_SCOPE',
            message: 'Cannot query audit for another enrollment',
            correlation: { enrollmentId: principal.enrollmentId },
          },
          403,
        );
      }
      if (q.authorityId) {
        const owned = store().peekAuthority(q.authorityId);
        if (!owned || owned.enrollmentId !== principal.enrollmentId) {
          return sendContractError(
            reply,
            {
              ok: false,
              error_code: 'AUTHORITY_UNKNOWN',
              message: 'Unknown authority',
              correlation: { authorityId: q.authorityId },
            },
            404,
          );
        }
      }
    }
    const events = store().listAuditEvents({
      runId: q.runId,
      attemptId: q.attemptId,
      authorityId: q.authorityId,
      enrollmentId:
        principal.kind === 'enrollment' ? principal.enrollmentId : q.enrollmentId,
      requestId: q.requestId,
    });
    return { ok: true, data: { events } };
  });

  fastify.post('/mcp/connect', async (request, reply) => {
    const body = (request.body ?? {}) as {
      authorityId?: string;
      authoritySecret?: string;
      audience?: string;
    };
    const token = parseBearerToken(request);
    const fromBearer = token ? parseAuthorityBearer(token) : null;
    const authorityId = fromBearer?.authorityId ?? body.authorityId?.trim();
    const authoritySecret = fromBearer?.secret ?? body.authoritySecret?.trim();
    const audience = body.audience?.trim() || 'dealer-worker';

    if (!authorityId || !authoritySecret) {
      return reply.status(401).send({
        ok: false,
        error_code: 'AUTHORITY_SECRET_INVALID',
        message: 'authorityId and authoritySecret required',
      });
    }

    const auth = store().authenticateAuthority(authorityId, authoritySecret);
    if (!auth.ok) {
      return sendContractError(reply, auth, statusForContract(auth));
    }
    if (audience !== auth.data.audience) {
      return reply.status(403).send({
        ok: false,
        error_code: 'AUDIENCE_MISMATCH',
        message: 'Caller audience does not match authority audience',
        correlation: { authorityId },
      });
    }
    return {
      ok: true,
      data: {
        authorityId: auth.data.authorityId,
        deckId: auth.data.deckId,
        audience: auth.data.audience,
        runId: auth.data.runId,
        attemptId: auth.data.attemptId,
        allowedServices: auth.data.allowedServices,
        allowedTools: auth.data.allowedTools,
        expiresAt: auth.data.expiresAt,
        status: auth.data.status,
      },
    };
  });

  /** Authorize one tool call under execution authority (MCP / internal). */
  fastify.post('/authorize-call', async (request, reply) => {
    const body = (request.body ?? {}) as {
      authorityId?: string;
      authoritySecret?: string;
      audience?: string;
      serviceId?: string;
      toolName?: string;
      requiresInteraction?: boolean;
    };
    if (
      !body.authorityId ||
      !body.authoritySecret ||
      !body.audience ||
      !body.serviceId ||
      !body.toolName
    ) {
      return reply.status(400).send({
        ok: false,
        error_code: 'INVALID_MINT_REQUEST',
        message: 'authorityId, authoritySecret, audience, serviceId, toolName required',
      });
    }
    const result = store().invokeAuthorizedCall({
      authorityId: body.authorityId,
      authoritySecret: body.authoritySecret,
      audience: body.audience,
      serviceId: body.serviceId,
      toolName: body.toolName,
      requiresInteraction: body.requiresInteraction,
    });
    if (!result.ok) {
      return sendContractError(reply, result, statusForContract(result));
    }
    return { ok: true, data: result.data };
  });
};
