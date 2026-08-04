import { FastifyInstance } from 'fastify';
import {
  ApiResponse,
  AgentRegisterPlaybookSchema,
  AgentUpdatePlaybookSchema,
  DashboardRegisterPlaybookSchema,
  DashboardUpdatePlaybookSchema,
  OpenPlaybookPatchSummary,
  Playbook,
  PlaybookSummary,
  PlaybookWithDependencies,
  TriggerValidationError,
  triggerErrorMessage,
  generateId,
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
import { PlaybookDependencyError } from '../playbooks/playbook-manager';
import { triggerWarningsForDeck } from '../playbooks/stub-workspace-sync';
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

function formatPlaybookMutationError(error: unknown, forAgent: boolean): string {
  if (error instanceof TriggerValidationError) {
    return triggerErrorMessage(error, forAgent);
  }
  if (error instanceof ZodError) {
    let message = error.issues.map((issue) => issue.message).join('; ');
    if (
      forAgent &&
      /triggers per playbook|Cannot grow triggers/i.test(message) &&
      !message.includes('do not ask the user')
    ) {
      message +=
        ' Fix the trigger list and retry — do not ask the user to resolve this.';
    }
    return message;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}

export async function registerPlaybookRoutes(fastify: FastifyInstance) {
  fastify.get('/collection', async (request, reply) => {
    try {
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
      let playbook: PlaybookWithDependencies | null;

      if (isDashboardClient(request)) {
        playbook = await fastify.playbookManager.getWithDependencies(request.params.id);
      } else {
        const deckId = await resolveAgentDeckId(request, fastify.db);
        const onDeck = await fastify.playbookManager.isPlaybookOnDeck(deckId, request.params.id);
        playbook = onDeck
          ? await fastify.playbookManager.getWithDependencies(request.params.id)
          : null;
      }

      if (!playbook) {
        return reply.status(isDashboardClient(request) ? 404 : 403).send({
          success: false,
          error: isDashboardClient(request)
            ? 'Playbook not found'
            : 'Playbook not found on bound deck',
        } satisfies ApiResponse);
      }

      await fastify.db.recordPlaybookEvent({
        id: generateId(),
        playbookId: playbook.id,
        event: 'fetched',
        source: playbookEventSource(request),
      });

      const openPatches = await fastify.patchManager.listOpenPatchSummaries(playbook.id);

      return reply.send({
        success: true,
        data: { ...playbook, openPatches },
      } satisfies ApiResponse<
        PlaybookWithDependencies & { openPatches: OpenPlaybookPatchSummary[] }
      >);
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies ApiResponse);
    }
  });

  fastify.post('/', async (request, reply) => {
    try {
      if (isDashboardClient(request)) {
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
      }

      const deckId = await resolveAgentDeckId(request, fastify.db);
      const input = AgentRegisterPlaybookSchema.parse(request.body);
      const playbook = await fastify.playbookManager.createWithDependencies(input);

      if (input.addToBoundDeck) {
        const alreadyOnDeck = await fastify.playbookManager.isPlaybookOnDeck(deckId, playbook.id);
        if (!alreadyOnDeck) {
          await fastify.playbookManager.addToDeck({ deckId, playbookId: playbook.id });
        }
      }

      const trigger_warnings = await triggerWarningsForDeck(
        fastify.playbookManager,
        deckId,
        { id: playbook.id, title: playbook.title, triggers: playbook.triggers },
      );

      return reply
        .status(201)
        .send({
          success: true,
          data: { ...playbook, trigger_warnings },
        } satisfies ApiResponse<PlaybookWithDependencies & { trigger_warnings?: unknown }>);
    } catch (error) {
      if (error instanceof AgentDeckContextError) {
        return reply.status(400).send({
          success: false,
          error: error.message,
        } satisfies ApiResponse);
      }
      if (error instanceof DashboardOnlyError) {
        const { status, body } = dashboardOnlyResponse(error);
        return reply.status(status === 403 ? 400 : status).send(body);
      }
      const forAgent = !isDashboardClient(request);
      return reply.status(400).send({
        success: false,
        error: formatPlaybookMutationError(error, forAgent),
      } satisfies ApiResponse);
    }
  });

  fastify.put<PlaybookIdRequest>('/:id', async (request, reply) => {
    try {
      if (isDashboardClient(request)) {
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
      }

      const deckId = await resolveAgentDeckId(request, fastify.db);
      const onDeck = await fastify.playbookManager.isPlaybookOnDeck(deckId, request.params.id);
      if (!onDeck) {
        return reply.status(403).send({
          success: false,
          error: 'Playbook not found on bound deck',
        } satisfies ApiResponse);
      }

      const input = AgentUpdatePlaybookSchema.parse(request.body);
      const playbook = await fastify.playbookManager.updateWithDependencies(request.params.id, input);
      if (!playbook) {
        return reply.status(404).send({ success: false, error: 'Playbook not found' } satisfies ApiResponse);
      }
      await fastify.patchManager.snapshotVersion(playbook, null, 'user');

      const trigger_warnings = await triggerWarningsForDeck(
        fastify.playbookManager,
        deckId,
        { id: playbook.id, title: playbook.title, triggers: playbook.triggers },
      );

      return reply.send({
        success: true,
        data: { ...playbook, trigger_warnings },
      } satisfies ApiResponse<PlaybookWithDependencies & { trigger_warnings?: unknown }>);
    } catch (error) {
      if (error instanceof AgentDeckContextError) {
        return reply.status(400).send({
          success: false,
          error: error.message,
        } satisfies ApiResponse);
      }
      if (error instanceof DashboardOnlyError) {
        const { status, body } = dashboardOnlyResponse(error);
        return reply.status(status === 403 ? 400 : status).send(body);
      }
      const forAgent = !isDashboardClient(request);
      return reply.status(400).send({
        success: false,
        error: formatPlaybookMutationError(error, forAgent),
      } satisfies ApiResponse);
    }
  });

  fastify.get<{ Params: { id: string } }>('/:id/events/count', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const count = await fastify.db.countPlaybookEvents(request.params.id);
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
      if (!isDashboardClient(request)) {
        await requirePlaybookOnBoundDeck(request, fastify.db, request.params.id);
      }

      const deleted = await fastify.playbookManager.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ success: false, error: 'Playbook not found' } satisfies ApiResponse);
      }
      return reply.send({ success: true, message: 'Playbook deleted successfully' } satisfies ApiResponse);
    } catch (error) {
      const scoped = boundDeckScopeResponse(error);
      return reply.status(scoped.status).send({
        success: false,
        error: scoped.message,
      } satisfies ApiResponse);
    }
  });
}

export { PlaybookDependencyError };
