# Stub Lifecycle & Sync — Design

**Status:** Proposed
**Sources:** [2026-07-11-architecture-revisit-triggering-learning-loop.md](./2026-07-11-architecture-revisit-triggering-learning-loop.md) (A′ decision, build-order item 3), [2026-07-11-playbook-learning-loop-design.md](./2026-07-11-playbook-learning-loop-design.md), [PLAYBOOKS_AND_SKILLS.md](../../PLAYBOOKS_AND_SKILLS.md)
**Supersedes:** the manual-only sync behavior of `agent-deck use` (`packages/cli/src/use.ts`, `playbook-stubs.ts`)

> **Switching contract:** stub regeneration on `switch_bound_deck` and any host-reload step as part of the switch path in this spec are **superseded by** [Session/default deck-switching redesign](./2026-09-20-session-deck-switching-redesign.md) (NOT-204), which excludes stub regeneration and IDE reload from the switch path.

> **One line:** Stubs regenerate automatically at `bind_workspace` and on patch-accept, so the host's skill discovery always reflects the deck — no human has to remember `agent-deck use --refresh`.

## Why now (evidence, 2026-07-12)

Verified live in the agent_deck workspace itself:

- Deck "dev" has **6** playbooks; on-disk stubs cover **3**, and **2 of those 3** point at playbooks no longer on the deck (`get_playbook` fails). Only 1 of 6 playbooks can trigger implicitly.
- `.agent-deck/use.json` holds a deckId that no longer exists, so **both** recovery paths fail: the CLAUDE.md session opener (`bind_workspace` with the manifest deckId) and `agent-deck use --refresh` (resolves by `manifest.deckId` only, `use.ts:120-126`).

A′'s core claim — "accepted patches need no file sync" — holds only for **body** edits. Trigger/title edits and playbook add/remove on a deck *do* change the stub surface, and today nothing propagates them. This is the "lessons lost twice" failure mode the architecture revisit was written to fix.

## User stories

| ID | Story | Acceptance | Frequency / pain today |
|----|-------|------------|------------------------|
| US-1 | As an IDE user, I want playbooks added/edited in the dashboard to trigger in my next session, so that I never debug "why didn't the playbook fire". | New session after a deck change → stubs on disk match deck playbooks exactly (ids, triggers). | Daily; currently fails silently (5/6 playbooks unreachable). |
| US-2 | As a reviewing user, I want an accepted patch that changes triggers to update stubs in bound workspaces, so the lesson fires next time without CLI steps. | Accepting a patch with `set_triggers` (or create/retire) rewrites stubs in every workspace bound to a deck holding that playbook. | Weekly; currently requires remembering `use --refresh` per workspace. |
| US-3 | As a user whose backend DB was recreated, I want the session opener to still bind, so a stale `use.json` never bricks the workspace. | `use --refresh` and bind fall back to deck **name** when the id is gone, and the manifest is rewritten with the fresh id. | Rare but total outage when it hits (this repo, today). |
| US-4 | As a playbook author, I want any trigger text to produce a loadable stub, so a `: ` in a trigger can't silently kill discovery. | Frontmatter is escaped/quoted; a stub round-trips through a YAML parser for any trigger string. | Latent; one bad trigger disables a whole playbook. |

## Design

### D1. Ownership moves to backend

`syncPlaybookStubs` + manifest helpers move from `packages/cli/src/playbook-stubs.ts` to `packages/backend/src/playbooks/stub-sync.ts`. CLI already depends on backend (`backend-runtime.ts`), so `agent-deck use` re-imports; dependency direction is unchanged. `@agent-deck/shared` stays fs-free (it is bundled into the dashboard).

### D2. Sync on `bind_workspace` (convergence path)

`bind_workspace` / `switch_bound_deck` handlers (`packages/backend/src/mcp-tools/register.ts:54,85`), after resolving the deck:

1. Run stub sync against the session's `workspaceRoot` with the deck's playbook summaries.
2. Rewrite `.agent-deck/use.json` with the fresh deckId/name (heals US-3 for subsequent sessions).
3. Record `(workspaceRoot, deckId, lastBoundAt)` in a new `deck_workspaces` table (needed by D3; the live-display registry is in-memory and dies with the process).
4. Add to the bind payload: `stubs: { created, updated, removed, host_reload_required }` — the agent surfaces one line only when a count is nonzero.

Safety invariants (already in the current implementation, kept as hard rules): only files carrying the `agent-deck:stub` marker are ever modified or deleted; writes are confined to `<workspaceRoot>/.cursor/rules/agent-deck-stubs/` and `<workspaceRoot>/.claude/skills/agent-deck-*/`; sync is idempotent (content-compare before write), so concurrent binds are harmless.

Host-reload caveat: Claude Code scans skills at session start, so a stub created mid-session fires **next** session. That is acceptable — bind-time sync guarantees staleness lasts at most one session, versus unbounded today.

### D3. Sync on patch-accept (propagation path)

When the dashboard accepts a patch whose effect touches the stub surface — `set_triggers`, title change, `create`, `retire`, or deck link/unlink of a playbook — the backend syncs stubs to every `deck_workspaces` row for affected decks. Rows whose `workspaceRoot` no longer exists are pruned. Body-only patches skip this entirely (A′ invariant preserved).

### D4. Refresh fallback by name

`runUse` refresh path: resolve `manifest.deckId`; on miss, resolve `manifest.deckName`; on success rewrite the manifest. Only when both miss does it error with "run `agent-deck use <deck>`".

### D5. Frontmatter hardening

In `buildStubDescription` / stub builders:

- Sanitize triggers: trim, collapse internal newlines to spaces, drop empties, dedupe (case-insensitive).
- Emit `description` as a single-quoted YAML scalar with `'` doubled.
- Cap description at 1024 chars: keep whole triggers in deck order until the budget is hit, then append `…`.
- Prepend the playbook **title** to the description (`'<Title> — use when the user asks about …'`) — titles carry signal hosts can match that trigger lists alone miss.

## Requirements

| Req | Requirement | Acceptance |
|-----|-------------|------------|
| R1 | Stub module lives in backend; CLI consumes it. | `packages/cli` has no stub-generation logic of its own; existing `use.test.ts`/`playbook-stubs.test.ts` pass relocated. |
| R2 | Bind and switch sync stubs and report counts. | Integration test: bind against a deck with N playbooks in an empty temp workspace → N cursor + N claude stubs; payload counts match; second bind reports all zeros. |
| R3 | Only marker-owned files are touched. | Test: a hand-written `.mdc`/SKILL.md without the marker survives a sync that removes everything else. |
| R4 | Patch-accept with trigger change syncs recorded workspaces. | Test: bind two temp workspaces to a deck, accept a `set_triggers` patch → both stub sets updated; a body-only patch → zero writes. |
| R5 | Refresh falls back to deck name and heals the manifest. | Test: manifest with dead id + valid name → refresh succeeds, manifest rewritten. |
| R6 | Stub frontmatter is valid YAML for any trigger input. | Property-style test: triggers containing `: `, `#`, `'`, `[`, newlines → generated frontmatter parses; description ≤ 1024 chars. |

## Things worth NOT doing

- **No file-watcher or daemon push into workspaces.** Bind-time + accept-time cover the two moments state changes matter; a watcher adds a process and failure modes for zero extra freshness the host could even load.
- **No body mirroring into stubs** — locked A′ decision; stubs stay pointers, so body patches remain file-sync-free.
- **No sync inside read tools** (`get_bound_deck`, `get_playbook`). Reads must never write to the user's repo.
- **No cross-machine workspace registry.** `deck_workspaces` is local-backend state; exported bundles don't carry it.

## Deferred (with path back)

- **Mid-session skill reload** — depends on host capabilities we don't control; revisit if Claude Code/Cursor expose a skill-rescan API. Until then `host_reload_required` in the bind payload is the honest signal.
- **`bind_workspace` accepting a deck name** — nice ergonomics, but D2's manifest healing plus D4 removes the acute need; revisit alongside the per-deck-endpoint ADR where addressing changes anyway.

## Open decisions

| Question | Default if undecided |
|----------|---------------------|
| Opt-out for bind-time sync? | Yes: `AGENT_DECK_STUB_SYNC=off` env; on by default. |
| Prune `deck_workspaces` rows by age? | Prune only on missing-path at use time; no TTL. |
| Sync stubs for Cursor when only Claude is the bound client (and vice versa)? | Sync both, matching current `agent-deck use` default; per-client filtering stays a `use` flag. |

## Milestones

1. **M1 — relocate + harden (R1, R6, D5):** pure refactor + escaping; no behavior change for `agent-deck use`.
2. **M2 — bind-time sync (R2, R3, D2, D4, R5):** the convergence guarantee; fixes today's live drift class.
3. **M3 — accept-time propagation (R4, D3):** `deck_workspaces` table + patch-accept hook.
