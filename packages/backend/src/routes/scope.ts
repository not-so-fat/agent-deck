import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ApiResponse,
  DeckCardCountsSchema,
  DeckDisplaySourceSchema,
  countDeckCards,
} from '@agent-deck/shared';
import { AgentDeckContextError, resolveAgentDeckId } from '../lib/agent-deck-context';
import { applyDeckScope, isDashboardClient, requireAgentClient } from '../lib/client-scope';
import { resolveDeckDisplay } from '../scope/display';

const LiveDisplayBodySchema = z.object({
  mcpSessionId: z.string().min(1),
  // Absent for header/auto-bound sessions (deck without a known folder).
  workspaceRoot: z.string().min(1).optional(),
  deckId: z.string().uuid(),
  deckName: z.string().min(1),
  source: DeckDisplaySourceSchema.exclude(['unbound']),
  clientName: z.string().min(1).optional(),
  cardCounts: DeckCardCountsSchema,
  updatedAt: z.string().datetime(),
});

const LiveDisplayTouchSchema = z.object({
  at: z.string().datetime().optional(),
});

const DeckWorkspaceBodySchema = z.object({
  workspaceRoot: z.string().min(1),
  deckId: z.string().uuid(),
});

export async function registerScopeRoutes(fastify: FastifyInstance) {
  fastify.get('/deck', async (request, reply) => {
    try {
      if (isDashboardClient(request)) {
        return reply.status(400).send({
          success: false,
          error: 'Use GET /api/decks/:id from the dashboard',
        } satisfies ApiResponse);
      }

      const deckId = await resolveAgentDeckId(request, fastify.db);
      const deck = await fastify.db.getDeck(deckId);
      if (!deck) {
        return reply.status(404).send({
          success: false,
          error: 'Deck not found',
        } satisfies ApiResponse);
      }

      const credentials = deck.credentials
        ? await fastify.credentialManager.applySecretStatus(deck.credentials)
        : [];
      const deckWithSecrets = { ...deck, credentials };
      const scoped = applyDeckScope(deckWithSecrets, 'agent', deckId);
      const playbookSummaries = await fastify.playbookManager.listSummariesForDeck(deckId);

      return reply.send({
        success: true,
        data: {
          ...scoped,
          playbooks: playbookSummaries,
        },
      } satisfies ApiResponse);
    } catch (error) {
      const status = error instanceof AgentDeckContextError ? 400 : 500;
      return reply.status(status).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies ApiResponse);
    }
  });

  fastify.get<{ Querystring: { workspaceRoot?: string } }>('/display', async (request, reply) => {
    try {
      const workspaceRoot = request.query.workspaceRoot?.trim();
      if (!workspaceRoot) {
        return reply.status(400).send({
          success: false,
          error: 'workspaceRoot query parameter is required',
        } satisfies ApiResponse);
      }

      const display = await resolveDeckDisplay(
        { workspaceRoot },
        fastify.db,
        fastify.liveDisplayRegistry,
      );
      return reply.send({
        success: true,
        data: display,
      } satisfies ApiResponse);
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } satisfies ApiResponse);
    }
  });

  fastify.post('/live-display', async (request, reply) => {
    try {
      requireAgentClient(request);
      const parsed = LiveDisplayBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.issues.map((issue) => issue.message).join('; '),
        } satisfies ApiResponse);
      }

      const entry = fastify.liveDisplayRegistry.upsert(parsed.data);
      return reply.send({ success: true, data: { badge: entry.badge } } satisfies ApiResponse);
    } catch (error) {
      return reply.status(403).send({
        success: false,
        error: error instanceof Error ? error.message : 'Forbidden',
      } satisfies ApiResponse);
    }
  });

  fastify.delete<{ Params: { mcpSessionId: string } }>(
    '/live-display/:mcpSessionId',
    async (request, reply) => {
      try {
        requireAgentClient(request);
        const mcpSessionId = request.params.mcpSessionId?.trim();
        if (!mcpSessionId) {
          return reply.status(400).send({
            success: false,
            error: 'mcpSessionId is required',
          } satisfies ApiResponse);
        }

        fastify.liveDisplayRegistry.remove(mcpSessionId);
        return reply.send({ success: true } satisfies ApiResponse);
      } catch (error) {
        return reply.status(403).send({
          success: false,
          error: error instanceof Error ? error.message : 'Forbidden',
        } satisfies ApiResponse);
      }
    },
  );

  fastify.post<{ Params: { mcpSessionId: string } }>(
    '/live-display/:mcpSessionId/touch',
    async (request, reply) => {
      try {
        requireAgentClient(request);
        const mcpSessionId = request.params.mcpSessionId?.trim();
        if (!mcpSessionId) {
          return reply.status(400).send({
            success: false,
            error: 'mcpSessionId is required',
          } satisfies ApiResponse);
        }

        const parsed = LiveDisplayTouchSchema.safeParse(request.body ?? {});
        const at = parsed.success && parsed.data.at ? parsed.data.at : new Date().toISOString();
        fastify.liveDisplayRegistry.touch(mcpSessionId, at);
        return reply.send({ success: true } satisfies ApiResponse);
      } catch (error) {
        return reply.status(403).send({
          success: false,
          error: error instanceof Error ? error.message : 'Forbidden',
        } satisfies ApiResponse);
      }
    },
  );

  fastify.post('/deck-workspace', async (request, reply) => {
    try {
      requireAgentClient(request);
      const parsed = DeckWorkspaceBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.issues.map((issue) => issue.message).join('; '),
        } satisfies ApiResponse);
      }

      await fastify.db.upsertDeckWorkspace(parsed.data.workspaceRoot, parsed.data.deckId);
      return reply.send({ success: true } satisfies ApiResponse);
    } catch (error) {
      return reply.status(403).send({
        success: false,
        error: error instanceof Error ? error.message : 'Forbidden',
      } satisfies ApiResponse);
    }
  });

  fastify.get('/bindings', async (_request, reply) => {
    const data = fastify.liveDisplayRegistry.list().map((entry) => ({
      badge: entry.badge,
      deckId: entry.deckId,
      deckName: entry.deckName,
      source: entry.source,
      workspaceRoot: entry.workspaceRoot,
      clientName: entry.clientName,
      mode: fastify.trustedSessionStore.getRuntimeSessionModeByMcpSessionId(entry.mcpSessionId) ?? undefined,
      cardCounts: entry.cardCounts,
      updatedAt: entry.updatedAt,
      lastActivityAt: entry.lastActivityAt,
    }));
    return reply.send({ success: true, data } satisfies ApiResponse);
  });
}
