import { useQuery } from "@tanstack/react-query";
import type {
  CardUsageCardsResponse,
  CardUsageCardSummary,
  CardUsageCardType,
  CardUsageCategory,
} from "@agent-deck/shared";

export type { CardUsageCardSummary, CardUsageCardType, CardUsageCategory };

export const CARD_USAGE_QUERY_KEY = ["/api/usage/cards"] as const;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Single fetch of the trailing-30-day card-usage classification for the
 * whole Collection (NOT-293/NOT-294). Callers share one request via the
 * query cache; on loading or error the hook yields `undefined` so cards
 * omit the mark instead of inferring a misleading category.
 */
export function useCardUsage() {
  return useQuery<{ success: boolean; data: CardUsageCardsResponse }>({
    queryKey: [...CARD_USAGE_QUERY_KEY],
    staleTime: 60_000,
  });
}

export type CardUsageLookup = Map<string, CardUsageCardSummary>;

export function cardUsageKey(cardType: CardUsageCardType, cardId: string): string {
  return `${cardType}:${cardId}`;
}

/** Index usage rows by `cardType:cardId` for O(1) per-card lookup. */
export function buildCardUsageLookup(
  cards: CardUsageCardSummary[] | undefined,
): CardUsageLookup {
  const lookup: CardUsageLookup = new Map();
  for (const row of cards ?? []) {
    lookup.set(cardUsageKey(row.cardType, row.cardId), row);
  }
  return lookup;
}

/**
 * Days of usage tracking behind a `new` classification, matching the
 * classifier's reason: a card is New while either the card itself or its
 * card-type observation coverage is younger than 30 days. Returns the
 * smaller of the two ages (coverage when known), clamped to >= 0, or null
 * when neither timestamp parses.
 */
export function cardUsageTrackingDays(
  summary: Pick<CardUsageCardSummary, "observedSince" | "windowEnd">,
  createdAt: string | undefined,
): number | null {
  const nowMs = Date.parse(summary.windowEnd);
  if (Number.isNaN(nowMs)) {
    return null;
  }
  const ages: number[] = [];
  if (createdAt !== undefined) {
    const createdMs = Date.parse(createdAt);
    if (!Number.isNaN(createdMs)) {
      ages.push(Math.floor((nowMs - createdMs) / MS_PER_DAY));
    }
  }
  if (summary.observedSince !== null) {
    const observedMs = Date.parse(summary.observedSince);
    if (!Number.isNaN(observedMs)) {
      ages.push(Math.floor((nowMs - observedMs) / MS_PER_DAY));
    }
  }
  if (ages.length === 0) {
    return null;
  }
  return Math.max(Math.min(...ages), 0);
}

/** Exact accessible/tooltip copy per category; meaning never depends on color. */
export function cardUsageLabel(
  summary: Pick<
    CardUsageCardSummary,
    "category" | "usageCount" | "observedSince" | "windowEnd"
  >,
  createdAt: string | undefined,
): string {
  switch (summary.category) {
    case "popular":
      return `Popular · ${summary.usageCount} uses in 30 days`;
    case "used":
      return `Used · ${summary.usageCount} uses in 30 days`;
    case "unused":
      return "Unused · 0 uses in 30 days";
    case "new": {
      const days = cardUsageTrackingDays(summary, createdAt);
      return days === null ? "New" : `New · tracking for ${days} days`;
    }
  }
}
