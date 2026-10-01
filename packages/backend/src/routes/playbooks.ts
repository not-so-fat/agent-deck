import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENT_DECK_CORRELATION_HEADER,
  AGENT_DECK_SESSION_HEADER,
  ApiResponse,
  DashboardRegisterPlaybookSchema,
  DashboardUpdatePlaybookSchema,
  normalizeCorrelationId,
  OpenPlaybookPatchSummary,
  Playbook,
  PlaybookSummary,
  PlaybookWithDependencies,
  trustedSessionError,
} from '@agent-deck/shared';
import { ZodError } from 'zod';
import {
  DashboardOnlyError,
  isDashboardClient,
  requireDashboardClient,
} from '../lib/client-scope';
import { AgentDeckContextError, resolveAgentDeckId } from '../lib/agent-deck-context';
import {
  boundDeckScopeResponse,
  requirePlaybookOnBoundDeck,
} from '../lib/bound-deck-scope';
import { playbookEventSource } from './playbook-patches';

interface PlaybookIdRequest {
  Params: { id: string };
}

function dashboardOnlyResponse(error: unknown): { status: number; body: ApiResponse } {
  const message =
    error instanceof DashboardOnlyError
      ? error.message
      : error instanceof Error
        ? error.message
        : 'Unknown error';

  return {
    status: error instanceof DashboardOnlyError ? 403 : 400,
    body: { success: false, error: message },
  };
}

function formatPlaybookMutationError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => issue.message).join('; ');
  }
  return error instanceof Error ? error.message : 'Unknown error';
}

async function sendPlaybookWithOpenPatches(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  playbook: PlaybookWithDependencies,
) {
  // Only agent/IDE fetches count as playbook use — dashboard detail
  // inspection must not emit a usage event. The raw session header is
  // passed through; only its one-way hash is stored. The correlation
  // header is observability metadata only and never affects this fetch.
  if (!isDashboardClient(request)) {
    try {
      const deckId = await resolveAgentDeckId(request, fastify.db).catch(() => null);
      const sessionHeader = request.headers[AGENT_DECK_SESSION_HEADER];
      const correlationHeader = request.headers[AGENT_DECK_CORRELATION_HEADER];
      await fastify.db.recordCardUsageEvent({
        cardType: 'playbook',
        cardId: playbook.id,
        deckId,
        action: 'fetch',
        success: true,
        source: playbookEventSource(request),
        sessionId: typeof sessionHeader === 'string' ? sessionHeader : null,
        correlationId:
          typeof correlationHeader === 'string'
            ? normalizeCorrelationId(correlationHeader)
            : null,
      });
    } catch (error) {
      fastify.log.warn({ err: error }, 'card usage event recording failed');
    }
  }
  const openPatches = await fastify.patchManager.listOpenPatchSummaries(playbook.id);
  return reply.send({
    success: true,
    data: { ...playbook, openPatches },
  } satisfies ApiResponse<
    PlaybookWithDependencies & { openPatches: OpenPlaybookPatchSummary[] }
  >);
}

export async function registerPlaybookRoutes(fastify: FastifyInstance) {
  fastify.get('/collection', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const playbooks = await fastify.playbookManager.list();
      return reply.send({ success: true, data: playbooks } satisfies ApiResponse<Playbook[]>);
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies ApiResponse);
    }
  });

  fastify.get('/vault', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const playbooks = await fastify.playbookManager.list();
      return reply.send({ success: true, data: playbooks } satisfies ApiResponse<Playbook[]>);
    } catch (error) {
      const { status, body } = dashboardOnlyResponse(error);
      return reply.status(status).send(body);
    }
  });

  fastify.get('/summaries', async (request, reply) => {
    try {
      const deckId = await resolveAgentDeckId(request, fastify.db);
      const playbooks = await fastify.playbookManager.listSummariesForDeck(deckId);
      return reply.send({ success: true, data: playbooks } satisfies ApiResponse<PlaybookSummary[]>);
    } catch (error) {
      const status = error instanceof AgentDeckContextError ? 400 : 500;
      return reply.status(status).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies ApiResponse);
    }
  });

  fastify.get<{ Querystring: { credentialId?: string; serviceId?: string } }>(
    '/dependents/check',
    async (request, reply) => {
      try {
        requireDashboardClient(request);
        const { credentialId, serviceId } = request.query;
        if (!credentialId && !serviceId) {
          return reply.status(400).send({
            success: false,
            error: 'credentialId or serviceId query parameter is required',
          } satisfies ApiResponse);
        }

        const dependents = credentialId
          ? await fastify.playbookManager.getDependentsForCredential(credentialId)
          : await fastify.playbookManager.getDependentsForService(serviceId!);

        return reply.send({ success: true, data: dependents } satisfies ApiResponse);
      } catch (error) {
        const { status, body } = dashboardOnlyResponse(error);
        return reply.status(status).send(body);
      }
    },
  );

  fastify.get('/', async (request, reply) => {
    try {
      const deckId = await resolveAgentDeckId(request, fastify.db);
      const playbooks = await fastify.playbookManager.listForDeck(deckId);
      return reply.send({ success: true, data: playbooks } satisfies ApiResponse<Playbook[]>);
    } catch (error) {
      const status = error instanceof AgentDeckContextError ? 400 : 500;
      return reply.status(status).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies ApiResponse);
    }
  });

  fastify.get<PlaybookIdRequest>('/:id', async (request, reply) => {
    try {
      if (isDashboardClient(request)) {
        const playbook = await fastify.playbookManager.getWithDependencies(request.params.id);
        if (!playbook) {
          return reply.status(404).send({
            success: false,
            error: 'Playbook not found',
          } satisfies ApiResponse);
        }
        return sendPlaybookWithOpenPatches(fastify, request, reply, playbook);
      }

      await requirePlaybookOnBoundDeck(request, fastify.db, request.params.id);
      const playbook = await fastify.playbookManager.getWithDependencies(request.params.id);
      if (!playbook) {
        return reply.status(404).send({
          success: false,
          error: 'Playbook not found',
        } satisfies ApiResponse);
      }

      return sendPlaybookWithOpenPatches(fastify, request, reply, playbook);
    } catch (error) {
      const scoped = boundDeckScopeResponse(error);
      if (scoped.error_code) {
        return reply.status(scoped.status).send(trustedSessionError(scoped.error_code, scoped.message));
      }
      return reply.status(scoped.status).send({
        success: false,
        error: scoped.message,
      } satisfies ApiResponse);
    }
  });

  fastify.post('/', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const input = DashboardRegisterPlaybookSchema.parse(request.body);
      const { autoDetectDependencies, ...createInput } = input;
      const playbook = await fastify.playbookManager.createWithDependencies({
        ...createInput,
        addToBoundDeck: false,
        autoDetectDependencies,
      });
      return reply
        .status(201)
        .send({ success: true, data: playbook } satisfies ApiResponse<PlaybookWithDependencies>);
    } catch (error) {
      if (error instanceof DashboardOnlyError) {
        const { status, body } = dashboardOnlyResponse(error);
        return reply.status(status).send(body);
      }
      return reply.status(400).send({
        success: false,
        error: formatPlaybookMutationError(error),
      } satisfies ApiResponse);
    }
  });

  fastify.put<PlaybookIdRequest>('/:id', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const input = DashboardUpdatePlaybookSchema.parse(request.body);
      const playbook = await fastify.playbookManager.updateWithDependencies(
        request.params.id,
        input,
      );
      if (!playbook) {
        return reply.status(404).send({ success: false, error: 'Playbook not found' } satisfies ApiResponse);
      }
      await fastify.patchManager.snapshotVersion(playbook, null, 'user');
      return reply.send({ success: true, data: playbook } satisfies ApiResponse<PlaybookWithDependencies>);
    } catch (error) {
      if (error instanceof DashboardOnlyError) {
        const { status, body } = dashboardOnlyResponse(error);
        return reply.status(status).send(body);
      }
      return reply.status(400).send({
        success: false,
        error: formatPlaybookMutationError(error),
      } satisfies ApiResponse);
    }
  });

  fastify.get<{ Params: { id: string } }>('/:id/events/count', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const count = await fastify.db.countSuccessfulPlaybookFetches(request.params.id);
      return reply.send({ success: true, data: count } satisfies ApiResponse<number>);
    } catch (error) {
      return reply.status(403).send({
        success: false,
        error: error instanceof Error ? error.message : 'Forbidden',
      } satisfies ApiResponse);
    }
  });

  fastify.delete<PlaybookIdRequest>('/:id', async (request, reply) => {
    try {
      requireDashboardClient(request);

      const deleted = await fastify.playbookManager.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ success: false, error: 'Playbook not found' } satisfies ApiResponse);
      }
      return reply.send({ success: true, message: 'Playbook deleted successfully' } satisfies ApiResponse);
    } catch (error) {
      if (error instanceof DashboardOnlyError) {
        const { status, body } = dashboardOnlyResponse(error);
        return reply.status(status).send(body);
      }
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies ApiResponse);
    }
  });
}
