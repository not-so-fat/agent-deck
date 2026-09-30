import { describe, expect, it } from "vitest";

import {
  buildCardUsageLookup,
  cardUsageKey,
  cardUsageLabel,
  cardUsageTrackingDays,
  CARD_USAGE_QUERY_KEY,
} from "@/lib/card-usage";
import type { CardUsageCardSummary } from "@/lib/card-usage";

const WINDOW_END = "2026-09-30T00:00:00.000Z";
const WINDOW_START = "2026-08-31T00:00:00.000Z";

function row(overrides: Partial<CardUsageCardSummary>): CardUsageCardSummary {
  return {
    cardType: "service",
    cardId: "svc-1",
    category: "used",
    usageCount: 1,
    lastUsedAt: null,
    observedSince: "2026-08-01T00:00:00.000Z",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    ...overrides,
  };
}

describe("card-usage lib (NOT-294)", () => {
  it("exposes the single shared query key for /api/usage/cards", () => {
    expect([...CARD_USAGE_QUERY_KEY]).toEqual(["/api/usage/cards"]);
  });

  it("indexes rows by cardType:cardId", () => {
    const lookup = buildCardUsageLookup([
      row({ cardType: "service", cardId: "svc-1" }),
      row({ cardType: "credential", cardId: "svc-1", category: "unused", usageCount: 0 }),
    ]);
    expect(lookup.get(cardUsageKey("service", "svc-1"))?.category).toBe("used");
    expect(lookup.get(cardUsageKey("credential", "svc-1"))?.category).toBe("unused");
    expect(lookup.get(cardUsageKey("playbook", "svc-1"))).toBeUndefined();
  });

  it("returns an empty lookup for missing data (loading/error omits the mark)", () => {
    expect(buildCardUsageLookup(undefined).size).toBe(0);
  });

  it("labels popular/used/unused with the exact count copy", () => {
    expect(cardUsageLabel(row({ category: "popular", usageCount: 5 }), undefined)).toBe(
      "Popular · 5 uses in 30 days",
    );
    expect(cardUsageLabel(row({ category: "used", usageCount: 1 }), undefined)).toBe(
      "Used · 1 uses in 30 days",
    );
    expect(cardUsageLabel(row({ category: "unused", usageCount: 0 }), undefined)).toBe(
      "Unused · 0 uses in 30 days",
    );
  });

  it("labels new with tracking days from the younger of card age / coverage", () => {
    // Young card, old coverage -> card age wins (10 days).
    expect(
      cardUsageLabel(
        row({ category: "new", observedSince: "2026-08-01T00:00:00.000Z" }),
        "2026-09-20T00:00:00.000Z",
      ),
    ).toBe("New · tracking for 10 days");
    // Old card, young coverage -> coverage wins (3 days).
    expect(
      cardUsageLabel(
        row({ category: "new", observedSince: "2026-09-27T00:00:00.000Z" }),
        "2026-08-01T00:00:00.000Z",
      ),
    ).toBe("New · tracking for 3 days");
  });

  it("labels new without a day count when no timestamp parses", () => {
    expect(
      cardUsageLabel(row({ category: "new", observedSince: null }), undefined),
    ).toBe("New");
  });

  it("clamps tracking days at zero and rejects bad windows", () => {
    expect(
      cardUsageTrackingDays(
        { observedSince: "2026-08-01T00:00:00.000Z", windowEnd: WINDOW_END },
        "2026-10-05T00:00:00.000Z",
      ),
    ).toBe(0);
    expect(
      cardUsageTrackingDays(
        { observedSince: null, windowEnd: "not-a-date" },
        "also-bad",
      ),
    ).toBeNull();
  });
});
