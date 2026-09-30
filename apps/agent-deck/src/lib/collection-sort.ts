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
      if (typeof aCount === "number" && typeof bCount === "number") {
        if (aCount !== bCount) {
          return descending ? bCount - aCount : aCount - bCount;
        }
        return a.index - b.index;
      }
      // At least one side is unknown. Unknown rows trail every measured row
      // in both directions — they are not zero, so they never mingle with
      // measured rows. Two unknowns keep their Default relative order.
      if (typeof aCount === "number") {
        return -1;
      }
      if (typeof bCount === "number") {
        return 1;
      }
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

// ---------------------------------------------------------------------------
// Filter + Default-order build (pure; NOT-302 review).
//
// The same search/type/warnings filtering that the Collection grid applies
// before sorting, extracted so the filter-then-sort composition is unit
// testable. Field shapes mirror exactly what the page filters on.
// ---------------------------------------------------------------------------

/** Minimal service fields the Collection search/type filter reads. */
export interface CollectionFilterService {
  id: string;
  name: string;
  description?: string | null;
  type: string;
}

/** Minimal credential fields the Collection search/type filter reads. */
export interface CollectionFilterCredential {
  id: string;
  label: string;
}

/** Minimal playbook fields the Collection search/type filter reads. */
export interface CollectionFilterPlaybook {
  id: string;
  title: string;
  body: string;
}

export interface CollectionFilterInput {
  services: readonly CollectionFilterService[];
  credentials: readonly CollectionFilterCredential[];
  playbooks: readonly CollectionFilterPlaybook[];
}

/** Anything with key membership: the warnings view uses Maps, tests use Sets. */
export interface CollectionWarningSets {
  serviceWarnings: { has(id: string): boolean };
  credentialWarnings: { has(id: string): boolean };
  playbookWarnings: { has(id: string): boolean };
}

export interface CollectionFilterOptions {
  searchQuery: string;
  /** "" or "all" means no type restriction; mirrors the page's Type select. */
  typeFilter: string;
  warningsOnly: boolean;
  warnings: CollectionWarningSets;
  /** Raw 30-day count per card; unknown (null/undefined) when missing. */
  getUsageCount: (
    kind: CardUsageCardType,
    id: string,
  ) => number | null | undefined;
}

/**
 * Apply the Collection search, type, and warnings filters and return the
 * Default-ordered mixed descriptor list: playbooks, then credentials, then
 * services — the exact pre-ticket group order. Pass the result to
 * `sortCollectionItems` for usage sorting.
 */
export function buildDefaultOrderedCollection(
  input: CollectionFilterInput,
  options: CollectionFilterOptions,
): CollectionSortItem[] {
  const query = options.searchQuery.toLowerCase();
  const { typeFilter, warningsOnly, warnings } = options;

  const warned = (kind: CardUsageCardType, id: string): boolean => {
    if (!warningsOnly) {
      return true;
    }
    if (kind === "service") {
      return warnings.serviceWarnings.has(id);
    }
    if (kind === "credential") {
      return warnings.credentialWarnings.has(id);
    }
    return warnings.playbookWarnings.has(id);
  };

  const out: CollectionSortItem[] = [];

  for (const playbook of input.playbooks) {
    if (!warned("playbook", playbook.id)) continue;
    if (typeFilter && typeFilter !== "all" && typeFilter !== "playbook") continue;
    const matchesSearch =
      playbook.title.toLowerCase().includes(query) ||
      playbook.body.toLowerCase().includes(query);
    if (!matchesSearch) continue;
    out.push({
      kind: "playbook",
      id: playbook.id,
      usageCount: options.getUsageCount("playbook", playbook.id),
    });
  }

  for (const credential of input.credentials) {
    if (!warned("credential", credential.id)) continue;
    if (typeFilter && typeFilter !== "all" && typeFilter !== "api-key") continue;
    if (!credential.label.toLowerCase().includes(query)) continue;
    out.push({
      kind: "credential",
      id: credential.id,
      usageCount: options.getUsageCount("credential", credential.id),
    });
  }

  for (const service of input.services) {
    if (!warned("service", service.id)) continue;
    if (typeFilter === "api-key" || typeFilter === "playbook") continue;
    const matchesSearch =
      service.name.toLowerCase().includes(query) ||
      (service.description?.toLowerCase().includes(query) ?? false);
    const matchesType =
      !typeFilter || typeFilter === "all" || service.type === typeFilter;
    if (!matchesSearch || !matchesType) continue;
    out.push({
      kind: "service",
      id: service.id,
      usageCount: options.getUsageCount("service", service.id),
    });
  }

  return out;
}
