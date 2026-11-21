# Playbook Trigger Conflict Detection — Design

> **Historical (2026-07-12)** — This record captures an earlier design, proposal, or verification run. See [the current guide](../../ARCHITECTURE.md) for shipped behavior.


**Date:** 2026-07-12 · **Status:** Draft for review · **Scope:** shared validation + backend write paths + dashboard patch review UI

**Problem:** `triggers: z.array(z.string())` has no trim, dedupe, or cross-playbook conflict check. Live deck has `pb_product_principle` and `pb_ui_principle` with near-identical triggers (`master-detail layout`, `split-pane UI`, `human gate UI`, …). Host skill-matching and harness "check triggers on get_bound_deck" both become a coin flip — wrong playbook fires, corrections land on the wrong card, loop quality degrades.

**Goal:** Prevent **exact duplicate triggers** on the same deck at write time; surface **near-duplicate / overlapping** triggers at review time without blocking edits.

**Related:** [learning loop](./2026-07-11-playbook-learning-loop-design.md), [stub sync on bind](./2026-07-12-playbook-stub-sync-on-bind-design.md), [PLAYBOOKS_AND_SKILLS.md](../../PLAYBOOKS_AND_SKILLS.md)

---

## 1. Definitions

| Term | Meaning |
|---|---|
| **Normalized trigger** | `trigger.trim().toLowerCase().replace(/\s+/g, ' ')` |
| **Exact conflict** | Same normalized trigger on two different playbooks linked to the same deck |
| **Overlap (soft)** | Triggers share a token subset or Levenshtein ratio ≥ threshold (review warning only) |
| **Deck scope** | Conflicts are per **deck**, not global collection — same trigger on different decks is allowed |

---

## 2. Normalization (apply everywhere)

Add `normalizeTrigger(s: string): string` and `normalizeTriggers(arr: string[]): string[]` in `packages/shared/src/utils/playbook.ts`:

```typescript
export function normalizeTrigger(trigger: string): string {
  return trigger.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeTriggers(triggers: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of triggers) {
    const normalized = normalizeTrigger(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
```

**Storage:** Keep user-facing casing in DB; normalize only for comparison. Optionally persist deduped trimmed form on save (product choice: **yes** — store trimmed, preserve first-seen casing per normalized key).

Update Zod `PlaybookSchema.triggers` with `.transform()` that trims and dedupes empties.

---

## 3. Hard rule — exact duplicates rejected

### 3a. When to check

| Path | Action on exact conflict |
|---|---|
| `register_playbook` (MCP) | 409 + conflict payload |
| `update_playbook` (MCP) | 409 |
| `propose_playbook_patch` with `set_triggers` or `create` | 409 at propose time |
| Dashboard playbook save | 409 toast |
| Patch accept (apply `set_triggers`) | Re-validate; flip patch to `stale` if conflict appeared since propose |

### 3b. API shape

```typescript
type TriggerConflict = {
  trigger: string;           // normalized form
  playbookId: string;
  playbookTitle: string;
};

type TriggerConflictError = {
  code: 'trigger_conflict';
  message: string;
  conflicts: TriggerConflict[];
};
```

Example message: `Trigger "master-detail layout" already used by "UI principle" (pb_ui_principle)`.

### 3c. Implementation

```typescript
async function findExactTriggerConflicts(
  db: DatabaseManager,
  deckId: string,
  triggers: string[],
  excludePlaybookId?: string,
): Promise<TriggerConflict[]> { … }
```

Query: all playbooks on deck via existing `getDeckPlaybooksForDeck`, build `Map<normalized, playbookId>`, detect collisions.

**Performance:** Fine at local scale (<100 playbooks/deck). If needed later: index table `deck_playbook_triggers(deck_id, normalized_trigger, playbook_id)` maintained on write.

---

## 4. Soft rule — overlap warnings (non-blocking)

### 4a. When to surface

- Dashboard playbook edit form (live as user types — debounced)
- Patch review queue diff panel
- Optional: `get_bound_deck` attaches `trigger_warnings[]` (summaries only, no extra MCP tool)

### 4b. Heuristic (v1 — simple, explainable)

Flag pair `(a, b)` on same deck when **any** of:

1. One normalized trigger is a substring of another (min length 8 chars)
2. Jaccard similarity on word tokens ≥ 0.6
3. Same first 3 words after normalization

```typescript
type TriggerOverlapWarning = {
  triggerA: string;
  playbookA: { id: string; title: string };
  triggerB: string;
  playbookB: { id: string; title: string };
  reason: 'substring' | 'token_overlap' | 'prefix';
};
```

**Do not block saves** on soft warnings — product principle and UI principle may intentionally share vocabulary; human resolves in review.

### 4c. Patch review UI

In `playbook-patches` diff view, when patch ops touch triggers:

- Render **exact conflict** as red banner (cannot accept until resolved)
- Render **overlap warnings** as yellow callout listing competing playbooks
- For `kind=create`, check against full deck trigger map

---

## 5. MCP / agent guidance

Update `propose_playbook_patch` tool description:

> Before `set_triggers`, prefer distinctive triggers (include domain noun: "UI principle: split-pane layout" vs bare "split-pane layout"). Exact duplicate triggers on the same deck are rejected.

Harness rule addition (one line): when two playbooks share a task domain, differentiate triggers or merge playbooks.

---

## 6. Migration / existing data

**No auto-migration.** On first edit of a conflicting playbook, writer sees 409 and must fix.

Optional dashboard **"Trigger health"** panel (later): list all exact/soft conflicts on a deck for bulk cleanup. Script: `.temporal/scripts/audit-deck-trigger-conflicts.mjs` for one-off audits.

---

## 7. Implementation plan

| Step | Effort | Owner surface |
|---|---|---|
| 1. `normalizeTriggers` + Zod transform | S | shared |
| 2. `findExactTriggerConflicts` helper + tests | S | backend |
| 3. Wire into register/update/propose/accept | M | backend routes + patch-manager |
| 4. Overlap heuristic + unit tests | M | shared |
| 5. Dashboard conflict banners | M | `apps/agent-deck` patch review + playbook form |
| 6. Dedupe existing deck (manual) | — | user |

---

## 8. Success criteria

- Saving `pb_ui_principle` with trigger already on `pb_product_principle` returns 409 with both titles.
- `propose_playbook_patch { set_triggers }` fails at propose with same error (agent can revise before queue noise).
- Patch review shows overlap warning for substring cases without blocking unrelated patches.
- After normalization, `[" Foo ", "foo", ""]` stores `["Foo"]` (one entry).

---

## 9. Non-goals (v1)

- Semantic embedding similarity (too heavy, hard to explain)
- Cross-deck trigger uniqueness
- Auto-merge of conflicting playbooks
- Re-ranking host skill matcher when multiple stubs match (host-specific; out of scope)

---

## 10. Open questions

- [ ] Should `get_bound_deck` include `trigger_warnings` proactively, or only dashboard?
- [ ] On conflict, suggest alternate trigger strings (LLM-assisted) in 409 response?
- [ ] Include playbook **title** in stub description (shipped) — does that reduce need for overlapping bare triggers?
