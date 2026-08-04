import { FastifyInstance } from 'fastify';
import {
  ApiResponse,
  ProposePlaybookPatchSchema,
  RejectPlaybookPatchSchema,
  TriggerValidationError,
  triggerErrorMessage,
  type PatchPreview,
  type PlaybookPatch,
  type PlaybookPatchListItem,
  type PlaybookPatchSource,
  type ProposePlaybookPatchResult,
  type FeedbackSignal,
  AGENT_DECK_CLIENT_HEADER,
} from '@agent-deck/shared';
import { requireDashboardClient } from '../lib/client-scope';
import { AgentDeckContextError, resolveAgentDeckId } from '../lib/agent-deck-context';
import {
  PatchConflictError,
  PatchNoChangeError,
  PatchSupersedeError,
} from '../playbooks/patch-manager';

function headerValue(request: { headers: Record<string, unknown> }, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolvePatchProvenance(request: {
  headers: Record<string, unknown>;
}): { source: PlaybookPatchSource; sourceRef: string | null } {
  const client = headerValue(request, AGENT_DECK_CLIENT_HEADER);
  if (client?.toLowerCase() === 'dealer') {
    return {
      source: 'dealer',
      sourceRef: headerValue(request, 'x-agent-deck-source-ref') ?? null,
    };
  }
  return {
    source: 'ide',
    sourceRef: headerValue(request, 'x-mcp-session-id') ?? null,
  };
}

export async function registerPlaybookPatchRoutes(fastify: FastifyInstance) {
  fastify.post('/', async (request, reply) => {
    try {
      const body = ProposePlaybookPatchSchema.parse(request.body);
      const deckId = await resolveAgentDeckId(request, fastify.db).catch(() => null);
      const { source, sourceRef } = resolvePatchProvenance(request);
      const result = await fastify.patchManager.propose(
        body,
        source,
        sourceRef,
        deckId ?? undefined,
      );
      if (result.kind === 'signal_only') {
        return reply.status(201).send({
          success: true,
          data: result,
        } satisfies ApiResponse<ProposePlaybookPatchResult>);
      }
      // Keep `data` a flat PlaybookPatch (top-level `id`/`playbookId`) — agent-dealer's
      // proposePlaybookPatch adapter reads json.data.id directly and would break otherwise.
      // `signal` / `superseded` / `kind` ride alongside so MCP can surface them.
      return reply.status(201).send({
        success: true,
        data: {
          ...result.patch,
          kind: result.kind,
          signal: result.signal,
          superseded: result.superseded,
        },
      } satisfies ApiResponse<
        PlaybookPatch & {
          kind: ProposePlaybookPatchResult['kind'];
          signal: FeedbackSignal | null;
          superseded: string[];
        }
      >);
    } catch (error) {
      if (error instanceof PatchSupersedeError) {
        return reply.status(400).send({
          success: false,
          error: error.message,
        } satisfies ApiResponse);
      }
      if (error instanceof PatchConflictError || error instanceof PatchNoChangeError) {
        return reply.status(409).send({
          success: false,
          error: error.message,
        } satisfies ApiResponse);
      }
      if (error instanceof TriggerValidationError) {
        return reply.status(400).send({
          success: false,
          error: triggerErrorMessage(error, true),
        } satisfies ApiResponse);
      }
      const status = error instanceof AgentDeckContextError ? 400 : 400;
      return reply.status(status).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies ApiResponse);
    }
  });

  fastify.get<{ Querystring: { status?: PlaybookPatch['status'] } }>('/', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const patches = await fastify.patchManager.listForReview(request.query.status);
      return reply.send({ success: true, data: patches } satisfies ApiResponse<PlaybookPatchListItem[]>);
    } catch (error) {
      return reply.status(403).send({
        success: false,
        error: error instanceof Error ? error.message : 'Forbidden',
      } satisfies ApiResponse);
    }
  });

  fastify.get<{ Params: { id: string } }>('/:id/preview', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const preview = await fastify.patchManager.preview(request.params.id);
      if (!preview) {
        return reply.status(404).send({ success: false, error: 'Patch not found' } satisfies ApiResponse);
      }
      return reply.send({ success: true, data: preview } satisfies ApiResponse<PatchPreview>);
    } catch (error) {
      if (error instanceof PatchConflictError) {
        return reply.status(409).send({ success: false, error: error.message } satisfies ApiResponse);
      }
      return reply.status(403).send({
        success: false,
        error: error instanceof Error ? error.message : 'Forbidden',
      } satisfies ApiResponse);
    }
  });

  fastify.post<{ Params: { id: string } }>('/:id/accept', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const patch = await fastify.patchManager.accept(request.params.id);
      return reply.send({
        success: true,
        data: patch,
      } satisfies ApiResponse<PlaybookPatch>);
    } catch (error) {
      if (error instanceof PatchConflictError) {
        return reply.status(409).send({ success: false, error: error.message } satisfies ApiResponse);
      }
      const status = error instanceof Error && error.message.includes('not found') ? 404 : 400;
      return reply.status(status).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies ApiResponse);
    }
  });

  fastify.post<{ Params: { id: string } }>('/:id/reject', async (request, reply) => {
    try {
      requireDashboardClient(request);
      const { reason } = RejectPlaybookPatchSchema.parse(request.body ?? {});
      const patch = await fastify.patchManager.reject(request.params.id, reason ?? null);
      if (!patch) {
        return reply.status(404).send({ success: false, error: 'Patch not found' } satisfies ApiResponse);
      }
      return reply.send({ success: true, data: patch } satisfies ApiResponse<PlaybookPatch>);
    } catch (error) {
      return reply.status(400).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies ApiResponse);
    }
  });
}

export function playbookEventSource(request: { headers: Record<string, unknown> }): string {
  const client = request.headers[AGENT_DECK_CLIENT_HEADER];
  if (typeof client === 'string' && client.length > 0) return client;
  return 'rest';
}
