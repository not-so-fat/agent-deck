import { createHash } from 'node:crypto';

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  AGENT_RUN_EVENTS_DEFAULT_LIMIT,
  AGENT_RUN_IDEMPOTENCY_HEADER,
  AGENT_RUN_REQUEST_BODY_LIMIT_BYTES,
  AGENT_RUN_TERMINAL_STATES,
  AgentRunCapabilitiesResponseSchema,
  AgentRunChangesResponseSchema,
  AgentRunEventsQuerySchema,
  AgentRunEventsResponseSchema,
  AgentRunIdSchema,
  AgentRunIdempotencyKeySchema,
  AgentRunStatusSchema,
  CreateAgentRunRequestSchema,
  CreateAgentRunResponseSchema,
  FinalizeAgentRunRequestSchema,
  FinalizeAgentRunResponseSchema,
  agentRunError,
  httpStatusForTrustedError,
  trustedSessionError,
  type AgentRunErrorCode,
  type AgentRunEvent,
  type AgentRunState,
  type CreateAgentRunRequest,
  type FinalizeAgentRunRequest,
  type FinalizeAgentRunResponse,
} from '@agent-deck/shared';

import type {
  AgentRunRejectionCode,
  AgentRunService,
  LaunchedRun,
  RunReconciliation,
} from '../agent-run';
import { auditRunTarget } from '../agent-run-api/auth';
import { FinalizationStore, type StoredBaseline } from '../agent-run-api/finalization-store';
import {
  createGitFinalizer,
  FinalizationError,
  manifestDigestOf,
  repositoryIdOf,
  type FinalizationFailureCode,
  type GitFinalizer,
} from '../agent-run-api/git-finalize';
import { AgentRunIndex, type AgentRunIndexEntry } from '../agent-run-api/run-index';
import {
  auditDeckTarget,
  type AuditActor,
  type AuditDetail,
  type AuditEvent,
  type AuditReasonCode,
} from '../audit/store';
import type { GrantPrincipal } from '../auth/client-grants';

/**
 * NOT-480: authenticated start/resume, status, and ordered events for one
 * coding-agent attempt on this host. NOT-481: capability discovery,
 * idempotent cancel, and restart reconciliation at registration.
 *
 * Read and cancel scope: a grant reaches only runs it created, on decks it
 * is still allowed; the owner dashboard reaches every run. Only grants
 * start runs.
 *
 * HTTP code here only validates, authorizes, dispatches to the NOT-479 run
 * service, and maps results. Client-specific launch, resume, and permission
 * rules stay behind the service's adapters: a resume or profile the client
 * cannot enforce comes back as a `profile_unsupported` rejection before any
 * model work. Responses carry public lifecycle fields only — never the host
 * pid, log path, cwd, credentials, or the prompt.
 *
 * NOT-486: a run started with `prepareFinalization` captures a private Git
 * baseline before launch. Once terminal, its creating grant reads the
 * candidate manifest (`/changes`) and — with the separate
 * `finalizationEnabled` capability — turns one reviewed manifest into one
 * local commit (`/finalize`). The route owns policy (who, which run,
 * idempotency, audit); the Git mechanism lives in `agent-run-api/git-finalize`.
 * The workspace is always the run's captured one; a request cannot name it.
 */

export type AgentRunRoutesOptions = {
  service: AgentRunService;
  /** Defaults to an index over the backend database. */
  index?: AgentRunIndex;
  /** NOT-486: Git finalization mechanism; defaults to the real `git` binary. */
  finalizer?: GitFinalizer;
  /** NOT-486: defaults to a store over the backend database. */
  finalizations?: FinalizationStore;
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
    case 'resume_unverified':
      return {
        status: 422,
        code: 'RESUME_UNVERIFIED',
        message: `resumeSessionId was not started by a matching ${request.client} run on this deck, cwd, and tools profile`,
        reason: 'resume_unverified',
      };
    case 'finalization_invalid':
      return {
        status: 422,
        code: 'FINALIZATION_INVALID',
        message: 'prepareFinalization requires a Git worktree cwd with a commit on a local branch or detached HEAD',
        reason: 'finalization_invalid',
      };
    case 'index_dirty':
      return {
        status: 409,
        code: 'INDEX_DIRTY',
        message: 'prepareFinalization requires a clean Git index (nothing staged or unmerged)',
        reason: 'index_dirty',
      };
  }
}

/** Stable HTTP mapping for every finalization failure (NOT-486). */
const FINALIZATION_FAILURES: Record<FinalizationFailureCode, { status: number; code: AgentRunErrorCode }> = {
  finalization_invalid: { status: 422, code: 'FINALIZATION_INVALID' },
  index_dirty: { status: 409, code: 'INDEX_DIRTY' },
  base_mismatch: { status: 409, code: 'BASE_MISMATCH' },
  baseline_mismatch: { status: 409, code: 'BASELINE_MISMATCH' },
  path_invalid: { status: 422, code: 'PATH_INVALID' },
  path_unexpected: { status: 409, code: 'PATH_UNEXPECTED' },
  digest_mismatch: { status: 409, code: 'DIGEST_MISMATCH' },
  git_lock_conflict: { status: 409, code: 'GIT_LOCK_CONFLICT' },
  ref_race: { status: 409, code: 'REF_RACE' },
  finalization_canceled: { status: 409, code: 'FINALIZATION_CANCELED' },
  finalization_failed: { status: 500, code: 'FINALIZATION_FAILED' },
};

function finalizationReply(error: FinalizationError): ErrorReply {
  const mapped = FINALIZATION_FAILURES[error.code];
  return { status: mapped.status, code: mapped.code, message: error.message, reason: error.code };
}

/** Same normalized finalize request (manifest order-independent), bound to one run. */
function finalizeRequestHash(runId: string, request: FinalizeAgentRunRequest): string {
  const normalized = {
    runId,
    baselineDigest: request.baselineDigest,
    expectedBaseCommit: request.expectedBaseCommit,
    reviewId: request.reviewId,
    commitMessage: request.commitMessage,
    manifestDigest: manifestDigestOf(request.files),
  };
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

type FinalizeOutcome = { ok: true; data: FinalizeAgentRunResponse } | { ok: false; error: ErrorReply };

/** Same normalized request (after defaults), independent of key order. */
function requestHash(request: CreateAgentRunRequest): string {
  const normalized = {
    client: request.client,
    cwd: request.cwd,
    deckId: request.deckId,
    prompt: request.prompt,
    resumeSessionId: request.resumeSessionId ?? null,
    tools: request.tools,
    prepareFinalization: request.prepareFinalization,
  };
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

/** Grant on a run route, or the owner dashboard (status, events, cancel, capabilities). */
type RunCaller = { kind: 'grant'; grant: GrantPrincipal } | { kind: 'owner' };

function callerOf(request: FastifyRequest): RunCaller {
  const principal = request.requestPrincipal;
  if (principal?.kind === 'dashboard') {
    return { kind: 'owner' };
  }
  return { kind: 'grant', grant: grantOf(request) };
}

function actorOf(caller: RunCaller): AuditActor {
  return caller.kind === 'owner' ? 'owner' : (caller.grant.grantId as AuditActor);
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
  const finalizer = options.finalizer ?? createGitFinalizer();
  const finalizations = options.finalizations ?? new FinalizationStore(fastify.db.getSqliteDatabase());
  /** In-process launches keyed by grant + idempotency key; concurrent repeats await the first. */
  const inflight = new Map<string, Promise<CreateResult>>();
  /** In-process finalizations by run id; identical repeats await, cancel aborts (NOT-486). */
  const finalizing = new Map<string, { outcome: Promise<FinalizeOutcome>; controller: AbortController }>();

  const audit = (
    actor: AuditActor,
    event: Extract<AuditEvent, `agent_run.${string}`>,
    targetId: string,
    outcome: 'succeeded' | 'denied' | 'failed',
    reasonCode: AuditReasonCode | null,
    detail?: AuditDetail,
  ): void => {
    fastify.auditStore?.append({ actor, event, targetId, outcome, reasonCode, ...(detail ? { detail } : {}) });
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
    const caller = callerOf(request);
    const runId = request.params.runId;
    const entry = AgentRunIdSchema.safeParse(runId).success ? index.get(runId) : null;
    if (!entry) {
      void reply.status(404).send(agentRunError('RUN_NOT_FOUND', 'Run not found'));
      return null;
    }
    if (caller.kind === 'owner') {
      return entry;
    }
    const { grant } = caller;
    const outOfScope = (message: string): null => {
      audit(grant.grantId as AuditActor, 'agent_run.denied', entry.runId, 'denied', 'resource_out_of_scope');
      void reply
        .status(httpStatusForTrustedError('RESOURCE_OUT_OF_SCOPE'))
        .send(trustedSessionError('RESOURCE_OUT_OF_SCOPE', message));
      return null;
    };
    if (!grant.allowedDecks.includes(entry.deckId)) {
      return outOfScope("Run deck is outside this grant's allowed decks");
    }
    if (entry.grantId !== grant.grantId) {
      return outOfScope('Run was started by another grant');
    }
    return entry;
  };

  /**
   * NOT-486 gate shared by `/changes` and `/finalize`: the creating grant on
   * an allowed deck (via {@link readableRun}), a run prepared before launch,
   * and a terminal state. Denials are audited under `event`.
   */
  const finalizableRun = (
    request: FastifyRequest<{ Params: { runId: string } }>,
    reply: FastifyReply,
    event: 'agent_run.changes_read' | 'agent_run.finalized',
  ): { entry: AgentRunIndexEntry; stored: StoredBaseline; actor: AuditActor } | null => {
    const entry = readableRun(request, reply);
    if (!entry) {
      return null;
    }
    const actor = actorOf(callerOf(request));
    const stored = finalizations.getBaseline(entry.runId);
    if (!stored) {
      audit(actor, event, entry.runId, 'denied', 'finalization_not_prepared');
      void sendError(reply, {
        status: 409,
        code: 'FINALIZATION_NOT_PREPARED',
        message: 'Run was not started with prepareFinalization',
        reason: 'finalization_not_prepared',
      });
      return null;
    }
    const { state } = publicState(entry.runId);
    if (!(AGENT_RUN_TERMINAL_STATES as readonly string[]).includes(state)) {
      audit(actor, event, entry.runId, 'denied', 'run_not_terminal', { repositoryId: repositoryIdOf(stored.baseline) });
      void sendError(reply, {
        status: 409,
        code: 'RUN_NOT_TERMINAL',
        message: 'Run has not reached a terminal state',
        reason: 'run_not_terminal',
      });
      return null;
    }
    return { entry, stored, actor };
  };

  const finalizationStatus = (runId: string) => {
    const stored = finalizations.getBaseline(runId);
    if (!stored) {
      return null;
    }
    const record = finalizations.get(runId);
    return {
      baselineRef: stored.baselineRef,
      baselineDigest: stored.baseline.digest,
      state: record?.state ?? 'prepared',
      commit: record?.state === 'finalized' ? record.result?.commit ?? null : null,
    };
  };

  const statusBody = (entry: AgentRunIndexEntry) => {
    const current = publicState(entry.runId);
    return AgentRunStatusSchema.parse({
      runId: entry.runId,
      deckId: entry.deckId,
      client: entry.client,
      tools: entry.tools,
      state: current.state,
      sessionId: current.sessionId,
      startedAt: current.startedAt ?? entry.createdAt,
      lastEventAt: current.lastEventAt,
      finalization: finalizationStatus(entry.runId),
    });
  };

  const watchCompletion = (grantId: string, launched: LaunchedRun): void => {
    void launched.completion.then((finished) => {
      // Cancellation audits itself; an abandoned run reconciles at the next start.
      if (finished.state === 'canceled' || finished.state === 'died') {
        return;
      }
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

    // NOT-486: the baseline is captured after every launch gate and before the adapter starts.
    let prepared: StoredBaseline | null = null;
    const beforeStart = body.prepareFinalization
      ? async () => {
          try {
            prepared = finalizations.saveBaseline(runId, await finalizer.captureBaseline(body.cwd));
            return { ok: true as const };
          } catch (error) {
            if (!(error instanceof FinalizationError)) {
              throw error;
            }
            return {
              ok: false as const,
              code: error.code === 'index_dirty' ? ('index_dirty' as const) : ('finalization_invalid' as const),
              message: error.message,
            };
          }
        }
      : undefined;

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
        { runId, ownProcessGroup: true, ...(beforeStart ? { beforeStart } : {}) },
      );
      if (outcome.kind === 'rejected') {
        // Failed closed before model work: free the key so a corrected retry may reuse it.
        finalizations.deleteBaseline(runId);
        index.release(runId);
        return { ok: false, error: rejectionReply(outcome.code, body) };
      }
      audit(grant.grantId as AuditActor, 'agent_run.created', runId, 'succeeded', null);
      const baseline = (prepared as StoredBaseline | null)?.baseline;
      if (baseline) {
        audit(grant.grantId as AuditActor, 'agent_run.finalization_prepared', runId, 'succeeded', null, {
          repositoryId: repositoryIdOf(baseline),
          baselineDigest: baseline.digest,
        });
      }
      watchCompletion(grant.grantId, outcome);
      return { ok: true, status: 202, body: { runId, state: publicState(runId).state } };
    })().catch((error: unknown): CreateResult => {
      finalizations.deleteBaseline(runId);
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

  // Restart recovery: re-derive every `running` record this process does not
  // own from its owner process and canonical log before serving reads.
  const reconcileAudit = (row: RunReconciliation): void => {
    const entry = index.get(row.runId);
    if (!entry) {
      return; // A CLI run: reconciled on disk, not an API audit subject.
    }
    const reason: Record<RunReconciliation['state'], AuditReasonCode | null> = {
      ended: null,
      error: 'run_error',
      died: 'run_died',
      canceled: 'run_canceled',
    };
    audit(
      entry.grantId as AuditActor,
      'agent_run.reconciled',
      row.runId,
      row.state === 'ended' ? 'succeeded' : 'failed',
      reason[row.state],
    );
  };
  for (const row of service.reconcile()) {
    reconcileAudit(row);
  }
  // NOT-486: a finalization interrupted by a crash either moved the ref to
  // its recorded commit (finalized) or did not (released, staging removed).
  for (const record of finalizations.listInProgress()) {
    const stored = finalizations.getBaseline(record.runId);
    const recovered = stored
      ? await finalizer.recover(stored.baseline, record.runId, {
          commit: record.pendingCommit,
          lockIno: record.lockIno,
        })
      : false;
    if (recovered && record.result) {
      finalizations.complete(record.runId, record.result);
    } else {
      finalizations.release(record.runId);
    }
    audit(
      record.grantId as AuditActor,
      'agent_run.finalized',
      record.runId,
      recovered ? 'succeeded' : 'failed',
      recovered ? null : 'finalization_failed',
      stored
        ? {
            repositoryId: repositoryIdOf(stored.baseline),
            ...(recovered && record.result
              ? {
                  commit: record.result.commit,
                  tree: record.result.tree,
                  manifestDigest: record.result.manifestDigest,
                  fileCount: record.result.fileCount,
                }
              : {}),
          }
        : undefined,
    );
  }
  // A run cannot outlive the process streaming it: stop owned groups on close.
  fastify.addHook('onClose', async () => {
    service.shutdown();
  });

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

        if (parsed.data.prepareFinalization && parsed.data.tools !== 'edit') {
          return deny({
            status: 422,
            code: 'FINALIZATION_INVALID',
            message: 'prepareFinalization requires tools "edit"',
            reason: 'finalization_invalid',
          });
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
    scope.get('/agent-runs/capabilities', { exposeHeadRoute: false }, async (_request, reply) => {
      const data = AgentRunCapabilitiesResponseSchema.parse({
        host: 'same-host',
        clients: await service.capabilities(),
      });
      return reply.header('Cache-Control', 'no-store').send({ success: true, data });
    });

    scope.get<{ Params: { runId: string } }>('/agent-runs/:runId', { exposeHeadRoute: false }, async (request, reply) => {
      const entry = readableRun(request, reply);
      if (!entry) {
        return reply;
      }
      return reply.header('Cache-Control', 'no-store').send({ success: true, data: statusBody(entry) });
    });

    scope.post<{ Params: { runId: string } }>('/agent-runs/:runId/cancel', async (request, reply) => {
      const entry = readableRun(request, reply);
      if (!entry) {
        return reply;
      }
      const actor = actorOf(callerOf(request));
      // NOT-486: cancel also stops an in-flight finalization (honored only before its commit).
      finalizing.get(entry.runId)?.controller.abort();
      const outcome = service.cancel(entry.runId);
      if (outcome.kind === 'not_cancelable') {
        audit(actor, 'agent_run.denied', entry.runId, 'denied', 'run_not_cancelable');
        return reply
          .status(409)
          .send(agentRunError('RUN_NOT_CANCELABLE', 'Run is owned by another host process that cannot be signaled'));
      }
      // `not_found`: indexed but never recorded, which reads as `died`.
      audit(
        actor,
        'agent_run.canceled',
        entry.runId,
        'succeeded',
        outcome.kind === 'canceled' ? null : 'already_terminal',
      );
      return reply.header('Cache-Control', 'no-store').send({ success: true, data: statusBody(entry) });
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
            if (mapped.type === 'canceled') {
              break; // Cancellation is final: nothing after it is delivered.
            }
          }
        }
        const nextCursor = String(events.length > 0 ? events[events.length - 1].seq : after);
        const data = AgentRunEventsResponseSchema.parse({ runId: entry.runId, state, events, nextCursor });
        return reply.header('Cache-Control', 'no-store').send({ success: true, data });
      },
    );

    // NOT-486: candidate manifest of a terminal prepared run (creating grant only).
    scope.get<{ Params: { runId: string } }>(
      '/agent-runs/:runId/changes',
      { exposeHeadRoute: false },
      async (request, reply) => {
        const gate = finalizableRun(request, reply, 'agent_run.changes_read');
        if (!gate) {
          return reply;
        }
        const { entry, stored, actor } = gate;
        const repositoryId = repositoryIdOf(stored.baseline);
        let snapshot;
        try {
          snapshot = await finalizer.candidate(stored.baseline);
        } catch (error) {
          if (!(error instanceof FinalizationError)) {
            throw error;
          }
          const failure = finalizationReply(error);
          audit(actor, 'agent_run.changes_read', entry.runId, 'denied', failure.reason, { repositoryId });
          return sendError(reply, failure);
        }
        audit(actor, 'agent_run.changes_read', entry.runId, 'succeeded', null, {
          repositoryId,
          baselineDigest: stored.baseline.digest,
          manifestDigest: snapshot.manifestDigest,
          fileCount: snapshot.files.length,
        });
        const data = AgentRunChangesResponseSchema.parse({
          runId: entry.runId,
          baselineRef: stored.baselineRef,
          baselineDigest: stored.baseline.digest,
          baseCommit: snapshot.baseCommit,
          files: snapshot.files,
          manifestDigest: snapshot.manifestDigest,
        });
        return reply.header('Cache-Control', 'no-store').send({ success: true, data });
      },
    );

    // NOT-486: one reviewed manifest → one local commit (creating grant with finalizationEnabled).
    scope.post<{ Params: { runId: string }; Body: unknown }>(
      '/agent-runs/:runId/finalize',
      { bodyLimit: AGENT_RUN_REQUEST_BODY_LIMIT_BYTES },
      async (request, reply) => {
        const grant = grantOf(request);
        const actor = grant.grantId as AuditActor;
        const target = auditRunTarget(request.url.split('?')[0]);
        if (!grant.finalizationEnabled) {
          audit(actor, 'agent_run.finalized', target, 'denied', 'finalization_capability_required');
          return reply
            .status(httpStatusForTrustedError('FINALIZATION_CAPABILITY_REQUIRED'))
            .send(trustedSessionError('FINALIZATION_CAPABILITY_REQUIRED', 'This grant is not enabled for run finalization'));
        }
        const gate = finalizableRun(request, reply, 'agent_run.finalized');
        if (!gate) {
          return reply;
        }
        const { entry, stored } = gate;
        const runId = entry.runId;
        const repositoryId = repositoryIdOf(stored.baseline);
        const deny = (error: ErrorReply, detail: AuditDetail = { repositoryId }) => {
          audit(
            actor,
            'agent_run.finalized',
            runId,
            error.reason === 'finalization_failed' ? 'failed' : 'denied',
            error.reason,
            detail,
          );
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
        const parsed = FinalizeAgentRunRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          // Field paths only: issue messages could echo the commit message or a path.
          const fields = [
            ...new Set(parsed.error.issues.map((issue) => issue.path.filter((part) => typeof part === 'string').join('.') || 'body')),
          ];
          return deny({
            status: 400,
            code: 'INVALID_REQUEST',
            message: `Invalid finalize request: ${fields.join(', ')}`,
            reason: 'invalid_request',
          });
        }
        const body = parsed.data;
        const manifestDigest = manifestDigestOf(body.files);
        const detail: AuditDetail = {
          repositoryId,
          baselineDigest: stored.baseline.digest,
          manifestDigest,
          fileCount: body.files.length,
        };
        const send = (outcome: FinalizeOutcome) =>
          outcome.ok
            ? reply.header('Cache-Control', 'no-store').send({ success: true, data: outcome.data })
            : sendError(reply, outcome.error);

        const hash = finalizeRequestHash(runId, body);
        const claim = finalizations.claim({ runId, grantId: grant.grantId, idempotencyKey: key.data, requestHash: hash });
        if (!claim.claimed) {
          const existing = claim.existing;
          const same =
            existing.runId === runId && existing.idempotencyKey === key.data && existing.requestHash === hash;
          if (!same) {
            return deny(
              {
                status: 409,
                code: 'IDEMPOTENCY_CONFLICT',
                message: 'This run or Idempotency-Key already has a different finalization request',
                reason: 'idempotency_conflict',
              },
              detail,
            );
          }
          if (existing.state === 'finalized' && existing.result) {
            // Durable replay: the original commit, with no Git invocation.
            const result = existing.result;
            audit(actor, 'agent_run.finalized', runId, 'succeeded', 'replayed', {
              ...detail,
              commit: result.commit,
              tree: result.tree,
            });
            return send({ ok: true, data: result });
          }
          const pending = finalizing.get(runId);
          if (pending) {
            return send(await pending.outcome);
          }
          return deny(
            {
              status: 409,
              code: 'GIT_LOCK_CONFLICT',
              message: 'This finalization is still in progress',
              reason: 'git_lock_conflict',
            },
            detail,
          );
        }

        const controller = new AbortController();
        // A caller that disconnects before the commit cancels the operation.
        const onClose = () => {
          if (!reply.raw.writableEnded) {
            controller.abort();
          }
        };
        reply.raw.once('close', onClose);
        const outcome = (async (): Promise<FinalizeOutcome> => {
          try {
            const result = await finalizer.finalize(
              stored.baseline,
              {
                runId,
                baselineDigest: body.baselineDigest,
                expectedBaseCommit: body.expectedBaseCommit,
                commitMessage: body.commitMessage,
                files: body.files,
              },
              {
                signal: controller.signal,
                onLocked: (lockIno) => finalizations.markLocked(runId, lockIno),
                onCommitObject: (commit, tree) =>
                  finalizations.markPending(
                    runId,
                    FinalizeAgentRunResponseSchema.parse({
                      runId,
                      finalizationState: 'finalized',
                      commit,
                      tree,
                      parent: body.expectedBaseCommit,
                      manifestDigest,
                      fileCount: body.files.length,
                      reviewId: body.reviewId,
                    }),
                  ),
              },
            );
            const data = FinalizeAgentRunResponseSchema.parse({
              runId,
              finalizationState: 'finalized',
              commit: result.commit,
              tree: result.tree,
              parent: result.parent,
              manifestDigest: result.manifestDigest,
              fileCount: result.fileCount,
              reviewId: body.reviewId,
            });
            finalizations.complete(runId, data);
            audit(actor, 'agent_run.finalized', runId, 'succeeded', null, {
              ...detail,
              commit: data.commit,
              tree: data.tree,
            });
            return { ok: true, data };
          } catch (error) {
            finalizations.release(runId);
            const failure = finalizationReply(
              error instanceof FinalizationError
                ? error
                : new FinalizationError('finalization_failed', 'Finalization failed before the commit'),
            );
            audit(
              actor,
              'agent_run.finalized',
              runId,
              failure.reason === 'finalization_failed' ? 'failed' : 'denied',
              failure.reason,
              detail,
            );
            return { ok: false, error: failure };
          }
        })();
        finalizing.set(runId, { outcome, controller });
        try {
          return send(await outcome);
        } finally {
          finalizing.delete(runId);
          reply.raw.off('close', onClose);
        }
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
    case 'canceled':
      return { seq, ts, type: 'canceled', sessionId };
    default:
      return null;
  }
}
