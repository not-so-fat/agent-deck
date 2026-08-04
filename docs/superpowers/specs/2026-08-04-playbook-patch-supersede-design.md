# Playbook patch supersede — design

**Date:** 2026-08-04 · **Status:** Implemented · **Repo:** agent_deck  
**Prior art:** [playbook learning loop](./2026-07-11-playbook-learning-loop-design.md), [feedback accumulation PRD](../../PRD_FEEDBACK_ACCUMULATION.md)  
**Agreed approach:** Agent judges whether an open proposal is the same lesson; propose names those patch ids explicitly to replace them.

---

## 1. One job + audience

**One job:** Keep the human review queue to **one live proposal per problem**, when an agent revises a playbook patch after further correction — cancel the weaker open proposal and replace it with a better one that still carries the evidence trail.

**Audience:** (1) IDE agent filing proposals, (2) deck owner reviewing `/playbook-patches`.

**Not this job:** Batch-curating many *independent* open feedback signals (already covered by `signal_only` + Feedback table → `signal_ids`). Supersede is for **proposal lineage**, not signal accumulation.

---

## 2. Problem (before solution)

Today every `propose_playbook_patch` that creates a row adds an independent `proposed` patch. When the same lesson is refined in-session (“that update doesn’t make sense — change it”), both v1 and v2 sit in the queue. Humans review duplicate / conflicting work for one playbook problem.

Feedback accumulation fixed **weak independent** corrections (`signal_only` → curate later). It did **not** fix **evolving proposals** that already entered the review queue.

---

## 3. Reasoning rules (invariants)

1. **Human still accepts once.** Supersede never auto-applies a playbook change.
2. **Same vocabulary where it still means the right thing.** Reuse `playbook_patches`, `propose_playbook_patch`, evidence, `signal_ids`. Do not overload human-reject semantics for machine replace.
3. **Agent decides “same issue”; backend enforces linkage.** No backend LLM similarity. No auto-supersede of every open patch on a playbook.
4. **Explicit ids only.** Supersede targets named `pp_*` ids the agent has seen — never silent cancel-all.
5. **Evidence and signals move forward**, not reopen to “available” while a replacement proposal exists.
6. **Independent open patches stay.** Two different problems on the same playbook may both remain `proposed`.
7. **No new browse MCP for the Feedback table.** Open *patches* visibility piggybacks on `get_playbook`, not a second feedback list tool.
8. **Supersede ≠ reject.** Human reject and auto-replace are different lifecycle events (see §5.3). Feedback PRD unlink-on-reject stays true for human reject only.

---

## 4. User stories

### US-1 — Revise a bad proposal without stacking

**As** a solo dev correcting an agent again on the same playbook lesson  
**I want** the new proposal to replace the open one that got it wrong  
**so that** I review one better suggestion, not v1 and v2.

**Acceptance:** Agent proposes with `supersedes: ["pp_…"]`; those patches leave the default review queue as `superseded`; the new patch is the only live proposal for that lineage; linked signals stay parked on the new patch.

### US-2 — See what I’m about to replace

**As** an IDE agent about to file an update  
**I want** the open proposals for that playbook returned with `get_playbook`  
**so that** I can pass the right `supersedes` ids (or leave unrelated ones alone).

**Acceptance:** `get_playbook` includes compact `openPatches` for that playbook when any `proposed` rows exist. Harness requires checking them before an update propose when revising a lesson.

### US-3 — Trace why an old row disappeared

**As** a deck owner looking at patch history  
**I want** superseded rows to show they were replaced by a newer patch id  
**so that** I don’t think I rejected them and don’t re-review them as open work.

**Acceptance:** Superseded patches are not in the default `proposed` list; detail/history shows status `superseded` and successor patch id.

---

## 5. Design

### 5.1 MCP / propose contract

Extend `propose_playbook_patch` with optional:

```json
"supersedes": ["pp_abc", "pp_def"]
```

Rules:

| Rule | Behavior |
|------|----------|
| Only `proposed` targets | Non-proposed id → 400 |
| Same playbook | Each target’s `playbook_id` must equal this propose’s `playbook_id` |
| Empty / omitted | Today’s behavior (stack allowed) |
| Order | Validate `supersedes` targets first; insert the new patch; then mark each target `superseded` and re-link its signals (sequential steps, not one SQLite transaction) |

On success, response includes:

```json
{
  "kind": "update",
  "patch": { "...": "new patch" },
  "superseded": ["pp_abc"],
  "signal": { "...": "..." }
}
```

Harness (agent-deck rule text) addition — Update case:

1. Before proposing, call `get_playbook` and read `openPatches`.
2. If an open patch addresses the **same** lesson/problem, include its id(s) in `supersedes` and fold ops/rationale into one better proposal (do not file a sibling).
3. If open patches are **different** problems, leave them; omit from `supersedes`.
4. Prefer consolidating ops over leaving contradictory `add_item`s on the same section theme.

### 5.2 How the agent sees open patches

**Piggyback on `get_playbook`** (required surface for US-2):

```json
"openPatches": [
  {
    "id": "pp_…",
    "kind": "update",
    "rationale": "…",
    "failureSummary": "…",
    "userFeedbackExcerpt": "…",
    "createdAt": "…"
  }
]
```

Only `status = proposed`. Compact — enough to judge sameness, not a full preview.

**Why not a new list MCP tool:** Feedback PRD already forbids feedback browse via MCP. Open patches are proposal-queue state the agent must see to exercise judgment; attaching them to the playbook card the agent already fetches keeps surface small.

**Propose without prior get:** Still allowed (first-shot proposes). Omitting `supersedes` when other open patches exist is allowed — harness + `openPatches` on `get_playbook` are the primary path; no second response field name.

### 5.3 Backend lifecycle

**New status: `superseded`.**  
Justification (new term): Feedback PRD US-1 / F-lifecycle: on patch **reject** or **stale**, clear `linked_patch_id` and leave signals `open`. Learning-loop: `rejection_reason` is **human** reject signal. Auto-replace must not reuse `rejected` — that would either (a) wrongly unlink signals the successor still owns, or (b) special-case “reject but keep links,” forking reject semantics. `superseded` is machine replace: leave the queue, keep lineage, transfer links.

Status enum becomes: `proposed` \| `accepted` \| `rejected` \| `stale` \| `superseded`.

For each id in `supersedes`:

1. Verify `proposed` + same `playbook_id`.
2. Set status to **`superseded`**; set `supersededBy` (DB column `superseded_by`) to the new patch id.
3. Re-link that patch’s open signals to the **new** patch id (keep `open` + `linkedPatchId = new`). Do **not** clear link (reject path unchanged).
4. New patch is `proposed` as today; its `signal_ids` / new signal behave as today.

**Dashboard:** Default queue unchanged (`status=proposed`). History/detail: show `superseded` + link via `supersededBy`. Reverse “what did this replace?” = query rows where `superseded_by = this.id`. Human reject UI unchanged.

**Feedback PRD amendment (one line):** Unlink-on-reject/stale does **not** apply to `superseded`; signals transfer to the successor patch and become `actioned` when that patch is accepted.

### 5.4 Data model delta

| Column / field | Change |
|----------------|--------|
| `playbook_patches.status` | allow `superseded` |
| `playbook_patches.superseded_by` | NULL TEXT — successor `pp_*`; set only when status becomes `superseded` |
| Propose schema | optional `supersedes: string[]` (request only; not a stored JSON column) |
| `get_playbook` API/MCP | `openPatches` when any proposed for that id |
| Reject / stale handlers | unchanged (still unlink signals) |

### 5.5 Flow

```
correction → agent judges lesson clear
    → get_playbook (sees openPatches)
    → same issue as pp_old?
         yes → propose(..., supersedes=[pp_old], ops=better)
              → pp_old status=superseded, supersededBy=pp_new
              → signals re-linked to pp_new
              → queue shows only pp_new
         no  → propose(...) without supersedes
              → both remain proposed
```

---

## 6. Out of scope

| Item | Why |
|------|-----|
| Auto-supersede all open patches on a playbook | Violates independent-problems rule |
| Backend embedding / “same issue” classifier | No LLM in backend; agent judgment |
| Merging accepted/rejected history into one row | Audit stays append-only |
| Changing Feedback table curation UX | Already works via `signal_ids` |
| Genesis (`create`) supersede chains | `playbook_id` is null until accept; defer |
| New MCP list/discard tools | Surface discipline |
| Soft warn on propose when open patches exist and `supersedes` omitted | Harness + `get_playbook` sufficient for v1 |

---

## 7. Success criteria

| # | Criterion |
|---|-----------|
| SC-1 | Same-lesson second propose with `supersedes` leaves exactly one `proposed` patch in that lineage |
| SC-2 | Different-problem second propose without `supersedes` leaves both `proposed` |
| SC-3 | Signals linked to superseded patch re-link to successor; become `actioned` only when successor is accepted; human reject still unlinks |
| SC-4 | Default dashboard proposed list never shows `superseded` rows |
| SC-5 | Harness text tells agents to check `openPatches` on `get_playbook` and pass `supersedes` when revising the same lesson |

---

## 8. Locked defaults (were open questions)

1. **Producers:** same `supersedes` field for all sources (IDE harness is the primary guidance).
2. **History:** dedicated **Superseded** filter in the review queue (alongside Rejected/Accepted), with `supersededBy` link in detail.
