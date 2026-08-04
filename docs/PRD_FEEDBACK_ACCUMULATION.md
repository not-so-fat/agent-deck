---
playbooks: pb_ai_codegen_prd, pb_product_principle
supersedes: brainstorming 2026-07-22 backlog-on-patches UX
design: docs/superpowers/specs/2026-07-22-feedback-signals-table-redesign.md
---

# Playbook feedback accumulation & curation — AI Codegen PRD

**One-liner:** Every agent-detected correction is logged permanently via MCP into `feedback_signals`; the dashboard exposes a **playbook-filterable data table** (`open` / `actioned` / `discarded`) so humans review and copy rows (with ids) to an IDE agent that proposes patches — agent_deck never calls an LLM and does not add list/discard MCP tools.

**Status:** Draft (redesign 2026-07-22) · **Codegen load path:** `docs/PRD_FEEDBACK_ACCUMULATION.md` · **UI/lifecycle design:** `docs/superpowers/specs/2026-07-22-feedback-signals-table-redesign.md` · **Contracts:** `packages/shared/src/schemas/feedback-signal.ts`

---

## 1. Product overview

Today (`docs/superpowers/specs/2026-07-11-playbook-learning-loop-design.md`, shipped), every agent-detected correction can become a standalone `playbook_patches` proposal. A single correction is often too weak to generalize from — it may be noise, an edge case, or need siblings before the right lesson is clear.

This PRD adds a durable capture layer (`feedback_signals`) written through MCP `propose_playbook_patch` (incl. `signal_only`), plus a **dashboard data-review table** on `/feedback-signals`: filter by playbook and status, discard noise, copy selected rows **including ids** for an IDE agent to paste back as `propose_playbook_patch` with `signal_ids`. Capture = MCP; analysis = dashboard → agent chat. No Anthropic (or other LLM) SDK in the backend; no dedicated list/discard MCP tools.

**Redesign vs first ship:** Feedback is not a bolted-on “unreviewed backlog” on the patches page. It is durable correction **data** for playbook enhancement. Status rename: `unreviewed` → `open`. Propose **links** signals (parks them to avoid duplicate work); **accept** marks `actioned`. Reject/stale clears the link so signals remain a source for new proposals. Supersede (proposal lineage) re-links to the successor instead of clearing — see playbook-patch-supersede design.

**Success criteria:**

| # | Criterion | Target |
|---|-----------|--------|
| SC-1 | Every agent-detected correction produces a `feedback_signals` row, whether or not a patch is also drafted immediately | v1 ship |
| SC-2 | From `/feedback-signals`, a user can filter by playbook, copy ≥2 open signals (ids included) into an IDE agent prompt, and get ≥1 consolidated proposal that **links** those `signal_ids`; accept marks them `actioned` | redesign |
| SC-3 | Nav shows available-open count (open and not already in a proposed patch) | redesign |
| SC-4 | A standalone script can backfill historical signals from a Claude Code transcript directory on a machine with no agent_deck backend running locally | v1 ship |

---

## 2. Target users & roles

| Persona | Goal | v1 surface |
|---------|------|------------|
| **Solo dev running IDE sessions** | Corrections given mid-task aren't lost even when they're too weak to act on alone | Harness auto-logs signal on every correction |
| **Deck owner reviewing playbooks** | Review correction data by playbook, extract proposals without duplicating in-flight work | `/feedback-signals` table + Copy for agent + patches review |
| **New user migrating history** | Bootstrap playbooks from corrections given before this feature existed | Standalone backfill CLI script |

**Voice:** Objective, cold-reader. Link `docs/superpowers/specs/2026-07-11-playbook-learning-loop-design.md` for prior-art terminology (`playbook_patches`, ops, evidence).

---

## 3. User stories (testable)

### US-1 — Every correction is captured

**As a** solo dev **I want** every correction I give an agent to be logged **so that** a correction that seems minor in isolation isn't lost if it turns out to matter later.

**Acceptance:**

- [ ] `propose_playbook_patch` (any `kind`, including `signal_only`) inserts a `feedback_signals` row when the call is not a curation submit that already carries `signal_ids`
- [ ] Row is written even when the resulting patch proposal is rejected or goes stale later
- [ ] Row fields (`failure_summary`, `user_feedback_excerpt`, `corrected_output_hint?`) are immutable after insert; only `status` and `linked_patch_id` change
- [ ] Immediate kinds insert the signal as `status: "open"` with `linked_patch_id` set to the new patch; curation submits with `signal_ids` create **no** new row and only link referenced open (linkable) ids; `signal_only` inserts as `open` with `linked_patch_id: null`
- [ ] On patch **accept**, linked signal(s) become `actioned`; on **reject** or **stale**, clear `linked_patch_id` and leave/return status `open` (still a good source for a new proposal). On **supersede** (see playbook-patch-supersede design), re-link to the successor instead of clearing — reject/stale unlink rules do not apply.

*v1 / redesign*

### US-2 — Defer a correction instead of proposing immediately

**As a** solo dev **I want** to let the agent log a correction without drafting a patch when it isn't confident the fix generalizes yet **so that** the review queue isn't cluttered with premature single-correction proposals.

**Acceptance:**

- [ ] `propose_playbook_patch({ kind: "signal_only", evidence })` stores the signal with `status: "open"` and creates **no** `playbook_patches` row
- [ ] Harness guidance instructs the agent to use `signal_only` when a correction is plausible but not yet clearly generalizable
- [ ] Explicit user-directed edits ("fix the playbook to say X") remain unaffected — still `update_playbook`

*v1*

### US-3 — Data review and extract on the dashboard

**As a** deck owner **I want** a standard table of feedback data filtered by playbook and status **so that** I can copy id-bearing rows to my IDE agent for consolidated proposals without duplicating work already covered by an open patch.

**Acceptance:**

- [ ] Dashboard page `/feedback-signals` lists signals in a table with playbook filter, status filter (`open` default), and optional include-in-proposal toggle (default off)
- [ ] "Copy for agent" always includes each row’s `id` in the clipboard JSON plus excerpt/failure/playbook context
- [ ] Pasted IDE agent submits via `propose_playbook_patch` with `signal_ids` (no list/discard MCP tools)
- [ ] Propose **links** those ids (derived “In proposal”); does **not** mark `actioned` until patch accept
- [ ] Discard marks rows `discarded` without deleting them
- [ ] Resulting proposals appear in the existing playbook-patches review queue — no second accept/reject UI; **no** backend LLM

*redesign*

### US-4 — See available work before curating

**As a** deck owner **I want** to see how many open corrections are waiting (not already in a proposal) **so that** I know when to open the feedback table.

**Acceptance:**

- [ ] Nav badge shows count of available open signals (`status = open` and not linked to a `proposed` patch)
- [ ] Playbook detail view shows a per-playbook available-open count

*redesign*

### US-5 — Backfill historical corrections

**As a** new user **I want** to mine corrections from Claude Code transcripts that predate this feature **so that** old history isn't a dead end.

**Acceptance:**

- [ ] `agent-deck import-feedback-signals <transcript-dir>` parses JSONL and POSTs or writes JSON
- [ ] Script runs standalone without a local backend (optional `--backend-url`)
- [ ] Imported signals are `source: "backfill"` and appear in the feedback table like live captures

*v1*

---

## 4. Features & requirements

### Pillar A — Capture

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F1.1 | `propose_playbook_patch` writes a `feedback_signals` row on every call **except** curation submits that already carry `signal_ids` | US-1 |
| F1.2 | `kind: "signal_only"` skips ops drafting and `playbook_patches` creation | US-2 |
| F1.3 | `feedback_signals` rows are immutable except `status`/`linked_patch_id` | US-1 |
| F1.4 | Harness Behavior 3 documents `signal_only` vs immediate propose and paste-from-`/feedback-signals` | US-2 |

### Pillar B — Dashboard data table & extract

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F2.1 | `GET /api/feedback-signals` (dashboard) lists with status/playbook/deck filters; supports excluding in-proposal rows | US-3 |
| F2.2 | `propose_playbook_patch` accepts optional `signal_ids`; on success those linkable rows get `linked_patch_id` and stay `open`; no new signal row for the call | US-3 |
| F2.3 | Discard via `POST /api/feedback-signals/discard` → `discarded`, never delete | US-3 |
| F2.4 | Dashboard Copy for agent always embeds signal `id`s; harness paste recipe; **no** list/discard MCP | US-3 |
| F2.5 | Rejecting or staling a patch clears `linked_patch_id` on linked signals; status `open` | US-1 |
| F2.5a | Superseding a patch re-links its open signals to the successor (`open` / new patch id); does not clear | US-1 |
| F2.6 | Accepting a patch sets linked signals to `actioned` | US-1 |
| F2.7 | Own page `/feedback-signals`; remove bolted-on backlog from patches page | US-3 |

### Pillar C — Visibility

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F3.1 | Count API / badge = available open (not in-proposal) | US-4 |
| F3.2 | Playbook detail shows per-playbook available-open count | US-4 |

### Pillar D — Backfill

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F4.1 | Standalone CLI parses local Claude Code JSONL for correction turns | US-5 |
| F4.2 | CLI POSTs or writes importable JSON | US-5 |
| F4.3 | `POST /api/feedback-signals/import` accepts batch with `source: "backfill"` | US-5 |

---

## 5. Pricing model

*Skipped — agent_deck does not call an LLM for curation; the host agent uses its existing subscription/API. No new billable surface.*

---

## 6. Design principles

| Principle | Load-bearing requirement |
|-----------|--------------------------|
| Nothing is ever lost | Every correction is logged unconditionally (F1.1) |
| Append-only history | Rows never deleted; only status/link transitions (F1.3, F2.3) |
| Data first, extract second | Table is the review surface; patches are the extract/apply rail (F2.7) |
| No duplicate work | Linked-to-proposed signals are parked (derived), not re-copied by default (F2.1, F2.2) |
| Solved = applied | `actioned` only on patch accept (F2.6) |
| No LLM in agent_deck | External agent after dashboard copy (F2.4) |
| Capture on MCP, browse on dashboard | No list/discard MCP tools |

---

## 7. Cross-cutting contracts

Implementation: Zod in `packages/shared/src/schemas/feedback-signal.ts`.

### 7.1 `feedback_signals` row (`FeedbackSignal`)

```json
{
  "id": "fs_9f3a2c1b",
  "source": "ide",
  "sourceRef": "mcp-session-abc123",
  "failureSummary": "Agent proposed rewrite_body when an add_item would have sufficed",
  "userFeedbackExcerpt": "just add one line to Gotchas, don't rewrite the whole thing",
  "correctedOutputHint": null,
  "candidatePlaybookId": "pb_ai_codegen_prd",
  "candidateDeckId": "6e825b59-13de-4ddd-ab7e-55ab5a1c279a",
  "linkedPatchId": null,
  "status": "open",
  "createdAt": "2026-07-22T10:00:00.000Z"
}
```

`source`: `ide` \| `dealer` \| `backfill`. `status`: `open` \| `actioned` \| `discarded`.

**Derived (not stored):** `inProposal` when `linkedPatchId` references a patch with `status = proposed`.

**Status lifecycle:**

| Event | Resulting `status` / `linkedPatchId` |
|-------|--------------------------------------|
| `propose` `signal_only` | new row, `open` / `null` |
| `propose` immediate kind, no `signal_ids` | new row, `open` / new patch id |
| `propose` with `signal_ids` | **no new row**; linkable ids → `open` / new patch id |
| Dashboard discard | `discarded` |
| Linked patch **accepted** | `actioned` / keep patch id |
| Linked patch **rejected** or **stale** | `open` / `null` |
| Linked patch **superseded** | `open` / successor patch id (re-link; not clear) |

**Linkable:** `status = open` and not already linked to a `proposed` patch. Unknown / non-linkable ids ignored — still create the patch (OD-3).

Migration: `UPDATE feedback_signals SET status = 'open' WHERE status = 'unreviewed'`.

### 7.2 `propose_playbook_patch` — `signal_only` + optional `signal_ids`

```jsonc
{
  "kind": "signal_only",
  "evidence": {
    "failure_summary": "…",
    "user_feedback_excerpt": "…",
    "corrected_output_hint": "…"
  },
  "rationale": "…"
}
```

Curation / immediate propose with ids:

```jsonc
{
  "kind": "update",
  "playbook_id": "pb_…",
  "ops": [{ "op": "add_item", "section": "Gotchas", "text": "…" }],
  "rationale": "…",
  "evidence": { "failure_summary": "…", "user_feedback_excerpt": "…" },
  "signal_ids": ["fs_a", "fs_b"]
}
```

`signal_ids` optional on any patch-creating kind. Must be echoed from Copy-for-agent JSON so solved feedback is trackable.

### 7.3 `GET /api/feedback-signals` (dashboard only)

```json
// query
{ "status": "open", "playbookId": "pb_…", "deckId": "…", "excludeInProposal": true }

// response data: FeedbackSignal[]
```

No MCP list tool — agents receive signal JSON (with ids) via dashboard Copy for agent.

### 7.4 Count

```json
{ "open": 7 }
```

Badge uses available-open (exclude in-proposal). Optional `playbookId` scopes the count (F3.2).

### 7.5 Discard / import

Unchanged shapes; discard only transitions `open` → `discarded`. Import inserts `open` / `source: backfill`.

### 7.6 Copy payload (dashboard)

Markdown instructions + YAML list (not JSON). Every row **must** lead with `id`. Prompt instructs the agent to pass those ids as `signal_ids`.

Example body:

- Markdown steps telling the agent to call `propose_playbook_patch` with `signal_ids`
- Fenced `yaml` list of rows: `id`, `playbook`, `feedback`, `failure` (optional `hint`, `deck`)

---

## 8. Technical constraints & preferences

| Constraint | Detail |
|------------|--------|
| **Stack** | TypeScript monorepo; Fastify; Zod |
| **No LLM in backend** | Do **not** add model clients for this feature |
| **SQLite** | `feedback_signals` in `database.ts` + status migration |
| **Dashboard** | `/feedback-signals` table page; patches page = proposals only |
| **MCP surface** | Capture/propose only; **no** list/discard feedback MCP tools |
| **Backfill CLI** | `agent-deck import-feedback-signals` |

---

## 9. Non-functional requirements

| NFR | Target | Measurement |
|-----|--------|-------------|
| NFR-1 List latency (≤100 open signals) | p95 < 100 ms | Local, n ≥ 20 |
| NFR-2 Signal write latency | p95 < 200 ms added over propose without signals | Local, n ≥ 20 |
| NFR-3 Backfill throughput | ≥ 500 transcript turns/min parsed | Local, n ≥ 3 dirs |
| NFR-4 Data durability | 0 rows lost or mutated outside `status`/`linked_patch_id` | Unit tests |

---

## 10. Out of scope

| Item | Rationale |
|------|-----------|
| Backend LLM / Anthropic curation | Host agent after dashboard copy |
| List/discard MCP tools | Dashboard-gated browse |
| Explicit `proposed` status on signals | Derived from link + patch status |
| Scheduled automatic analysis | User/agent initiated only |
| Second accept/reject UI for raw signals | Reuse `playbook_patches` queue |
| agent-dealer integration | Product cut |

---

## 11. Milestones

| Phase | Exit criteria |
|-------|----------------|
| **v1a — Capture** | Table + propose writes + `signal_only` (shipped) |
| **v1b — First dashboard** | List/discard/copy on patches page (shipped; superseded UX) |
| **v1c — Table redesign** | Status `open`; link-on-propose / actioned-on-accept; `/feedback-signals` page; ids in copy; badge = available open; tests + PRD alignment |

---

## 12. Open decisions

| Question | Default if undecided | Owner |
|----------|----------------------|-------|
| OD-1 Re-open discarded signals? | Stay `discarded`; manual reopen later if needed | Eng |
| OD-2 How should agents group genesis signals (no playbook)? | By `candidateDeckId`, else one unscoped bucket | Eng |
| OD-3 Unknown / non-linkable `signal_ids` on propose? | Ignore; still create the patch | Eng |
| OD-4 Count endpoint shape for available-open? | ~~Resolved~~ — `GET /api/feedback-signals/count?available=1`, response field `{ open }` | Eng |

---

## 13. How to use this PRD

| Consumer | Directive |
|----------|-----------|
| **Engineer** | Implement against §7 + design doc; migrate `unreviewed` → `open`; change lifecycle before UI polish. |
| **AI codegen** | Read design doc + §7; do not reintroduce backlog panel on patches page or backend LLM. |
| **Reviewer** | Trace US-1..US-5; verify actioned only on accept; Copy always has ids. |
| **User** | Open **Feedback** in the dashboard → filter by playbook → Copy for agent (or discard). Accept patches to mark feedback solved. |

---

## Appendix — source notes

| Source | Captured as |
|--------|-------------|
| Agent Deck playbooks `pb_ai_codegen_prd`, `pb_product_principle`, `pb_ui_principle` | Structure, layout |
| `docs/superpowers/specs/2026-07-11-playbook-learning-loop-design.md` | Prior-art terminology |
| Brainstorming 2026-07-22 | Own page; `open`/`actioned`/`discarded`; derived in-proposal; ids on copy; actioned on accept |
| [decisions/no-backend-llm-boundary.md](./decisions/no-backend-llm-boundary.md) | No backend LLM; MCP = capture/propose |
| [2026-07-22-feedback-signals-table-redesign.md](./superpowers/specs/2026-07-22-feedback-signals-table-redesign.md) | Approved UI/lifecycle redesign |

---

## Codegen-readiness checklist

- [x] One-sentence value statement at top
- [x] Every user story has verifiable acceptance checkboxes
- [x] Every requirement has stable `Req ID`
- [x] Cross-boundary shapes committed (§7)
- [x] NFR table has measurement window + sample size
- [x] Out of scope in exactly one section (§10)
- [x] Open decisions have Default if undecided (§12)
- [x] Codegen load path + contracts directory named (§8)
- [x] Pricing section addressed with justification (§5)
- [x] No backend LLM dependency for curation
- [x] Redesign design doc linked and lifecycle matches accept→actioned
