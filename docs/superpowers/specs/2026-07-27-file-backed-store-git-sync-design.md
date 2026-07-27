# File-backed store (hybrid) — design for user-owned git sync

**Status:** Draft for review  
**Date:** 2026-07-27  
**Decision:** Hybrid storage — **files are canonical**, SQLite is a **rebuildable query cache**. Agent Deck does not run git; users sync the file tree themselves.

---

## 1. Problem

Users want to move or continuously sync decks/cards (especially playbooks) across laptops. Today:

- Canonical data lives in SQLite (`~/.agent-deck/agent_deck.db`).
- `agent-deck export` / `import` already ships a portable `.agent-deck.json` bundle (no secrets).
- Raw SQLite is a poor git citizen (binary, bad merges, adjacent to secrets).

Need: an **open, documented on-disk store** that users can put under git, without Agent Deck implementing cloud sync or built-in git commands.

---

## 2. Goals / non-goals

### Goals

- Files under the Agent Deck data home are the **source of truth** for collection cards and deck layouts.
- SQLite remains for fast joins, uniqueness, and multi-row transactions (patch accept, etc.), but is **disposable** and gitignored.
- One-shot **migration** from existing SQLite-only installs to the file tree.
- **Automatic** rebuild when files are newer than the DB, plus **manual** `agent-deck reindex`.
- Documented user-owned git workflow (init, ignore DB, pull → reindex, secrets stay local).
- Published format (`docs/STORE_FORMAT.md` + Zod in `packages/shared`) so tools/users can validate without reading SQLite.

### Non-goals

- Built-in `git push` / `pull` / remote management.
- Syncing secrets, OAuth tokens, or Keychain material.
- CRDT / automatic merge of concurrent playbook edits (users resolve in git).
- Replacing the existing `.agent-deck.json` export/import (it stays for one-shot share).
- Putting learning-loop history (`playbook_patches`, `playbook_versions`, `feedback_signals`) or `playbook_events` in the git tree in v1.

---

## 3. Architecture

```text
┌─────────────────────────────────────────┐
│  Canonical file tree (git-friendly)     │
│  playbooks/  services/  credentials/    │
│  decks/  manifest.json                  │
└─────────────────┬───────────────────────┘
                  │ dual-write on mutate
                  │ rebuild on start / reindex
                  ▼
┌─────────────────────────────────────────┐
│  SQLite cache (gitignored)              │
│  joins, UNIQUE, transactions            │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│  Local-only                             │
│  Keychain secrets · OAuth tokens        │
│  events / patches / versions (v1)       │
└─────────────────────────────────────────┘
```

**Write path:** App mutations update SQLite in a transaction **and** flush matching file(s) atomically (write temp → rename).

**Rebuild path:** Parse `manifest.json` + tree → replace/rebuild SQLite from files. Keychain secrets remain keyed by credential id (metadata in tree, values local).

---

## 4. On-disk layout

Root: `resolveAgentDeckHome()` (prod `~/.agent-deck/`, dev `~/.agent-deck/dev/`). User may later point at a custom root via existing `AGENT_DECK_HOME` (no new env required for v1).

| Path | Role |
|------|------|
| `manifest.json` | `{ "format": "agent-deck-store", "version": 1, ... }` |
| `playbooks/<id>.md` | YAML frontmatter + markdown body |
| `services/<id>.json` | Sanitized MCP / local-MCP config (no tokens, no `localEnv`, no `Authorization`) |
| `credentials/<id>.yaml` | Metadata only (label, type, etc.) — align with today’s yaml mirror |
| `decks/<id>.json` | Name + ordered `serviceIds` / `credentialIds` / `playbookIds` |
| `agent_deck.db` | SQLite cache — **must not** be committed |
| (Keychain) | Secrets / OAuth — never in the tree |

### Playbook file shape (illustrative)

```markdown
---
id: pb_example
title: Example
triggers:
  - example trigger
dependsOnServiceIds: []
dependsOnCredentialIds: []
exec: null
skill: null
---

Playbook body markdown…
```

Frontmatter field set should match the playbook Zod schema (ids, title, triggers, deps, optional exec/skill). Persist `createdAt` / `updatedAt` in frontmatter (ISO) so git and reindex do not depend on filesystem mtime.

### Service / deck JSON

Reuse the sanitized field set already defined for export bundles (`BundleServiceSchema`, deck membership arrays), plus stable `id`. Decks always reference card ids (not nested full cards).

### Manifest

Minimum:

```json
{
  "format": "agent-deck-store",
  "version": 1,
  "migratedFrom": "sqlite"
}
```

`migratedFrom` optional; used after first dump. Schema version bumps require an explicit migrator.

---

## 5. Rebuild behavior

### Automatic

On backend start:

1. If store tree is missing/incomplete and SQLite has data → run **migrate** (dump) first.
2. Else if tree exists and is **newer than** the DB (compare manifest hash and/or newest file mtime vs DB mtime / stored content hash) → **reindex** (rebuild SQLite from files).
3. Else leave DB as-is (hot path unchanged).

Freshness: store a content hash of the tree (or `manifest.json` + sorted file hashes) in SQLite; reindex when on-disk hash ≠ stored hash. Do not rely on mtime alone (clock skew / `git pull` edge cases).

### Manual

| Command | Behavior |
|---------|----------|
| `agent-deck reindex` | Force rebuild DB ← files; print summary (created/updated/removed counts, warnings) |
| `agent-deck store migrate` | Ensure SQLite → files dump (idempotent); optional `--dry-run` |

Dashboard “Reload from files” is optional follow-up; CLI is required for v1.

### Conflict / validation on rebuild

- Unknown `manifest.version` → fail closed with clear error.
- Duplicate display names (title/name/label) across files → **abort reindex**, leave previous DB intact, print conflicting paths (no partial apply).
- Missing dependency ids → warn; playbook still loads with `missingServiceIds` / `missingCredentialIds` as today.
- Files deleted → corresponding DB rows removed on successful full rebuild (files win).

**Concurrent edit policy:** last successful reindex from the merged tree wins. No CRDT. Users resolve git merge conflicts on `.md` / `.json`, then reindex.

---

## 6. Migration (existing installs)

1. **Detect:** no complete store tree (missing `manifest.json` or empty card dirs) **and** SQLite has decks/cards.
2. **Dump:** write all playbooks, sanitized services, credential metadata, decks; write `manifest.json` with `migratedFrom: "sqlite"`.
3. **Preserve ids** so Keychain entries and workspace binds keep working.
4. **Idempotent:** if tree already complete, no-op (or verify and repair missing files only).
5. **Safety:** keep SQLite; migration is additive. Dual-write begins after dump. Optional CLI `--dry-run` lists planned paths.
6. Dev and prod homes migrate independently.
7. Existing `.agent-deck.json` export/import remains; file tree is the long-term sync surface.

Rollback: remove/ignore the tree and continue on SQLite only is **not** a supported long-term mode after dual-write ships — document “restore from git checkout + reindex” as the recovery path once migrated.

---

## 7. Secrets and credentials

- Credential **metadata** in `credentials/*.yaml` (and deck `credentialIds`).
- Secret **values** only in Keychain (unchanged).
- After git pull on a new machine: reindex creates credential rows; user re-enters secrets (or copies Keychain via OS tools — out of scope).
- OAuth: service public config in `services/*.json`; tokens local; import/rebuild report may list services needing reconnect (same honesty as today’s export import report).

---

## 8. User-owned git sync (docs only)

Document in README / SETUP / `STORE_FORMAT.md`:

1. Prefer committing the store subdirs + `manifest.json`, not the whole home if it also holds logs/cache.
2. Example `.gitignore`: `*.db`, `*.db-*`, icon cache, any token files if present.
3. Workflow: edit in Agent Deck → commit/push on laptop A → pull on laptop B → `agent-deck reindex` (or restart if auto-reindex runs) → reconnect OAuth / add secrets as needed.
4. Agent Deck never invokes git.

Suggested ignore snippet (illustrative):

```gitignore
*.db
*.db-*
**/icons/
```

---

## 9. Relationship to export/import

| Mechanism | Use |
|-----------|-----|
| File store + git | Ongoing multi-laptop / backup of full collection mirror |
| `.agent-deck.json` export/import | One-shot share of collection or one deck; no git required |

Export may later be implemented as “pack store subset → bundle,” but v1 can keep the current exporter reading SQLite (or reading files — either, as long as output matches existing bundle schema).

---

## 10. Performance notes

At documented local scale (handful of decks, ≪100 playbooks/deck), file dual-write and full reindex are cheap vs MCP network latency. Hot paths continue to read SQLite after reindex. Do **not** re-read the full tree on every `get_bound_deck` / `call_service_tool`.

Learning-loop append tables stay SQLite-only in v1 so frequent `playbook_events` do not thrash the git tree.

---

## 11. Implementation sketch (for planning)

1. Zod schemas + `docs/STORE_FORMAT.md` for store v1.
2. Store writer (atomic flush per entity) + reader/reindexer.
3. Wire playbook/service/credential/deck mutations through dual-write.
4. Startup: migrate-if-needed → maybe-reindex.
5. CLI: `reindex`, `store migrate [--dry-run]`.
6. Tests: round-trip dump → wipe DB → reindex; dual-write after update; reject bad manifest version.
7. Docs: git sync explanation; link from README / SETUP / PRD_EXPORT_IMPORT as complementary.

---

## 12. Success criteria

| # | Criterion |
|---|-----------|
| SC-1 | After migrate, all playbooks/services/credential metadata/decks exist as files with stable ids |
| SC-2 | Mutating a playbook in the app updates the corresponding `.md` without export |
| SC-3 | Deleting `agent_deck.db` and running `reindex` restores equivalent layouts (secrets still Keychain) |
| SC-4 | `git` is never invoked by Agent Deck; docs describe user sync |
| SC-5 | Auto-reindex on start when files changed; `agent-deck reindex` always available |
| SC-6 | Bundle export/import still works for one-shot share |

---

## 13. Open points deferred (not blocking this design)

- Dashboard “Reload from files” button.
- Putting patches/versions into the tree.
- Selective subset sync (sparse checkout / path filters) — full collection mirror is enough.
- Custom store root UI beyond `AGENT_DECK_HOME`.
