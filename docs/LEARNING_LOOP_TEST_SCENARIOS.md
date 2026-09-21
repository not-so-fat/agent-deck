# Learning loop — manual test scenarios (dev)

**Audience:** Dogfooding agent_deck on the monorepo dev stack  
**Prereqs:** `npm run dev:all` · seed playbooks · `use` with dev MCP port  
**Related:** [learning-loop design](./superpowers/specs/2026-07-11-playbook-learning-loop-design.md) · [architecture revisit](./superpowers/specs/2026-07-11-architecture-revisit-triggering-learning-loop.md)

## One-time dev setup

```bash
npm run dev:all
# Optional: seed a visual diff demo proposal
bash .temporal/scripts/seed-pr-handoff-proposal.sh
AGENT_DECK_DEV=1 npm run agent-deck:dev -- use dev --mcp-port 3001 --client both
```

Restart Cursor / Claude Code so MCP reloads **`:3001`**. Dashboard: http://localhost:3000 · Review queue: http://localhost:3000/playbook-patches

| Check | Expected |
|-------|----------|
| `.cursor/mcp.json` | `"url": "http://127.0.0.1:3001/mcp"` |
| `.agent-deck/use.json` | `deckId` for dev deck in `~/.agent-deck/dev` |
| `.cursor/rules/agent-deck-stubs/` | `pb_*.mdc` stubs with `Use when the user asks about…` in `description:` |
| Session bind | Agent uses `use.json` deckId or you say *"use dev deck"* |

---

## Scenario A — Undertriggering telemetry (read path)

**Goal:** `playbook_events` records fetches; dashboard shows count.

1. New chat, bind dev deck.
2. Ask: *"Follow the dev smoke checklist"* (should match stub / `pb_dev_smoke_checklist`).
3. Confirm agent calls `get_playbook("pb_dev_smoke_checklist")` (not improvised steps only).
4. Dashboard → open that playbook → **fetch count** increased.

**Pass:** fetch count ≥ 1 after step 2.  
**Fail signals:** agent improvises without `get_playbook`; count stays 0.

---

## Scenario B — Update case (correction → proposal)

**Goal:** User correction on playbook-shaped output creates an **update** proposal with evidence.

1. Ask: *"Summarize this PR"* (matches `pb_pr_summary`).
2. Agent produces a summary (ideally after `get_playbook`).
3. Correct it: *"Always include a Test plan section — you missed it."*
4. Agent should **`propose_playbook_patch`** (not `update_playbook`) with e.g. `add_item` + `evidence.user_feedback_excerpt` quoting your correction.
5. Dashboard → **Playbook patches** → open proposal → preview diff shows new checklist/gotcha line.
6. **Accept** → playbook body updates; proposal status `accepted`.

**Pass:** queue shows one `update` proposal; after accept, `get_playbook` body includes the lesson.  
**Fail signals:** `update_playbook` without you asking; no evidence; full `rewrite_body` for a one-line fix.

---

## Scenario C — Genesis case (no playbook → create proposal)

**Goal:** Correction on a task **no playbook covers** files a tiny **create** proposal.

1. Ask something **not** in dev deck triggers, e.g. *"Draft a standup update for the team"* (no matching stub).
2. Agent answers; you correct: *"Keep it under 5 bullets and lead with blockers."*
3. Before ending, agent should `propose_playbook_patch { kind: "create", new_playbook: { title, triggers, body with one gotcha } }`.
4. Dashboard → accept create → new `pb_*` on collection; add to dev deck if not auto-linked.
5. Run `AGENT_DECK_DEV=1 npm run agent-deck:dev -- use dev --mcp-port 3001 --refresh` if triggers were set.

**Pass:** new playbook in queue; after accept, stub appears on next `use --refresh`.  
**Fail signals:** agent skips proposal; writes a 2-page playbook in the proposal.

---

## Scenario D — Explicit edit (user-directed)

**Goal:** When **you** direct a playbook edit, agent uses `update_playbook` (immediate), not the queue.

1. Say: *"Update the PR summary playbook to say we prefer conventional commit titles in the summary."*
2. Agent calls **`update_playbook`** (you already reviewed intent in chat).
3. No new row in playbook-patches queue (or only if agent mis-fires propose).

**Pass:** playbook body changes immediately; no pending proposal for the same change.

---

## Scenario E — Accept → stub refresh hint

**Goal:** Trigger changes surface a refresh hint.

1. From Scenario B or C, accept a patch that changes **`triggers`** (or create with new triggers).
2. Accept API response includes message about **`agent-deck use --refresh`**.
3. Run refresh; stub `description:` matches new triggers.

**Pass:** stub file updated; old trigger text gone from `.mdc` frontmatter.

---

## Scenario F — Reject path

**Goal:** Rejected proposals do not mutate playbooks.

1. File any proposal (B or C).
2. Dashboard → **Reject** with reason *"too specific to this repo"*.
3. `get_playbook` body unchanged; patch status `rejected`.

---

## Scenario G — Agent-first deck switch (no `use`)

**Goal:** Your normal workflow still works without repo files.

1. Temporarily rename `.agent-deck/use.json` aside.
2. New chat: *"Use the dev deck"* → `bind_workspace` (bootstrap) — or `switch_deck` + human approval when already bound.
3. Playbooks available via `get_bound_deck`; stubs optional.

**Pass:** deck binds; playbooks listed; no dependency on `use.json`.

---

## Scenario H — Propose-time 409 (bad ops rejected)

**Goal:** Invalid or no-op patches fail at **propose**, not as silent empty diffs.

1. With dev stack running, attempt (via agent or curl) `propose_playbook_patch` with `amend_item` on a **prose** line (not a `-` list item).
2. Expect **409** with message about list-item anchors or `rewrite_body`.
3. Attempt `set_triggers` with the **same** triggers as the live playbook.
4. Expect **409** `no change` — proposal is not stored.

**Pass:** no new row in queue for failed proposes; error text is actionable.  
**Fail signals:** 201 created with identical before/after in preview.

```bash
# Prose amend (should 409)
curl -s -X POST http://127.0.0.1:8000/api/playbook-patches \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "update",
    "playbook_id": "pb_pr_summary",
    "ops": [{
      "op": "amend_item",
      "section": "Output",
      "anchor": "- 3 bullets: what changed, why, test plan",
      "text": "- 4 bullets including risks"
    }],
    "rationale": "409 smoke"
  }' | python3 -m json.tool
```

---

## Scenario I — Visual diff review (dashboard)

**Goal:** Review queue shows GitHub-style unified diff and explicit empty/error states.

1. Run `bash .temporal/scripts/seed-pr-handoff-proposal.sh` (or accept an existing `rewrite_body` proposal).
2. Open http://localhost:3000/playbook-patches — select the proposal.
3. Confirm **Detail** panel:
   - Narrow proposals list, wide detail column
   - **Your correction** evidence above the diff
   - Unified diff with red `-` / green `+` rows (not side-by-side full bodies)
   - **Your decision** cluster below the diff (Accept, then Reject + reason)
4. For a legacy no-op proposal (if any): amber **No change detected** banner; Accept disabled.
5. For a stale/broken preview: red **Preview failed** banner with 409 message.

**Pass:** changed lines are obvious at a glance; empty/error states are explicit.  
**Fail signals:** two identical full-text columns; Accept enabled with no diff rows.

---

## Quick API smoke (no IDE)

```bash
# Propose update (agent client — propose does not require dashboard header)
curl -s -X POST http://127.0.0.1:8000/api/playbook-patches \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "update",
    "playbook_id": "pb_pr_summary",
    "ops": [{ "op": "add_item", "section": "Gotchas", "text": "Include Test plan section" }],
    "rationale": "API smoke test",
    "evidence": {
      "failure_summary": "PR summary omitted Test plan section",
      "user_feedback_excerpt": "you missed Test plan"
    }
  }' | python3 -m json.tool

# List queue → accept by id → fetch count
curl -s http://127.0.0.1:8000/api/playbook-patches?status=proposed \
  -H 'x-agent-deck-client: dashboard' | python3 -m json.tool
```

---

## What we are not testing here

- **agent-dealer** reflect → `POST /api/playbook-patches` (deferred PR)
- **merge / retire** patch kinds (schema only today)
- Production ports `:1110` / `~/.agent-deck` (use `AGENT_DECK_DEV=1` for isolated dev DB)
