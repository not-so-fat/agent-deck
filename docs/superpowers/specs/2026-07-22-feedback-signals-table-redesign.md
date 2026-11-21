# Feedback signals — data-table redesign

> **Historical (2026-07-22)** — This record captures an earlier design, proposal, or verification run. See [the current guide](../../ARCHITECTURE.md) for shipped behavior.


**Date:** 2026-07-22 · **Status:** Approved for implementation · **Supersedes (UI/lifecycle slice of):** [PRD_FEEDBACK_ACCUMULATION.md](../../PRD_FEEDBACK_ACCUMULATION.md) v1 backlog-on-patches UX

**Problem:** The first ship parked an “unreviewed backlog” panel on the playbook-patches page. That treats feedback as a side queue for patches, not as durable correction data for playbook enhancement. Users need to filter by playbook, keep history (open / actioned / discarded), avoid duplicating work when a proposal is already open, and hand selected rows (with ids) to an external agent for propose.

**Decisions locked (brainstorming 2026-07-22):**

1. Own dashboard page `/feedback-signals` — standard filterable table; patch accept/reject stays on Playbook review.
2. Statuses rename: `open` | `actioned` | `discarded` (replace `unreviewed` → `open`).
3. “In an open proposal” is **derived**, not a status: `linked_patch_id` points at a `playbook_patches` row with `status = proposed`.
4. Goal = no duplicate curation work; rejected patches leave signals available again; accept marks solved.
5. Copy for agent **always includes each signal `id`** so propose can pass `signal_ids` and the product can track which feedbacks are parked / solved.

Related: [no-backend-llm-boundary.md](../../decisions/no-backend-llm-boundary.md) (unchanged — no list/discard MCP; no backend LLM). Owning product PRD: [PRD_FEEDBACK_ACCUMULATION.md](../../PRD_FEEDBACK_ACCUMULATION.md).

---

## 1. Product model

```
Session capture (MCP propose / signal_only / import)
        │
        ▼
 feedback_signals  (append-only data: open | actioned | discarded)
        │
        │  dashboard table: filter playbook + status
        │  Copy for agent → JSON with ids
        ▼
 IDE agent → propose_playbook_patch(+ signal_ids)
        │  links ids (still open) → In proposal
        ▼
 playbook_patches review (existing page)
        │ accept → signals actioned
        │ reject / stale → clear link, signals stay open
```

**One-liner:** Feedback is a playbook-scoped data table; proposals extract from it; apply (accept) closes the loop.

---

## 2. Status & link lifecycle

| Event | `status` | `linked_patch_id` |
|-------|----------|-------------------|
| `signal_only` / import | `open` | `null` |
| Immediate propose (no `signal_ids`) | `open` | new patch id |
| Curation propose (`signal_ids`) | stays `open` on those rows; **no new signal row** | set to new patch id (only for currently linkable rows — see below) |
| Discard (dashboard) | `discarded` | unchanged (`null` expected) |
| Linked patch **accepted** | `actioned` | kept (audit) |
| Linked patch **rejected** or **stale** | stays / returns `open` | `null` |

**Linkable for propose:** `status = open` AND not already linked to a `proposed` patch. Unknown / actioned / discarded / already-in-flight ids are ignored (do not fail the propose) — same OD-3 spirit as before.

**Derived UI flag `inProposal`:** true when `linked_patch_id` resolves to a patch with `status = proposed`.

Migration: `UPDATE feedback_signals SET status = 'open' WHERE status = 'unreviewed'`. Schema + Zod enum rename; count field `unreviewed` → `open`.

---

## 3. Dashboard page `/feedback-signals`

### Layout

- Nav entry + badge (count of **available** open signals: `status=open` and not `inProposal`).
- Filters: **Playbook** (All | concrete playbooks from collection), **Status** (default Open; also Actioned, Discarded, All).
- Toggle: **Include already in an open proposal** (default off).
- Table columns: select · excerpt · failure summary · playbook · source · created · (badge “In proposal” when derived).
- Actions: **Copy for agent** · **Discard selected** (discard only when status is open).
- Remove the bolted-on backlog panel from `playbook-patches.tsx` (patches page stays patch-only; optional small link “Feedback data →”).

### Copy for agent (required shape)

Clipboard = **Markdown instructions + YAML list** (easier for host agents than a JSON dump). Every row leads with `id` (`playbook`, `feedback`, `failure`; optional `hint` / `deck`).

Prompt must instruct: pass every consumed id in `signal_ids` on `propose_playbook_patch`. Without ids, tracking breaks.

Default copy set when nothing selected: current filter result (respecting in-proposal exclusion unless toggled on).

---

## 4. API / MCP deltas (vs shipped v1)

| Surface | Change |
|---------|--------|
| Status enum | `unreviewed` → `open` |
| Count response | `{ "open": N }` (available-for-work count may be computed client-side or via query `available=1`) |
| List | Existing filters + optional `excludeInProposal=true` (or join in handler) |
| Propose + `signal_ids` | Link only; **do not** set `actioned` |
| Immediate propose | New signal `open` + link (not `actioned`) |
| Accept | Linked signals → `actioned` |
| Reject / stale | Clear link; status `open` |
| MCP | Still capture/propose only; tool descriptions say `open` + ids |
| Harness | Paste recipe points at `/feedback-signals`; Behavior 3 wording updated |

Dashboard-only list/discard/import unchanged in spirit.

---

## 5. Out of scope (this redesign)

- Backend LLM / list MCP tools (still forbidden)
- New status value for “in proposal”
- Editing signal body fields after insert
- Auto-curation cron

---

## 6. Implementation sketch (for planning)

1. Shared schema rename + migration in `database.ts`
2. `PatchManager` lifecycle: link-on-propose, actioned-on-accept
3. Routes/tests for count field + linkable rules
4. New page + nav; strip panel from patches page
5. `buildCurationPromptForAgent` — assert ids always present; harness copy
6. Seed/dev script update for UI review

---

## 7. Success checks

- [x] Filter by playbook shows only that playbook’s signals
- [x] Default open filter hides actioned/discarded; history visible via status filter
- [x] Copy payload always contains `id` per row
- [x] Propose with those ids parks rows (In proposal) without marking actioned
- [x] Accept → actioned; reject → open again and copyable
- [x] Badge reflects available open work (excludes in-proposal)

**Status:** Implemented 2026-07-22 (awaiting user UI review / commit).
