import { FastifyInstance, FastifyReply } from 'fastify';
import {
  ApiResponse,
  CardUsageCardsResponse,
  CardUsageEventResponse,
  CardUsageEventsResponse,
} from '@agent-deck/shared';
import {
  CARD_USAGE_WINDOW_MS,
  classifyCardUsage,
  CardUsageClassifierAggregate,
  CardUsageClassifierCard,
} from '../services/card-usage-classifier';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 250;
const TRAILING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface UsageEventsQuery {
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
}

function sendBadRequest(reply: FastifyReply, message: string) {
  return reply.status(400).send({ success: false, error: message } satisfies ApiResponse);
}

// Strict ISO-8601 datetime: a date plus a `T`-separated time. Loose inputs
// that Date.parse accepts ("Sep 1 2026", "2026", "2026-09-01") are rejected.
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;

function isStrictIsoTimestamp(value: string): boolean {
  return ISO_DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * GET /api/usage/events — raw, privacy-safe card-usage events for
 * pandas/Jupyter analysis. Stable chronological cursor pagination over
 * (occurredAt ASC, id ASC); both time bounds are inclusive.
 */
export async function registerUsageRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/usage/cards — one classification row for every current
   * service, credential, and playbook card over the fixed trailing 30-day
   * window `[windowStart, windowEnd)`. No custom range is accepted.
   * Authentication follows the app's normal route policy
   * (requireAgentOrDashboard in the HTTP route-policy registry).
   */
  fastify.get('/cards', async (_request, reply) => {
    const windowEnd = new Date(Date.now()).toISOString();
    const windowStart = new Date(Date.parse(windowEnd) - CARD_USAGE_WINDOW_MS).toISOString();

    const [services, credentials, playbooks, observationStarts, summary] = await Promise.all([
      fastify.db.getAllServices(),
      fastify.db.getAllCredentials(),
      fastify.db.getAllPlaybooks(),
      fastify.db.getUsageObservationStarts(),
      fastify.db.getSuccessfulCardUsageSummary({ windowStart, windowEnd }),
    ]);

    const cards: CardUsageClassifierCard[] = [
      ...services.map((service) => ({
        cardType: 'service' as const,
        cardId: service.id,
        createdAt: service.registeredAt,
      })),
      ...credentials.map((credential) => ({
        cardType: 'credential' as const,
        cardId: credential.id,
        createdAt: credential.createdAt,
      })),
      ...playbooks.map((playbook) => ({
        cardType: 'playbook' as const,
        cardId: playbook.id,
        createdAt: playbook.createdAt,
      })),
    ];
    const usage: CardUsageClassifierAggregate[] = summary.map((row) => ({
      cardType: row.cardType,
      cardId: row.cardId,
      count: row.usageCount,
      lastUsedAt: row.lastUsedAt,
    }));

    const data: CardUsageCardsResponse = {
      cards: classifyCardUsage({
        now: windowEnd,
        windowStart,
        windowEnd,
        cards,
        usage,
        observationStarts,
      }),
    };
    return reply.send({ success: true, data } satisfies ApiResponse<CardUsageCardsResponse>);
  });

  fastify.get<{ Querystring: UsageEventsQuery }>('/events', async (request, reply) => {
    const now = Date.now();

    let from = request.query.from ?? new Date(now - TRAILING_WINDOW_MS).toISOString();
    let to = request.query.to ?? new Date(now).toISOString();
    if (!isStrictIsoTimestamp(from)) {
      return sendBadRequest(reply, 'Invalid `from` timestamp — expected ISO 8601');
    }
    if (!isStrictIsoTimestamp(to)) {
      return sendBadRequest(reply, 'Invalid `to` timestamp — expected ISO 8601');
    }
    // Canonicalize so string comparison matches chronological order.
    from = new Date(from).toISOString();
    to = new Date(to).toISOString();
    if (from > to) {
      return sendBadRequest(reply, '`from` must not be after `to`');
    }

    let limit = DEFAULT_LIMIT;
    if (request.query.limit !== undefined) {
      const parsed = Number(request.query.limit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return sendBadRequest(reply, '`limit` must be an integer between 1 and 250');
      }
      limit = parsed;
    }

    let events;
    let nextCursor: string | null;
    try {
      ({ events, nextCursor } = await fastify.db.listCardUsageEvents({
        from,
        to,
        cursor: request.query.cursor ?? null,
        limit,
      }));
    } catch (error) {
      return sendBadRequest(
        reply,
        error instanceof Error ? error.message : 'Invalid request',
      );
    }

    // Project to the public shape — no payloads, arguments, results,
    // commands, URLs, headers, OAuth data, or secrets ever leave the store.
    const data: CardUsageEventsResponse = {
      events: events.map(
        (event): CardUsageEventResponse => ({
          occurredAt: event.createdAt,
          cardType: event.cardType,
          cardId: event.cardId,
          deckId: event.deckId,
          action: event.action,
          success: event.success,
          source: event.source,
          sessionId: event.sessionId,
        }),
      ),
      nextCursor,
    };
    return reply.send({ success: true, data } satisfies ApiResponse<CardUsageEventsResponse>);
  });
}
