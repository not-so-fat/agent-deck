import {
  CARD_USAGE_CARD_TYPES,
  CardUsageCardType,
  CardUsageCardSummary,
  CardUsageCategory,
} from '@agent-deck/shared';

/** Fixed trailing window for card-usage classification (NOT-293). */
export const CARD_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A card below this many successful uses is never Popular. */
export const CARD_USAGE_POPULAR_MIN_COUNT = 3;
/** Popular cards sit at or above this percentile within their card type. */
export const CARD_USAGE_POPULAR_PERCENTILE = 80;

export interface CardUsageClassifierCard {
  cardType: CardUsageCardType;
  cardId: string;
  /** ISO-8601 creation timestamp of the card. */
  createdAt: string;
}

export interface CardUsageClassifierAggregate {
  cardType: CardUsageCardType;
  cardId: string;
  /** Successful uses in [windowStart, windowEnd). */
  count: number;
  /** Latest successful in-window use, or null when there is none. */
  lastUsedAt: string | null;
}

/**
 * Deterministic 80th-percentile cutoff (nearest-rank) over the per-type
 * usage counts. Comparison is `count >= threshold`, so cards tied at the
 * cutoff always classify identically.
 */
export function popularCountThreshold(counts: number[]): number | null {
  if (counts.length === 0) {
    return null;
  }
  const sorted = [...counts].sort((a, b) => a - b);
  const rank = Math.ceil((CARD_USAGE_POPULAR_PERCENTILE / 100) * sorted.length);
  return sorted[Math.max(rank - 1, 0)];
}

function coverageMs(nowMs: number, since: string | null): number | null {
  if (since === null) {
    return null;
  }
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? null : nowMs - parsed;
}

/**
 * Pure NOT-293 classifier. All timestamps are ISO-8601 strings; `now`
 * is injected so tests can freeze the clock. Output is sorted by
 * (cardType, cardId) for stable responses.
 *
 * Precedence within each card type:
 * 1. Popular — count >= 3 and at/above the 80th percentile.
 * 2. New — not Popular, and the card is younger than 30 days or its card
 *    type has less than 30 days of observation coverage (null start counts
 *    as insufficient coverage, so such cards are never Unused).
 * 3. Used — at least 1 successful use.
 * 4. Unused — fully observed for at least 30 days with 0 successful uses.
 */
export function classifyCardUsage(input: {
  now: string;
  windowStart: string;
  windowEnd: string;
  cards: CardUsageClassifierCard[];
  usage: CardUsageClassifierAggregate[];
  observationStarts: Record<CardUsageCardType, string | null>;
}): CardUsageCardSummary[] {
  const nowMs = Date.parse(input.now);
  const countsByKey = new Map<string, CardUsageClassifierAggregate>();
  for (const aggregate of input.usage) {
    countsByKey.set(`${aggregate.cardType}:${aggregate.cardId}`, aggregate);
  }

  const thresholds = new Map<CardUsageCardType, number | null>();
  for (const cardType of CARD_USAGE_CARD_TYPES) {
    const counts = input.cards
      .filter((card) => card.cardType === cardType)
      .map((card) => countsByKey.get(`${card.cardType}:${card.cardId}`)?.count ?? 0);
    thresholds.set(cardType, popularCountThreshold(counts));
  }

  const rows = input.cards.map((card): CardUsageCardSummary => {
    const aggregate = countsByKey.get(`${card.cardType}:${card.cardId}`);
    const usageCount = aggregate?.count ?? 0;
    const lastUsedAt = aggregate?.lastUsedAt ?? null;
    const observedSince = input.observationStarts[card.cardType] ?? null;

    const threshold = thresholds.get(card.cardType) ?? null;
    const isPopular =
      threshold !== null &&
      usageCount >= CARD_USAGE_POPULAR_MIN_COUNT &&
      usageCount >= threshold;

    let category: CardUsageCategory;
    if (isPopular) {
      category = 'popular';
    } else {
      const observedMs = coverageMs(nowMs, observedSince);
      const cardAgeMs = nowMs - Date.parse(card.createdAt);
      const fullyObserved =
        observedMs !== null &&
        observedMs >= CARD_USAGE_WINDOW_MS &&
        !Number.isNaN(cardAgeMs) &&
        cardAgeMs >= CARD_USAGE_WINDOW_MS;
      if (!fullyObserved) {
        category = 'new';
      } else if (usageCount >= 1) {
        category = 'used';
      } else {
        category = 'unused';
      }
    }

    return {
      cardType: card.cardType,
      cardId: card.cardId,
      category,
      usageCount,
      lastUsedAt,
      observedSince,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
    };
  });

  rows.sort((a, b) =>
    a.cardType === b.cardType
      ? (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0)
      : (a.cardType < b.cardType ? -1 : 1),
  );
  return rows;
}
