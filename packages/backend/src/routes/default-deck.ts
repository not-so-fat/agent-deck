import type { FastifyInstance } from 'fastify';
import { clearDefaultDeck, readDefaultDeck, writeDefaultDeck } from '@agent-deck/shared';

/**
 * User default deck (NOT-600): the deck a headerless local MCP session binds
 * when no launch deck header and no folder assignment resolve. Stored in
 * `$AGENT_DECK_HOME/default-deck.json`; `deckId` is authoritative and the
 * stored `deckName` is display-only.
 *
 * Dashboard-only (see `HTTP_ROUTE_POLICIES`): agents never read or write the
 * default through this API — they see it as the `default-deck` binding
 * source on their session.
 */
export async function registerDefaultDeckRoutes(fastify: FastifyInstance) {
  fastify.get('/default-deck', async (_request, reply) => {
    return reply.send({ success: true, data: readDefaultDeck() });
  });

  fastify.put<{ Body: { deckId?: unknown } }>('/default-deck', async (request, reply) => {
    const deckId = typeof request.body?.deckId === 'string' ? request.body.deckId.trim() : '';
    if (!deckId) {
      return reply.status(400).send({ success: false, error: 'deckId required' });
    }
    const deck = await fastify.db.getDeck(deckId);
    if (!deck) {
      return reply.status(404).send({ success: false, error: 'Deck not found' });
    }
    writeDefaultDeck({ deckId: deck.id, deckName: deck.name });
    return reply.send({ success: true, data: readDefaultDeck() });
  });

  fastify.delete('/default-deck', async (_request, reply) => {
    const cleared = clearDefaultDeck();
    return reply.send({ success: true, data: { cleared } });
  });
}
