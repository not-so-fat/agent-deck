# Trigger Hygiene & Conflict Detection — Design

**Status:** Proposed
**Sources:** [2026-07-11-architecture-revisit-triggering-learning-loop.md](./2026-07-11-architecture-revisit-triggering-learning-loop.md) (§2 implicit triggering, §5a trigger surfaces), [2026-07-11-playbook-learning-loop-design.md](./2026-07-11-playbook-learning-loop-design.md) (propose-first queue), [2026-07-12-stub-lifecycle-sync-design.md](./2026-07-12-stub-lifecycle-sync-design.md)

> **One line:** Triggers get normalized and checked for cross-playbook collisions at every write point, and conflicts surface in the patch-review queue — so the host stops coin-flipping between playbooks that claim the same phrase.

## Why now (evidence, 2026-07-12)

- Live deck "dev": `pb_product_principle` and `pb_ui_principle` both carry `master-detail layout`, `human gate UI`, and near-identical `split-pane UI` / `review … layout` variants. A host matching stub descriptions has no basis to pick the right one.
- `triggers` is `z.array(z.string())` everywhere (`packages/shared/src/schemas/playbook.ts:11,24`, `playbook-patch.ts:42-43,69`) — no trim, no length bounds, no dedupe, and nothing anywhere compares triggers **across** playbooks.
- The learning loop makes this worse over time by design: every genesis proposal and `set_triggers` op adds trigger mass with zero collision feedback. Conflict detection is the guardrail the propose-first queue is missing.

## User stories

| ID | Story | Acceptance | Frequency / pain today |
|----|-------|------------|------------------------|
| US-1 | As a reviewing user, I want a proposed patch that introduces a trigger collision flagged in the dashboard queue, so I can fix triggers before accepting. | Patch detail view shows a conflict block: colliding trigger → other playbook (id, title). Accept stays possible (warn, not block). | Every genesis proposal; currently invisible until the wrong playbook fires. |
| US-2 | As an agent calling `register_playbook`/`update_playbook`, I want collision warnings in the tool response, so I can adjust triggers in the same turn and tell the user. | Response carries `trigger_warnings: [...]`; write still succeeds. | Weekly. |
| US-3 | As a user linking an existing collection playbook onto a deck, I want to be warned when it collides with playbooks already on that deck, so deck composition doesn't silently degrade triggering. | `manage_deck_card` link response and dashboard link flow surface the same conflict shape. | Occasional; the pb_product_principle/pb_ui_principle pair likely arose this way. |
| US-4 | As a playbook author, I want triggers normalized on save, so `" PRD "` vs `"PRD"` never counts as two triggers. | Stored triggers are trimmed, whitespace-collapsed, deduped case-insensitively; order preserved. | Constant low-grade noise. |

## Design

### D1. Normalization at the schema boundary (silent)

A shared `normalizeTriggers(triggers: string[]): string[]` applied via `.transform` on `CreatePlaybookSchema`, `UpdatePlaybookSchema`, the `set_triggers` op, and genesis `new_playbook`:

- trim; collapse internal whitespace/newlines to single spaces; drop empties
- dedupe case-insensitively within the playbook (keep first, preserve order)
- bounds: 1–80 chars per trigger, max 16 triggers per playbook (aligned with the 1024-char stub description budget) — violations are Zod errors, not warnings

Normalization is the only **silent** behavior; everything cross-playbook is a surfaced warning.

### D2. Deck-scoped conflict detection (pure function, shared)

`detectTriggerConflicts(candidate: PlaybookSummary, deckPlaybooks: PlaybookSummary[]): TriggerConflict[]` in `packages/shared` (pure — usable by backend routes and dashboard preview without an extra endpoint):

| Level | Rule | Example |
|-------|------|---------|
| `exact` | normalized trigger equality | `master-detail layout` on both cards |
| `subsumes` | one trigger is a token-subsequence of the other | `PRD` vs `write a PRD` |
| `overlap` | Jaccard over word tokens ≥ 0.6 (both ≥ 2 tokens) | `split-pane UI layout` vs `split-pane UI` |

```ts
type TriggerConflict = {
  trigger: string;            // candidate's trigger (normalized)
  otherPlaybookId: string;
  otherPlaybookTitle: string;
  otherTrigger: string;
  level: 'exact' | 'subsumes' | 'overlap';
};
```

Deterministic and lexical only — the deck is small (≤ ~20 playbooks × ≤ 16 triggers), so O(n²) token comparison is trivially fast and, unlike embeddings, explainable in a review UI ("these two phrases share these words").

Scope is **per deck**: the same trigger on playbooks that never share a deck is not a conflict, because stubs — the implicit trigger surface — are generated per deck.

### D3. Enforcement points (warn, never block)

| Write point | Where | Behavior |
|-------------|-------|----------|
| `register_playbook` / `update_playbook` | playbook routes | compute against bound deck; include `trigger_warnings` in response |
| `propose_playbook_patch` (genesis or `set_triggers`) | patch-manager `propose` | persist conflicts on the patch row (`conflicts_json`); MCP response includes them so the agent can immediately amend |
| Patch **accept** | patch-manager apply | recompute (deck may have changed since propose); dashboard confirm shows current conflicts |
| Deck link | `manage_deck_card` + dashboard | US-3 warning |

Warn-not-block is deliberate: overlap is sometimes correct (two playbooks about adjacent domains), and propose-first already puts a human gate in front of every agent-initiated change — the design feeds that gate rather than adding a second one.

### D4. Dashboard review queue surfacing

Patch detail (`apps/agent-deck/src/pages/playbook-patches.tsx` area) renders persisted conflicts as a warning block above the diff: one row per conflict, `level` badge, both trigger strings, link to the other playbook. Resolution guidance in the empty actions row: *edit triggers to disambiguate, or propose a `merge` patch* (the `merge` kind already exists in `ProposePlaybookPatchSchema`).

## Requirements

| Req | Requirement | Acceptance |
|-----|-------------|------------|
| R1 | `normalizeTriggers` at write boundaries; create hard-caps at 16; update uses grandfather count policy. | Unit: padded/dup inputs → normalized; create >16 → error; update keep/shrink over-cap → ok; grow → error. |
| R2 | `detectTriggerConflicts` classifies exact / subsumes / overlap. | Unit table incl. the live pb_product_principle × pb_ui_principle pair → ≥ 3 conflicts detected with correct levels. |
| R3 | Propose persists conflicts; accept recomputes. | Integration: genesis with colliding trigger → patch row carries conflicts; deck edited before accept → accept-time list reflects new state. |
| R4 | MCP write responses carry `trigger_warnings`. | http test: `register_playbook` colliding with deck playbook → warnings present, playbook created. |
| R5 | Review UI renders conflicts. | Component test: patch with `conflicts_json` shows warning block with both playbook titles. |

## Things worth NOT doing

- **No semantic/embedding similarity.** Lexical rules are explainable, dependency-free, and catch the observed failure class; embeddings add a model dependency to a local-first tool for marginal recall.
- **No hard blocking of overlapping triggers.** Adjacent domains legitimately share vocabulary; the human gate decides.
- **No collection-wide (cross-deck) conflict scanning.** Triggering is a per-deck surface; global scanning produces noise about decks that never coexist.
- **No auto-rewriting of triggers on accept.** Silent mutation of reviewed content breaks the propose-first contract; only D1 normalization (mechanical, lossless) is silent.

## Deferred (with path back)

- **Wrong-fire telemetry** — usage logging of which playbook was fetched vs. which stub fired, feeding conflict *evidence* ("these two collide **and** users hit the wrong one"). Path back: the planned usage-logging workstream from the architecture revisit (§5b "measure via usage logging").
- **Dealer plan-draft trigger match** — the explicit-surface consumer of the same `detectTriggerConflicts` tokenization; picks up the shared function when the dealer workstream lands (architecture revisit §5a).

## Open decisions

| Question | Default if undecided |
|----------|---------------------|
| Jaccard threshold for `overlap` | 0.6; tune only with telemetry, not by feel |
| Max triggers per playbook | 16 on **create**; **update** may keep/shrink legacy over-cap lists (see [trigger-count-grandfather](./2026-07-29-trigger-count-grandfather-design.md)) |
| Do `exact` conflicts block patch **accept**? | No — warn with required confirmation click in dashboard |

## Milestones

1. **M1 — shared functions (R1, R2):** `normalizeTriggers` + `detectTriggerConflicts` with the live-deck fixture as the canonical test case.
2. **M2 — backend wiring (R3, R4):** schema transforms, patch-row persistence, MCP response warnings.
3. **M3 — dashboard (R5):** review-queue conflict block + link-flow warning.
