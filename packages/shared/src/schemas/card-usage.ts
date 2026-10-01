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
  /** Opaque run-correlation id (NOT-304); null for sessions without one. */
  correlationId: string | null;
  createdAt: string;
};

/**
 * Opaque run-correlation identifier (NOT-304).
 *
 * A UUID or an equivalently strict bounded token: ASCII letters, digits,
 * `-`/`_` only, 8–128 chars. The charset excludes whitespace, `/`, `.`,
 * `:`, and every other punctuation mark, so repository paths
 * (`owner/repo`), issue titles, prompts, task content, and URLs can never
 * validate — they are rejected, never truncated or interpreted. Bare
 * word-like slugs are opaque by construction: they are stored verbatim,
 * matched exactly, and never resolved to a deck, workspace, or identity.
 */
const CORRELATION_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CORRELATION_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** True for a UUID or strict bounded token; false for free text. */
export function isValidCorrelationId(value: string): boolean {
  return CORRELATION_UUID_RE.test(value) || CORRELATION_TOKEN_RE.test(value);
}

/**
 * Trim and accept a candidate correlation id, or return null when it is
 * absent or fails strict validation. Invalid values are dropped — never
 * coerced — so untrusted input cannot smuggle task content into the stream.
 */
export function normalizeCorrelationId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (!value || !isValidCorrelationId(value)) {
    return null;
  }
  return value;
}

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
  /** Opaque run-correlation id (NOT-304); null for sessions without one. */
  correlationId: string | null;
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
