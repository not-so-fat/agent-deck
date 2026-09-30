import { describe, expect, it } from "vitest";

import {
  buildDefaultOrderedCollection,
  sortCollectionItems,
  type CollectionFilterInput,
  type CollectionFilterOptions,
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

describe("buildDefaultOrderedCollection + sort composition (NOT-302)", () => {
  const counts: Record<string, number> = {
    "playbook:pb-deploy": 8,
    "credential:cred-deploy": 3,
    "service:svc-deploy": 12,
    "service:svc-other": 1,
  };

  const input: CollectionFilterInput = {
    playbooks: [
      { id: "pb-deploy", title: "Deploy checklist", body: "steps to deploy" },
      { id: "pb-notes", title: "Meeting notes", body: "unrelated" },
    ],
    credentials: [{ id: "cred-deploy", label: "Deploy token" }],
    services: [
      { id: "svc-deploy", name: "Deploy bot", description: "runs deploys", type: "mcp" },
      { id: "svc-other", name: "Other svc", description: "unrelated", type: "local-mcp" },
    ],
  };

  const baseOptions = (): CollectionFilterOptions => ({
    searchQuery: "",
    typeFilter: "",
    warningsOnly: false,
    warnings: {
      serviceWarnings: new Set<string>(),
      credentialWarnings: new Set<string>(),
      playbookWarnings: new Set<string>(),
    },
    getUsageCount: (kind, id) => counts[`${kind}:${id}`],
  });

  it("builds Default order (playbooks, credentials, services) with usage attached", () => {
    const rows = buildDefaultOrderedCollection(input, baseOptions());
    expect(ids(rows)).toEqual([
      "pb-deploy",
      "pb-notes",
      "cred-deploy",
      "svc-deploy",
      "svc-other",
    ]);
    expect(rows.find((r) => r.id === "svc-deploy")).toMatchObject({
      kind: "service",
      usageCount: 12,
    });
    // No usage row for pb-notes: unknown, never coerced to zero.
    expect(rows.find((r) => r.id === "pb-notes")?.usageCount).toBeUndefined();
  });

  it("search filter applies before sorting: excluded cards stay excluded", () => {
    const rows = buildDefaultOrderedCollection(input, {
      ...baseOptions(),
      searchQuery: "deploy",
    });
    expect(ids(rows)).toEqual(["pb-deploy", "cred-deploy", "svc-deploy"]);
    // Survivors order across kinds in both usage directions.
    expect(ids(sortCollectionItems(rows, "most-used", true))).toEqual([
      "svc-deploy",
      "pb-deploy",
      "cred-deploy",
    ]);
    expect(ids(sortCollectionItems(rows, "least-used", true))).toEqual([
      "cred-deploy",
      "pb-deploy",
      "svc-deploy",
    ]);
  });

  it("type filter applies before sorting", () => {
    const rows = buildDefaultOrderedCollection(input, {
      ...baseOptions(),
      typeFilter: "mcp",
    });
    expect(ids(rows)).toEqual(["svc-deploy"]);
    expect(ids(sortCollectionItems(rows, "most-used", true))).toEqual(["svc-deploy"]);

    const keys = buildDefaultOrderedCollection(input, {
      ...baseOptions(),
      typeFilter: "api-key",
    });
    expect(ids(keys)).toEqual(["cred-deploy"]);
  });

  it("warnings-only filter applies before sorting, unknowns trail", () => {
    const options = baseOptions();
    options.warningsOnly = true;
    options.warnings.serviceWarnings = new Set(["svc-other"]);
    options.warnings.playbookWarnings = new Set(["pb-notes"]);
    const rows = buildDefaultOrderedCollection(input, options);
    // Default relative order kept; pb-notes has unknown usage.
    expect(ids(rows)).toEqual(["pb-notes", "svc-other"]);
    expect(ids(sortCollectionItems(rows, "most-used", true))).toEqual([
      "svc-other",
      "pb-notes",
    ]);
    expect(ids(sortCollectionItems(rows, "least-used", true))).toEqual([
      "svc-other",
      "pb-notes",
    ]);
  });
});
