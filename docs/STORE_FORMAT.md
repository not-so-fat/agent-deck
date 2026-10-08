# Agent Deck store format (v2)

**Status:** Published contract for the hybrid file-backed store  
**Version:** 2 (`format: "agent-deck-store"`)

Files under the Agent Deck data home are the **source of truth** for collection cards and deck layouts. SQLite (`agent_deck.db`) is a rebuildable query cache and must not be committed to git.

Zod schemas live in `packages/shared/src/schemas/store.ts` (`StoreManifestSchema`, `StorePlaybookFileSchema`, `StoreServiceSchema`, `StoreDeckSchema`, `StoreCredentialMetaSchema`). The deck API contract (`DeckSchema`, `CreateDeckSchema`, `UpdateDeckSchema`) lives in `packages/shared/src/schemas/deck.ts`.

---

## On-disk layout

Root: `resolveAgentDeckHome()` — production `~/.agent-deck/`, development `~/.agent-deck/dev/`. Override with `AGENT_DECK_HOME` if needed.

| Path | Role |
|------|------|
| `manifest.json` | Store header: `{ "format": "agent-deck-store", "version": 2, ... }` |
| `playbooks/<id>.md` | YAML frontmatter + markdown body |
| `services/<id>.json` | Sanitized MCP / local-MCP config (no tokens, no `localEnv`, no `Authorization`) |
| `credentials/<id>.yaml` | Metadata only (label, scheme, env name, etc.) — secret values stay in Keychain |
| `decks/<id>.md` | YAML frontmatter (deck metadata + ordered card ids) + operating instructions body |
| `agent_deck.db` | SQLite cache — **must not** be committed |
| (Keychain) | Secrets / OAuth tokens — never in the tree |

---

## manifest.json

Minimum:

```json
{
  "format": "agent-deck-store",
  "version": 2,
  "migratedFrom": "sqlite"
}
```

- `format` must be `"agent-deck-store"`.
- `version` must be `2` for this schema generation.
- `migratedFrom` is optional; set to `"sqlite"` after the first dump from an existing SQLite-only install.

`version: 1` manifests are still recognized so startup and `reindex` can run the automatic v1→v2 migration (below). Any other `version` value fails closed during reindex.

---

## Playbook file (`playbooks/<id>.md`)

Frontmatter fields match `StorePlaybookFileSchema`. Persist `createdAt` and `updatedAt` as ISO datetimes in frontmatter so git sync and reindex do not depend on filesystem mtime.

Example:

```markdown
---
id: pb_example
title: Example
triggers:
  - example trigger
dependsOnServiceIds: []
dependsOnCredentialIds: []
# exec and skill are optional strings — omit when unset
createdAt: "2026-01-01T00:00:00.000Z"
updatedAt: "2026-01-01T00:00:00.000Z"
---

Playbook body markdown…
```

---

## Service file (`services/<id>.json`)

JSON object validated by `StoreServiceSchema` (same sanitized field set as export bundles: id, name, type, url, optional OAuth/local-MCP fields). No tokens or secret headers.

---

## Credential metadata (`credentials/<id>.yaml`)

YAML metadata validated by `StoreCredentialMetaSchema` (camelCase in Zod; on-disk yaml-sync uses snake_case keys such as `header_name`, `env_name`, `docs_url`). Secret values remain in Keychain only.

---

## Deck file (`decks/<id>.md`)

A v2 deck file is YAML frontmatter plus a Markdown body. The frontmatter carries the deck metadata validated by `StoreDeckSchema` (`id`, `name`, ordered `serviceIds` / `credentialIds` / `playbookIds`, `createdAt`, `updatedAt`); the body contains **only** the deck operating instructions (`operatingInstructions`, at most 16,000 characters — see `OPERATING_INSTRUCTIONS_MAX_LENGTH` in `packages/shared/src/schemas/deck.ts`). An empty body is valid and is what every migrated v1 deck starts with.

Decks reference card ids only; they do not embed full card payloads. Operating instructions are **not** secrets — review the Markdown before committing the store.

Example (exactly as the codec in `packages/backend/src/store/deck-codec.ts` writes it):

```markdown
---
id: 11111111-1111-4111-8111-111111111111
name: dev
serviceIds: []
credentialIds: []
playbookIds:
  - pb_example
createdAt: '2026-01-01T00:00:00.000Z'
updatedAt: '2026-01-01T00:00:00.000Z'
---
Prefer small PRs.
```

Editing instructions through the deck API (`POST` / `PUT /api/decks`) rewrites this file; deleting the SQLite cache and running `agent-deck reindex` reconstructs the same instructions and deck membership from it.

---

## Automatic v1 migration

Stores created before v2 keep `decks/<id>.json` files and `manifest.json` with `"version": 1`. Both backend startup and manual `agent-deck reindex` detect that combination and convert it before doing anything else — no separate command, no git involvement.

For each `decks/<id>.json` (in sorted filename order): parse the v1 record, write `decks/<id>.md` with identical metadata and an empty instructions body, then delete the `.json`. The manifest bump to `"version": 2` lands last. The migration is:

- **deterministic** — sorted order, byte-identical metadata (ids, names, card order, and both timestamps preserved exactly);
- **idempotent** — a v2 manifest is a no-op, so rerunning changes nothing;
- **crash-recoverable** — every file write is atomic, so a crash between the `.md` write and the `.json` delete resumes cleanly: the rerun trusts a Markdown twin only when its metadata exactly matches the JSON, and deletes the leftover JSON.

Anything ambiguous aborts before the manifest is touched: an unparseable `.json`, two files claiming one deck id, or a Markdown twin with different metadata. The error names the concrete paths.

---

## Git sync (user-owned)

**Agent Deck never runs git.** Users manage version control themselves.

1. Commit the store subdirectories and `manifest.json`. Do not commit the whole home directory if it also holds logs or cache artifacts.
2. Add a `.gitignore` in your store repo (or home) to exclude the SQLite cache and other local-only files:

```gitignore
*.db
*.db-*
**/icons/
```

3. **Workflow:**
   - Edit cards in Agent Deck on laptop A → files update automatically (dual-write).
   - Commit and push from laptop A.
   - Pull on laptop B.
   - Run `agent-deck reindex` (or restart the backend if auto-reindex runs on start).
   - Re-enter Keychain secrets and reconnect OAuth on the new machine as needed.

After a git pull, the merged file tree wins. Resolve merge conflicts in `.md` / `.json` / `.yaml` in git, then reindex.

### Merging deck Markdown conflicts

A deck file can conflict in two independent places — treat them separately:

- **Frontmatter conflicts** (membership, name, timestamps) decide which cards the deck holds. Keep one side's id lists or union them by hand; either is valid as long as every referenced card file exists after the merge.
- **Body conflicts** (operating instructions) are plain prose — merge the two instruction texts like any document.

After resolving, run `agent-deck reindex`: it fails closed naming the file if the frontmatter is still malformed, if the body exceeds 16,000 characters, or if the merged membership references a card with no file.

### What stops a reindex, and what only warns

| Store state | Reindex |
|-------------|---------|
| Two files carrying the same **id** (e.g. a leftover `pb_x.conflict.md`, or two `decks/*.md` with one deck id) | **Fails closed** — nothing is imported; delete the stray file, then reindex |
| Malformed deck frontmatter, an over-limit (>16,000 chars) deck body, or a deck referencing a missing card | **Fails closed** — nothing is imported; the error names the offending file path |
| Two files sharing a **display name** (two decks named `Work`) | **Imports everything** and warns, naming both files; SQLite holds a UNIQUE index per display name, so the later file is indexed as `<name> (imported)` until you rename one |

Rename one of the colliding cards when you see that warning. The suffix is applied to
the SQLite row, and dual-write serializes from that row — so the next edit to the
suffixed card writes `<name> (imported)` back into its store file. Which file keeps the
original name is deterministic (store files are read in filename order), so two laptops
sharing the store agree.

The last reindex outcome is recorded in the SQLite store meta. `agent-deck status` and
`agent-deck doctor` report `Last reindex FAILED <when>: <error>` so a store that has
silently stopped reaching SQLite is visible without reading `backend.log`.

---

## Workspace assignment files are not the store

Each project workspace may hold `.agent-deck/use.json`, but that file stores **only assignment identity** — which deck the folder uses:

```json
{
  "version": 3,
  "deckId": "11111111-1111-4111-8111-111111111111",
  "deckName": "dev"
}
```

(`mcpUrl` may also be present when the workspace pins a project MCP endpoint.)

Operating instructions are never copied into `use.json`: the file stays small, merge-free, and safe to rewrite on every deck switch, while the instructions live once in the Git-synced store's `decks/<id>.md` and follow the deck across machines.

---

## Related mechanisms

| Mechanism | Use |
|-----------|-----|
| File store + git | Ongoing multi-laptop sync / backup of the full collection mirror |
| `.agent-deck.json` export/import | One-shot share of a collection or single deck; no git required |

See [file-backed store design spec](./superpowers/specs/2026-07-27-file-backed-store-git-sync-design.md) for architecture, migration, and reindex behavior.
