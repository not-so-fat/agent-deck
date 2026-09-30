export const CARD_USAGE_CARD_TYPES = ['service', 'credential', 'playbook'] as const;

export type CardUsageCardType = (typeof CARD_USAGE_CARD_TYPES)[number];

/** Normalized, privacy-safe card-usage event (database shape). */
export type CardUsageEvent = {
  id: string;
  cardType: CardUsageCardType;
  cardId: string;
  deckId: string | null;
  action: string;
  success: boolean | null;
  source: string;
  sessionId: string | null;
  createdAt: string;
};

/**
 * Raw event payload exposed by GET /api/usage/events.
 * Contains only non-sensitive usage metadata — never tool arguments,
 * tool results, command contents, URLs, headers, OAuth data, or API keys.
 */
export type CardUsageEventResponse = {
  occurredAt: string;
  cardType: CardUsageCardType;
  cardId: string;
  deckId: string | null;
  action: string;
  success: boolean | null;
  source: string;
  sessionId: string | null;
};

export type CardUsageEventsResponse = {
  events: CardUsageEventResponse[];
  nextCursor: string | null;
};

export const CARD_USAGE_CATEGORIES = ['popular', 'used', 'unused', 'new'] as const;

/**
 * Trailing-30-day classification for a Collection card (NOT-293).
 * Computed separately within each card type with Popular > New > Used > Unused
 * precedence; see the backend classifier for the exact rules.
 */
export type CardUsageCategory = (typeof CARD_USAGE_CATEGORIES)[number];

/**
 * One row of GET /api/usage/cards. `usageCount` counts only successful
 * events in `[windowStart, windowEnd)`; `lastUsedAt` is the latest such
 * event, or null when there is none. `observedSince` is the card-type
 * usage-tracking start (null when the store predates tracking).
 */
export type CardUsageCardSummary = {
  cardType: CardUsageCardType;
  cardId: string;
  category: CardUsageCategory;
  usageCount: number;
  lastUsedAt: string | null;
  observedSince: string | null;
  windowStart: string;
  windowEnd: string;
};

export type CardUsageCardsResponse = {
  cards: CardUsageCardSummary[];
};
