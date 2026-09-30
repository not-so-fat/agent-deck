import type { CardUsageCardType } from "@/lib/card-usage";

/** Collection sort modes (NOT-302). Local page state; resets on reload. */
export type CollectionSortMode = "default" | "most-used" | "least-used";

export const COLLECTION_SORT_MODES: readonly CollectionSortMode[] = [
  "default",
  "most-used",
  "least-used",
] as const;

/**
 * Minimal per-card descriptor for mixed-collection sorting. `usageCount` is
 * the raw successful-use count from `GET /api/usage/cards` over the fixed
 * trailing 30-day window — never a per-day ratio. `undefined` (or null)
 * means unknown (missing/loading/error), which is not zero.
 */
export interface CollectionSortItem {
  kind: CardUsageCardType;
  id: string;
  /** Raw 30-day successful-use count; unknown when missing. */
  usageCount: number | null | undefined;
}

/**
 * Sort one already-filtered mixed collection (search, type, and warnings
 * filters applied by the caller) by raw 30-day `usageCount`.
 *
 * - "default": exact input order (pre-ticket playbooks, credentials, services).
 * - "most-used": descending count; "least-used": ascending count.
 * - Equal counts keep their input (Default) relative order (stable).
 * - Unknown rows (missing usage) sort after every measured row in both
 *   usage directions, preserving their Default relative order.
 * - When `usageAvailable` is false (loading/error), input order is returned
 *   untouched regardless of mode so missing data never counts as zero.
 */
export function sortCollectionItems<T extends CollectionSortItem>(
  items: readonly T[],
  mode: CollectionSortMode,
  usageAvailable: boolean,
): T[] {
  if (mode === "default" || !usageAvailable) {
    return [...items];
  }
  const descending = mode === "most-used";
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aCount = a.item.usageCount;
      const bCount = b.item.usageCount;
      const aKnown = typeof aCount === "number";
      const bKnown = typeof bCount === "number";
      if (aKnown && !bKnown) return -1;
      if (!aKnown && !bKnown) return a.index - b.index;
      if (!aKnown || !bKnown) return 1;
      if (aCount !== bCount) {
        return descending
          ? (bCount as number) - (aCount as number)
          : (aCount as number) - (bCount as number);
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}
