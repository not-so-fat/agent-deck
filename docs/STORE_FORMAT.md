# Agent Deck store format (v1)

**Status:** Published contract for the hybrid file-backed store  
**Version:** 1 (`format: "agent-deck-store"`)

Files under the Agent Deck data home are the **source of truth** for collection cards and deck layouts. SQLite (`agent_deck.db`) is a rebuildable query cache and must not be committed to git.

Zod schemas live in `packages/shared/src/schemas/store.ts` (`StoreManifestSchema`, `StorePlaybookFileSchema`, `StoreServiceSchema`, `StoreDeckSchema`, `StoreCredentialMetaSchema`).

---

## On-disk layout

Root: `resolveAgentDeckHome()` — production `~/.agent-deck/`, development `~/.agent-deck/dev/`. Override with `AGENT_DECK_HOME` if needed.

| Path | Role |
|------|------|
| `manifest.json` | Store header: `{ "format": "agent-deck-store", "version": 1, ... }` |
| `playbooks/<id>.md` | YAML frontmatter + markdown body |
| `services/<id>.json` | Sanitized MCP / local-MCP config (no tokens, no `localEnv`, no `Authorization`) |
| `credentials/<id>.yaml` | Metadata only (label, scheme, env name, etc.) — secret values stay in Keychain |
| `decks/<id>.json` | Deck name + ordered `serviceIds` / `credentialIds` / `playbookIds` |
| `agent_deck.db` | SQLite cache — **must not** be committed |
| (Keychain) | Secrets / OAuth tokens — never in the tree |

---

## manifest.json

Minimum:

```json
{
  "format": "agent-deck-store",
  "version": 1,
  "migratedFrom": "sqlite"
}
```

- `format` must be `"agent-deck-store"`.
- `version` must be `1` for this schema generation.
- `migratedFrom` is optional; set to `"sqlite"` after the first dump from an existing SQLite-only install.

Unknown `version` values should fail closed during reindex.

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

## Deck file (`decks/<id>.json`)

JSON object validated by `StoreDeckSchema`:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "name": "dev",
  "serviceIds": [],
  "credentialIds": [],
  "playbookIds": ["pb_example"],
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

Decks reference card ids only; they do not embed full card payloads.

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

---

## Related mechanisms

| Mechanism | Use |
|-----------|-----|
| File store + git | Ongoing multi-laptop sync / backup of the full collection mirror |
| `.agent-deck.json` export/import | One-shot share of a collection or single deck; no git required |

See [file-backed store design spec](./superpowers/specs/2026-07-27-file-backed-store-git-sync-design.md) for architecture, migration, and reindex behavior.
