import { describe, expect, it } from "vitest";

import {
  sortCollectionItems,
  type CollectionSortItem,
} from "@/lib/collection-sort";

function item(
  kind: CollectionSortItem["kind"],
  id: string,
  usageCount: number | null | undefined,
): CollectionSortItem {
  return { kind, id, usageCount };
}

// Default pre-ticket order: playbooks, then credentials, then services.
const mixed: CollectionSortItem[] = [
  item("playbook", "pb-a", 2),
  item("credential", "cred-a", 5),
  item("service", "svc-a", 1),
  item("playbook", "pb-b", 5),
  item("service", "svc-b", 0),
];

const ids = (rows: CollectionSortItem[]) => rows.map((r) => r.id);

describe("sortCollectionItems (NOT-302)", () => {
  it("default preserves the exact input order", () => {
    expect(ids(sortCollectionItems(mixed, "default", true))).toEqual(ids(mixed));
  });

  it("most-used sorts the whole mixed collection by descending count", () => {
    expect(ids(sortCollectionItems(mixed, "most-used", true))).toEqual([
      "cred-a",
      "pb-b",
      "pb-a",
      "svc-a",
      "svc-b",
    ]);
  });

  it("least-used sorts the whole mixed collection by ascending count", () => {
    expect(ids(sortCollectionItems(mixed, "least-used", true))).toEqual([
      "svc-b",
      "svc-a",
      "pb-a",
      "cred-a",
      "pb-b",
    ]);
  });

  it("breaks count ties by Default relative order (stable)", () => {
    const tied: CollectionSortItem[] = [
      item("service", "svc-1", 3),
      item("playbook", "pb-1", 3),
      item("credential", "cred-1", 3),
    ];
    expect(ids(sortCollectionItems(tied, "most-used", true))).toEqual([
      "svc-1",
      "pb-1",
      "cred-1",
    ]);
    expect(ids(sortCollectionItems(tied, "least-used", true))).toEqual([
      "svc-1",
      "pb-1",
      "cred-1",
    ]);
  });

  it("places unknown rows after measured rows in both directions, never as zero", () => {
    const rows: CollectionSortItem[] = [
      item("service", "unknown-1", undefined),
      item("service", "zero", 0),
      item("service", "top", 9),
      item("credential", "unknown-2", null),
      item("service", "mid", 1),
    ];
    // Unknowns trail even the zero-count card: they are not zero.
    expect(ids(sortCollectionItems(rows, "most-used", true))).toEqual([
      "top",
      "mid",
      "zero",
      "unknown-1",
      "unknown-2",
    ]);
    expect(ids(sortCollectionItems(rows, "least-used", true))).toEqual([
      "zero",
      "mid",
      "top",
      "unknown-1",
      "unknown-2",
    ]);
  });

  it("leaves Default order intact while usage is loading or unavailable", () => {
    expect(ids(sortCollectionItems(mixed, "most-used", false))).toEqual(ids(mixed));
    expect(ids(sortCollectionItems(mixed, "least-used", false))).toEqual(ids(mixed));
  });

  it("does not mutate the input array", () => {
    const before = ids(mixed);
    sortCollectionItems(mixed, "most-used", true);
    expect(ids(mixed)).toEqual(before);
  });
});
