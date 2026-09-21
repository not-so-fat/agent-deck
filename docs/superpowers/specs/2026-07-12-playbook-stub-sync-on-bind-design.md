# Playbook Stub Sync on Bind — Design

> **Switching contract:** stub regeneration on `switch_bound_deck` and the IDE reload note in this spec are **superseded by** [Session/default deck-switching redesign](./2026-09-20-session-deck-switching-redesign.md) (NOT-204), which excludes stub regeneration and IDE reload from the switch path.

**Date:** 2026-07-12 · **Status:** Draft for review · **Scope:** agent_deck core (shared stub module + MCP bind + patch accept)

**Problem:** Thin playbook stubs (A′ architecture) only sync when someone manually runs `agent-deck use`. Deck playbooks can change via dashboard, MCP `register_playbook`, or accepted patches — but on-disk stubs in `.cursor/rules/agent-deck-stubs/` and `.claude/skills/agent-deck-*` drift immediately. Live evidence in this repo: 6 deck playbooks, 3 on-disk stubs, 2 stubs point at retired playbooks (`pb_dev_smoke_checklist`, `pb_pr_summary` → 404 on `get_playbook`). Only 1 of 6 playbooks is reachable via host skill-matching; 2 stubs actively mislead the agent.

**Goal:** Stubs stay a **pointer-only projection** of the bound deck's playbook trigger surface, refreshed automatically at the moments the deck↔workspace relationship is established or the deck's playbook set changes.

**Related:** [architecture revisit A′](./2026-07-11-architecture-revisit-triggering-learning-loop.md), [PLAYBOOKS_AND_SKILLS.md](../../PLAYBOOKS_AND_SKILLS.md), [learning loop](./2026-07-11-playbook-learning-loop-design.md)

---

## 1. Principles (locked)

| Principle | Rationale |
|---|---|
| **Bodies never sync** | Playbook markdown stays on the deck; stubs are triggers + `get_playbook` pointer only |
| **Idempotent sync** | Same inputs → same files; safe to run on every bind |
| **Host restart note** | Cursor/Claude discover skills at startup — sync result must say when restart is needed |
| **CLI `use` stays** | `agent-deck use` remains the one-shot setup path (MCP config + manifest + stubs); bind sync is incremental repair |
| **No body in stubs** | Regenerating stubs on patch accept is trigger/metadata only — accepted body edits do not require stub rewrite unless triggers/title change |

---

## 2. Module placement

Move stub generation out of `packages/cli` into a shared package both CLI and backend can import.

```
packages/shared/src/playbook-stubs/
  index.ts          # re-export public API
  build.ts          # buildStubDescription, yamlQuoteScalar, buildCursor/ClaudeStubFile
  sync.ts           # syncPlaybookStubs(workspaceRoot, playbooks, options)
  manifest.ts       # read/write .agent-deck/use.json (optional — CLI keeps thin wrapper)
```

- `packages/cli/src/playbook-stubs.ts` becomes a re-export shim (or deleted after import path update).
- `packages/backend` imports from `@agent-deck/shared` — **no** `fs` in shared if that breaks browser bundle; if so, split `playbook-stubs-node` under `packages/backend/src/lib/` and duplicate only the 200-line sync (acceptable short-term; prefer shared + `node:` gate).

**Recommendation:** `packages/shared` already targets Node for backend/CLI; colocate sync there with `node:fs` imports (same as other shared utils).

---

## 3. Sync triggers

| Event | When | Workspace roots | Playbook source |
|---|---|---|---|
| **`bind_workspace`** | MCP session binds root + deck | `workspaceRoot` from bind args | `listSummariesForDeck(deckId)` |
| **`switch_bound_deck`** | Same session, different deck | existing session `workspaceRoot` | summaries for new deck |
| **Patch accept** | Dashboard accepts create/update with trigger/title change | all `workspaceRoot` values in `liveDisplayRegistry` bound to that `deckId` | post-apply summaries |
| **`agent-deck use`** | Manual (unchanged) | cwd | summaries for chosen deck |
| **`agent-deck use --refresh`** | Manual repair (unchanged; now heals stale manifest deckId via name fallback — shipped separately) | manifest root | summaries |

**Not in v1:** sync on every `get_bound_deck` (too chatty; bind + patch accept covers the failure modes).

### 3a. Patch accept hook

In `PatchManager.accept()` (or route handler after success):

```typescript
const workspaces = liveDisplayRegistry
  .list()
  .filter((e) => e.deckId === deckId)
  .map((e) => e.workspaceRoot);

for (const root of unique(workspaces)) {
  const summaries = await playbookManager.listSummariesForDeck(deckId);
  syncPlaybookStubs(root, summaries, { cursor: true, claude: true });
}
```

Log `{ workspaceRoot, created, updated, removed }` per root; failures are **non-fatal** (bind path is the safety net).

### 3b. `bind_workspace` response shape

Extend existing bind payload:

```jsonc
{
  "workspaceRoot": "/path/to/repo",
  "deck_id": "6e825b59-…",
  "deck_name": "dev",
  "display_summary": "◆ dev · 1 MCP · 0 keys · 6 playbooks",
  "stub_sync": {
    "cursor": { "created": 3, "updated": 1, "removed": 2, "dir": ".cursor/rules/agent-deck-stubs" },
    "claude": { "created": 3, "updated": 1, "removed": 2, "dirs": ["…"] }
  },
  "stub_sync_note": "Restart the IDE host so skill/rule discovery reloads stub changes."
}
```

If sync throws (permissions, read-only FS): bind **still succeeds**; attach `stub_sync_error: string` instead of counts.

---

## 4. Client targeting

`agent-deck use` writes stubs for `--client cursor|claude|both`. Bind-time sync should match what the workspace already uses:

1. If `.cursor/rules/agent-deck-stubs/` exists **or** `.cursor/mcp.json` references agent-deck → sync cursor stubs.
2. If `.claude/skills/` contains any `agent-deck-*` dir **or** `.mcp.json` (Claude) references agent-deck → sync claude stubs.
3. If neither signal → sync **both** (first-time bind into a fresh repo).

This avoids writing Claude skill dirs into Cursor-only workspaces.

---

## 5. Slug collision (known gap)

`slugFromPlaybook(title)` can collide when titles differ only by case/punctuation (`"PR Summary"` vs `"pr-summary"` → same dir). **v1:** document; last writer wins (current behavior).

**v2 (optional):** append short id suffix when collision detected: `agent-deck-pr-summary-pb_abc123`.

---

## 6. YAML-safe descriptions (shipped separately)

`buildStubDescription` now includes playbook title + quoted YAML when triggers contain `: ` or other fragile characters. Bind sync inherits this automatically once module is shared.

---

## 7. Security / scope

- Sync only writes under `workspaceRoot` paths owned by the binding user (MCP has no elevated FS access beyond the agent process).
- Stub files contain **no secrets** — triggers and public playbook ids only.
- Do not sync for dashboard-only API calls.

---

## 8. Implementation plan

| Step | Effort | Notes |
|---|---|---|
| 1. Extract `playbook-stubs` to `@agent-deck/shared` | S | Move tests with it |
| 2. Call `syncPlaybookStubs` from `bind_workspace` / `switch_bound_deck` handlers | S | `register.ts` + `mcp-server.ts` |
| 3. Patch-accept hook + registry workspace enumeration | M | Needs `liveDisplayRegistry` injected into patch accept path |
| 4. Client detection heuristic | S | |
| 5. Update `PLAYBOOKS_AND_SKILLS.md` + harness: "stubs auto-sync on bind" | S | De-emphasize manual `use` for drift repair |
| 6. Golden-path test: bind creates missing stub, removes orphan | M | Temp dir workspace |

**Out of scope:** watching deck changes via WebSocket; multi-machine sync; syncing into global `~/.cursor/skills`.

---

## 9. Success criteria

- After `bind_workspace` on a repo with stale stubs, all deck playbooks have matching stub files within one bind call.
- Orphan stubs (playbook removed from deck) are deleted on bind.
- Accepted patch that changes `triggers` updates stubs for all live-bound workspaces without manual `agent-deck use`.
- Bind response tells the agent whether restart is needed when `created + updated + removed > 0`.

---

## 10. Open questions

- [ ] Should `bind_workspace` accept `deckName` only (no id)? **Partially addressed:** `GET /api/decks/:ref` now resolves by name; `deckId` field accepts non-UUID ref.
- [ ] Cursor: do `.mdc` stubs hot-reload without restart? If yes, tune `stub_sync_note` per host.
- [ ] Rate-limit bind sync (e.g. skip if deck summaries hash unchanged since last sync for this session)?
