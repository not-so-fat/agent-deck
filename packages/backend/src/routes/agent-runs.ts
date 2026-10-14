import { createHash } from 'node:crypto';

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  AGENT_RUN_EVENTS_DEFAULT_LIMIT,
  AGENT_RUN_IDEMPOTENCY_HEADER,
  AGENT_RUN_REQUEST_BODY_LIMIT_BYTES,
  AgentRunEventsQuerySchema,
  AgentRunEventsResponseSchema,
  AgentRunIdSchema,
  AgentRunIdempotencyKeySchema,
  AgentRunStatusSchema,
  CreateAgentRunRequestSchema,
  CreateAgentRunResponseSchema,
  agentRunError,
  httpStatusForTrustedError,
  trustedSessionError,
  type AgentRunErrorCode,
  type AgentRunEvent,
  type AgentRunState,
  type CreateAgentRunRequest,
} from '@agent-deck/shared';

import type { AgentRunRejectionCode, AgentRunService, LaunchedRun } from '../agent-run';
import { auditRunTarget } from '../agent-run-api/auth';
import { AgentRunIndex, type AgentRunIndexEntry } from '../agent-run-api/run-index';
import { auditDeckTarget, type AuditActor, type AuditReasonCode } from '../audit/store';
import type { GrantPrincipal } from '../auth/client-grants';

/**
 * NOT-480: authenticated start/resume, status, and ordered events for one
 * coding-agent attempt on this host.
 *
 * HTTP code here only validates, authorizes, dispatches to the NOT-479 run
 * service, and maps results. Client-specific launch, resume, and permission
 * rules stay behind the service's adapters: a resume or profile the client
 * cannot enforce comes back as a `profile_unsupported` rejection before any
 * model work. Responses carry public lifecycle fields only — never the host
 * pid, log path, cwd, credentials, or the prompt.
 */

export type AgentRunRoutesOptions = {
  service: AgentRunService;
  /** Defaults to an index over the backend database. */
  index?: AgentRunIndex;
};

type ErrorReply = { status: number; code: AgentRunErrorCode; message: string; reason: AuditReasonCode };

type CreateResult =
  | { ok: true; status: 202; body: { runId: string; state: AgentRunState } }
  | { ok: false; error: ErrorReply };

function rejectionReply(code: AgentRunRejectionCode, request: CreateAgentRunRequest): ErrorReply {
  switch (code) {
    case 'prompt_empty':
      return { status: 400, code: 'INVALID_REQUEST', message: 'prompt must not be empty', reason: 'invalid_request' };
    case 'cwd_not_found':
    case 'cwd_not_directory':
      return {
        status: 422,
        code: 'WORKSPACE_INVALID',
        message: 'cwd is not an existing directory on the Agent Deck host',
        reason: 'workspace_invalid',
      };
    case 'deck_not_found':
      return { status: 404, code: 'DECK_NOT_FOUND', message: 'Deck not found', reason: 'deck_not_found' };
    case 'deck_unassigned':
    case 'deck_mismatch':
      return {
        status: 422,
        code: 'WORKSPACE_MISMATCH',
        message: 'cwd is not assigned to deckId on the Agent Deck host',
        reason: 'workspace_mismatch',
      };
    case 'client_unavailable':
      return {
        status: 503,
        code: 'CLIENT_UNAVAILABLE',
        message: `${request.client} is not installed or not signed in on the Agent Deck host`,
        reason: 'client_unavailable',
      };
    case 'profile_unsupported':
      return {
        status: 422,
        code: 'PROFILE_UNSUPPORTED',
        message: `${request.client} cannot enforce tools "${request.tools}"${request.resumeSessionId ? ' on a resumed session' : ''}`,
        reason: 'profile_unsupported',
      };
  }
}

/** Same normalized request (after defaults), independent of key order. */
function requestHash(request: CreateAgentRunRequest): string {
  const normalized = {
    client: request.client,
    cwd: request.cwd,
    deckId: request.deckId,
    prompt: request.prompt,
    resumeSessionId: request.resumeSessionId ?? null,
    tools: request.tools,
  };
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

function grantOf(request: FastifyRequest): GrantPrincipal {
  const principal = request.requestPrincipal;
  if (principal?.kind !== 'grant') {
    throw new Error('Internal: agent-run route reached without a run grant');
  }
  return principal.grant;
}

export async function registerAgentRunRoutes(fastify: FastifyInstance, options: AgentRunRoutesOptions) {
  const service = options.service;
  const index = options.index ?? new AgentRunIndex(fastify.db.getSqliteDatabase());
  /** In-process launches keyed by grant + idempotency key; concurrent repeats await the first. */
  const inflight = new Map<string, Promise<CreateResult>>();

  const audit = (
    actor: AuditActor,
    event: 'agent_run.created' | 'agent_run.denied' | 'agent_run.finished',
    targetId: string,
    outcome: 'succeeded' | 'denied' | 'failed',
    reasonCode: AuditReasonCode | null,
  ): void => {
    fastify.auditStore?.append({ actor, event, targetId, outcome, reasonCode });
  };

  const sendError = (reply: FastifyReply, error: ErrorReply) =>
    reply.status(error.status).send(agentRunError(error.code, error.message));

  /** Truthful public state: `starting` until the first event; `died` once the process is gone. */
  const publicState = (runId: string): { state: AgentRunState; sessionId: string | null; startedAt: string | null; lastEventAt: string | null } => {
    const status = service.status(runId);
    if (!status.found) {
      // Indexed but never recorded: the launch did not survive (no process to wait on).
      return { state: 'died', sessionId: null, startedAt: null, lastEventAt: null };
    }
    const { info } = status;
    const state: AgentRunState =
      info.state === 'running' ? (info.lastLogTs === null ? 'starting' : 'running') : info.state;
    return { state, sessionId: info.sessionId, startedAt: info.startedAt, lastEventAt: info.lastLogTs };
  };

  const readableRun = (
    request: FastifyRequest<{ Params: { runId: string } }>,
    reply: FastifyReply,
  ): AgentRunIndexEntry | null => {
    const grant = grantOf(request);
    const runId = request.params.runId;
    const entry = AgentRunIdSchema.safeParse(runId).success ? index.get(runId) : null;
    if (!entry) {
      void reply.status(404).send(agentRunError('RUN_NOT_FOUND', 'Run not found'));
      return null;
    }
    if (!grant.allowedDecks.includes(entry.deckId)) {
      audit(grant.grantId as AuditActor, 'agent_run.denied', entry.runId, 'denied', 'resource_out_of_scope');
      void reply
        .status(httpStatusForTrustedError('RESOURCE_OUT_OF_SCOPE'))
        .send(trustedSessionError('RESOURCE_OUT_OF_SCOPE', "Run deck is outside this grant's allowed decks"));
      return null;
    }
    return entry;
  };

  const watchCompletion = (grantId: string, launched: LaunchedRun): void => {
    void launched.completion.then((finished) => {
      audit(
        grantId as AuditActor,
        'agent_run.finished',
        finished.runId,
        finished.state === 'ended' ? 'succeeded' : 'failed',
        finished.state === 'ended' ? null : 'run_error',
      );
    });
  };

  const create = async (
    grant: GrantPrincipal,
    idempotencyKey: string,
    body: CreateAgentRunRequest,
  ): Promise<CreateResult> => {
    const hash = requestHash(body);
    const inflightKey = `${grant.grantId}\u0000${idempotencyKey}`;
    const { runId } = service.allocate();
    const claim = index.reserve({
      runId,
      grantId: grant.grantId,
      idempotencyKey,
      requestHash: hash,
      deckId: body.deckId,
      client: body.client,
      tools: body.tools,
    });

    if (!claim.reserved) {
      const existing = claim.existing;
      if (existing.requestHash !== hash) {
        return {
          ok: false,
          error: {
            status: 409,
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'Idempotency-Key was already used with a different request',
            reason: 'idempotency_conflict',
          },
        };
      }
      const pending = inflight.get(inflightKey);
      if (pending) {
        return pending;
      }
      return { ok: true, status: 202, body: { runId: existing.runId, state: publicState(existing.runId).state } };
    }

    const launch = (async (): Promise<CreateResult> => {
      const outcome = await service.launch(
        {
          deckRef: body.deckId,
          client: body.client,
          cwd: body.cwd,
          prompt: body.prompt,
          tools: body.tools,
          ...(body.resumeSessionId ? { resumeId: body.resumeSessionId } : {}),
        },
        { runId },
      );
      if (outcome.kind === 'rejected') {
        // Failed closed before model work: free the key so a corrected retry may reuse it.
        index.release(runId);
        return { ok: false, error: rejectionReply(outcome.code, body) };
      }
      audit(grant.grantId as AuditActor, 'agent_run.created', runId, 'succeeded', null);
      watchCompletion(grant.grantId, outcome);
      return { ok: true, status: 202, body: { runId, state: publicState(runId).state } };
    })().catch((error: unknown): CreateResult => {
      index.release(runId);
      throw error;
    });

    inflight.set(inflightKey, launch);
    try {
      return await launch;
    } finally {
      inflight.delete(inflightKey);
    }
  };

  await fastify.register(async (scope) => {
    // Body-limit and parse failures happen after auth (onRequest) but before
    // the handler; map them to the run error contract and audit the denial.
    scope.setErrorHandler((error: FastifyError, request, reply) => {
      const tooLarge = error.statusCode === 413;
      const parseError = error.statusCode === 400 || error.statusCode === 415;
      if (!tooLarge && !parseError) {
        return reply.send(error);
      }
      const principal = request.requestPrincipal;
      if (principal?.kind === 'grant') {
        audit(
          principal.grant.grantId as AuditActor,
          'agent_run.denied',
          auditRunTarget(request.url.split('?')[0]),
          'denied',
          tooLarge ? 'request_too_large' : 'invalid_request',
        );
      }
      return tooLarge
        ? reply.status(413).send(agentRunError('REQUEST_TOO_LARGE', 'Request body is too large'))
        : reply.status(400).send(agentRunError('INVALID_REQUEST', 'Request body must be JSON'));
    });

    scope.post<{ Body: unknown }>(
      '/agent-runs',
      { bodyLimit: AGENT_RUN_REQUEST_BODY_LIMIT_BYTES },
      async (request, reply) => {
        const grant = grantOf(request);
        const actor = grant.grantId as AuditActor;
        const rawDeck = (request.body as { deckId?: unknown } | null)?.deckId;
        const deckTarget = auditDeckTarget(typeof rawDeck === 'string' ? rawDeck : '');
        const deny = (error: ErrorReply) => {
          audit(actor, 'agent_run.denied', deckTarget, 'denied', error.reason);
          return sendError(reply, error);
        };

        const rawKey = request.headers[AGENT_RUN_IDEMPOTENCY_HEADER];
        const key = AgentRunIdempotencyKeySchema.safeParse(typeof rawKey === 'string' ? rawKey : undefined);
        if (!key.success) {
          return deny({
            status: 400,
            code: 'IDEMPOTENCY_KEY_REQUIRED',
            message: 'A printable Idempotency-Key header (1-200 characters) is required',
            reason: 'idempotency_key_required',
          });
        }

        const parsed = CreateAgentRunRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          // Field paths only: issue messages could echo the prompt.
          const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'body'))];
          return deny({
            status: 400,
            code: 'INVALID_REQUEST',
            message: `Invalid agent run request: ${fields.join(', ')}`,
            reason: 'invalid_request',
          });
        }

        if (!grant.allowedDecks.includes(parsed.data.deckId)) {
          audit(actor, 'agent_run.denied', deckTarget, 'denied', 'resource_out_of_scope');
          return reply
            .status(httpStatusForTrustedError('RESOURCE_OUT_OF_SCOPE'))
            .send(trustedSessionError('RESOURCE_OUT_OF_SCOPE', "Deck is outside this grant's allowed decks"));
        }

        const result = await create(grant, key.data, parsed.data);
        if (!result.ok) {
          return deny(result.error);
        }
        return reply
          .header('Cache-Control', 'no-store')
          .status(result.status)
          .send({ success: true, data: CreateAgentRunResponseSchema.parse(result.body) });
      },
    );

    // No implicit HEAD routes: the policy hook skips HEAD, and run reads must
    // never be reachable without a run grant.
    scope.get<{ Params: { runId: string } }>('/agent-runs/:runId', { exposeHeadRoute: false }, async (request, reply) => {
      const entry = readableRun(request, reply);
      if (!entry) {
        return reply;
      }
      const current = publicState(entry.runId);
      const data = AgentRunStatusSchema.parse({
        runId: entry.runId,
        deckId: entry.deckId,
        client: entry.client,
        tools: entry.tools,
        state: current.state,
        sessionId: current.sessionId,
        startedAt: current.startedAt ?? entry.createdAt,
        lastEventAt: current.lastEventAt,
      });
      return reply.header('Cache-Control', 'no-store').send({ success: true, data });
    });

    scope.get<{ Params: { runId: string }; Querystring: Record<string, unknown> }>(
      '/agent-runs/:runId/events',
      { exposeHeadRoute: false },
      async (request, reply) => {
        const entry = readableRun(request, reply);
        if (!entry) {
          return reply;
        }
        const query = AgentRunEventsQuerySchema.safeParse(request.query ?? {});
        if (!query.success) {
          return reply
            .status(400)
            .send(agentRunError('INVALID_REQUEST', 'after must be a cursor and limit 1-1000'));
        }
        // State first: a terminal state read before the log guarantees the
        // page that follows already holds the terminal event.
        const { state } = publicState(entry.runId);
        const after = query.data.after ? Number(query.data.after) : 0;
        const limit = query.data.limit ?? AGENT_RUN_EVENTS_DEFAULT_LIMIT;
        const log = service.events(entry.runId);
        const events: AgentRunEvent[] = [];
        for (const [position, { event }] of (log?.events ?? []).entries()) {
          const seq = position + 1;
          if (seq <= after) {
            continue;
          }
          if (events.length >= limit) {
            break;
          }
          const mapped = toPublicEvent(seq, event);
          if (mapped) {
            events.push(mapped);
          }
        }
        const nextCursor = String(events.length > 0 ? events[events.length - 1].seq : after);
        const data = AgentRunEventsResponseSchema.parse({ runId: entry.runId, state, events, nextCursor });
        return reply.header('Cache-Control', 'no-store').send({ success: true, data });
      },
    );
  });
}

/** Canonical log line → public event. Unknown line types are skipped (their `seq` stays reserved). */
function toPublicEvent(seq: number, event: Record<string, unknown>): AgentRunEvent | null {
  const ts = typeof event.ts === 'string' ? event.ts : '';
  const sessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : null;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (event.t) {
    case 'text':
      return { seq, ts, type: 'text', text: str(event.text) };
    case 'tool':
      return { seq, ts, type: 'tool', name: str(event.name) };
    case 'notice':
      return { seq, ts, type: 'notice', message: str(event.message), sessionId };
    case 'result':
      return { seq, ts, type: 'result', subtype: str(event.subtype), result: event.result, sessionId };
    case 'end':
      return { seq, ts, type: 'end', sessionId };
    case 'error':
      return { seq, ts, type: 'error', message: str(event.message), sessionId };
    default:
      return null;
  }
}
