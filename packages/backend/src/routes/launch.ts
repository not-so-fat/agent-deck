import type { FastifyInstance } from 'fastify';

import { invalidDeckIdPathSegment } from '../lib/invalid-deck-id-path-segment';

/**
 * Public launch metadata for orchestrators (NOT-105).
 * Local-only listing of decks / playbook summaries — no credentials required
 * (same posture as `/api/scope/display`).
 */
export async function registerLaunchRoutes(fastify: FastifyInstance) {
  fastify.get('/decks', async (_request, reply) => {
    const decks = await fastify.db.getAllDecks();
    return reply.send({
      success: true,
      data: {
        decks: decks.map((deck) => ({ id: deck.id, name: deck.name })),
      },
    });
  });

  fastify.get<{ Params: { deckId: string } }>(
    '/decks/:deckId/playbooks',
    async (request, reply) => {
      const { deckId } = request.params;
      if (invalidDeckIdPathSegment(deckId)) {
        return reply.status(400).send({
          success: false,
          error: 'deckId must be a single path segment',
        });
      }
      if (!(await fastify.db.hasDeck(deckId))) {
        return reply.status(404).send({ success: false, error: 'Deck not found' });
      }
      const playbooks = await fastify.playbookManager.listSummariesForDeck(deckId);
      return reply.send({ success: true, data: playbooks });
    },
  );
}
