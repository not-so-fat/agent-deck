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
