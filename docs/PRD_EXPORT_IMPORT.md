---
playbooks: pb_ai_codegen_prd, pb_product_principle
---

# Export / import — AI Codegen PRD

**One-liner:** Export a portable JSON snapshot of MCP + playbook cards and deck layouts (`export all` or one deck); import creates when names are new and skips unique display-name conflicts; users re-enter API keys and reconnect OAuth.

**Status:** Implemented (CLI + REST + dashboard) · **Codegen load path:** `docs/PRD_EXPORT_IMPORT.md` · **Contracts:** `packages/shared/src/schemas/export-bundle.ts`

---

## 1. Product overview

Agent Deck stores MCP services, playbooks, and deck layouts in a **file-backed store** under `~/.agent-deck/` (SQLite is a rebuildable cache). Credentials and OAuth tokens live in Keychain and are **never** part of this feature. Users need to **port layouts** when switching machines or sharing a deck template.

This PRD specifies a **local-only** single-file `.agent-deck.json` bundle, CLI + dashboard export/import, and link-or-create import for cards (no `preserve_ids`, no secrets).

**Complementary to file-store git sync:** users who track the on-disk store in their own git repo get continuous multi-laptop sync without export/import. Export/import remains the right tool for one-shot backup, deck templates, and hosts where git is not used — it does **not** replace the file store and is not superseded by it. See [STORE_FORMAT.md](./STORE_FORMAT.md).

**Success criteria:**

| # | Criterion | Target |
|---|-----------|--------|
| SC-1 | Round-trip restores equivalent layout (deck names, service/playbook membership order); IDs may differ | v1 ship |
| SC-4 | Import report lists MCP cards that need OAuth reconnect (and rename / dep warnings) | v1 ship |

**Dropped from earlier draft:** encrypted secrets (SC-2), credential migration (US-2), preserved IDs for repo manifests (US-3 / SC-3). Bind is session-only (`bind_workspace`); leftover `.agent-deck/deck.yaml` does not bind.

---

## 2. Target users & roles

| Persona | Goal | v1 surface |
|---------|------|------------|
| **Solo dev** | New laptop; restore decks + MCP/playbook layouts | CLI / dashboard `export all` + `import` |
| **Solo dev** | Pre-upgrade backup of layouts | CLI / dashboard export all |
| **Team lead** | Share one deck layout without secrets | CLI `export deck` / deck row Export |
| **Support / self** | Understand post-import gaps | Import report JSON |

**Voice:** Objective, cold-reader. Link [MVP.md](./MVP.md) for bound-deck terminology.

---

## 3. User stories (testable)

### US-1 — Full collection migration (metadata)

**As a** solo dev **I want** to export my collection and all decks **so that** I can import on a new machine without rebuilding layouts.

**Acceptance:**

- [x] `agent-deck export all -o backup.agent-deck.json` produces a JSON file the CLI accepts on another host
- [x] After `agent-deck import backup.agent-deck.json`, dashboard shows the same deck names and service/playbook membership order
- [x] Create when names are new; skip unique display-name conflicts (`idMap` always present)
- [x] Bundle contains zero credentials and zero secret bytes
- [x] Import report lists each MCP card needing OAuth reconnect

*v1*

### US-4 — Shareable deck template

**As a** team lead **I want** to export one deck **so that** teammates get the layout and reconnect their own auth.

**Acceptance:**

- [x] `agent-deck export deck <uuid> -o deck.agent-deck.json` includes only that deck and its linked services/playbooks
- [x] Bundle contains zero credentials and zero secret bytes
- [x] Second deck import skips same-named MCP/playbooks; new playbooks remap `dependsOnServiceIds`
- [x] Importer sees OAuth reconnect checklist — no false “authenticated” OAuth state

*v1*

---

## 4. Features & requirements

### Pillar A — Bundle format

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F1.1 | Bundle is a single JSON file | Validator rejects missing `format: agent-deck-bundle` or unknown `version` |
| F1.2 | Support scopes `collection` and `deck` | `deck` includes only the named deck + linked services/playbooks |
| F1.3 | Bundle ids are within-file refs only; decks always new; services/playbooks link-or-create | Report `idMap` + `created`/`reused` counts |
| F1.4 | Exclude credentials, `exec_runs`, session binding, harness files, icon cache | Not present in bundle |
| F1.5 | Services are create-safe config only | No OAuth tokens, client secrets, `localEnv`, `credentialId`, or `Authorization` headers |

### Pillar B — Import (link-or-create cards)

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F2.1 | Display names UNIQUE (deck `name`, service `name`, playbook `title`, credential `label`) | SQLite enforces; create APIs return clear errors |
| F2.2 | Import: try create; on UNIQUE reject, skip and map to existing row | Report `created` / `reused` (skipped); no rename suffixes |
| F2.3 | Skipped playbooks/services/decks are not overwritten | Existing body/deps unchanged |
| F2.4 | **New** playbooks only: remap `dependsOnServiceIds` via `idMap` | Skipped playbooks untouched |
| F2.5 | Post-import report matches `ImportReport` (§7.2) | CLI stdout + dashboard modal; warnings list skips |

### Pillar C — Surfaces

| Req ID | Requirement | Acceptance |
|--------|-------------|------------|
| F3.1 | CLI `export all`, `export deck <uuid>`, `import` | `packages/cli` |
| F3.2 | Backend library used by CLI | `packages/backend/src/export-import/` via `cli-runtime` |
| F3.3 | `POST /api/export`, `POST /api/import` (dashboard client only) | Agent clients get 403 |
| F3.4 | Dashboard: Export all + Import on My Collection; Export on deck row | Download / report modal |

---

## 5. Pricing model

*Skipped — Agent Deck does not host, proxy, or bill third-party APIs in this feature.*

---

## 6. Design principles

| Principle | Load-bearing requirement |
|-----------|-------------------------|
| Local-only | No upload to Agent Deck servers |
| No secrets | Credentials and secret material never enter the bundle (F1.4, F1.5) |
| Always create | New IDs on import; no upsert / preserve_ids (F1.3, F2.1) |
| Honest gaps | Import report lists OAuth reconnect and renames (F2.4, SC-4) |

---

## 7. Cross-cutting contracts

Implementation: Zod in `packages/shared/src/schemas/export-bundle.ts`.

### 7.1 Bundle (`BundleV1`)

```json
{
  "format": "agent-deck-bundle",
  "version": 1,
  "exportedAt": "2026-07-03T00:00:00.000Z",
  "exportedFrom": { "agentDeckVersion": "1.3.0" },
  "scope": "collection",
  "services": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Linear",
      "type": "mcp",
      "url": "https://mcp.linear.app/mcp",
      "description": "optional",
      "cardColor": "#92E4DD",
      "disabledToolNames": [],
      "oauthClientId": "optional-public",
      "oauthAuthorizationUrl": "https://example.com/oauth/authorize",
      "oauthTokenUrl": "https://example.com/oauth/token",
      "oauthRedirectUri": "https://example.com/callback",
      "oauthScope": "read",
      "localCommand": "optional",
      "localArgs": [],
      "localWorkingDir": "optional",
      "headers": { "X-Custom": "ok" }
    }
  ],
  "playbooks": [
    {
      "id": "pb_example",
      "title": "Example",
      "body": "…",
      "triggers": ["example"],
      "dependsOnServiceIds": ["11111111-1111-4111-8111-111111111111"],
      "exec": "optional",
      "skill": "optional"
    }
  ],
  "decks": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "name": "dev",
      "serviceIds": ["11111111-1111-4111-8111-111111111111"],
      "playbookIds": ["pb_example"]
    }
  ]
}
```

Bundle ids are **opaque within-file refs only** (membership + playbook deps). Import tries create; UNIQUE display-name conflicts **skip** and map to the existing row. `idMap` always maps bundle id → target id.

**Never present:** `credentials`, `credentialId`, `dependsOnCredentialIds` (export forces `[]`), OAuth tokens/state, `oauthClientSecret`, `localEnv`, `Authorization` headers, runtime fields (`health`, `isConnected`, `lastPing`, `isActive`).

### 7.2 Import report (`ImportReport`)

```json
{
  "status": "completed",
  "counts": {
    "services": { "created": 0, "reused": 1 },
    "playbooks": { "created": 1, "reused": 0 },
    "decks": { "created": 0, "reused": 1 }
  },
  "servicesNeedingOauth": ["Linear"],
  "warnings": ["Skipped service \"Linear\" (already exists)", "Skipped deck \"dev\" (already exists)"],
  "idMap": {
    "11111111-1111-4111-8111-111111111111": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "pb_example": "pb_example_imported",
    "22222222-2222-4222-8222-222222222222": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  }
}
```

`status`: `completed` | `failed` | `partial`. `idMap` is always present. New playbooks store remapped `dependsOnServiceIds` (never bundle-local service ids).

### 7.3 Export request (CLI / library)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `scope` | `collection` \| `deck` | no | default `collection` |
| `deckId` | uuid | when scope=`deck` | |
| `output` | path | yes (CLI) | write path for JSON |

---

## 8. Technical constraints & preferences

| Constraint | Detail |
|------------|--------|
| **Stack** | TypeScript monorepo; Zod; CLI via `@agent-deck/backend/cli-runtime` |
| **Data home** | `resolveAgentDeckHome()` — prod `~/.agent-deck/`, dev `~/.agent-deck/dev/` |
| **SQLite** | `services`, `decks`, `deck_services`, `playbooks`, `deck_playbooks` — **not** `credentials` / `deck_credentials` |
| **Codegen entry** | `packages/shared/src/schemas/export-bundle.ts`, `packages/backend/src/export-import/` |

**CLI commands (normative):**

```bash
agent-deck export all --output <path>
agent-deck export deck <uuid> --output <path>
agent-deck import <path>
```

**REST (dashboard client header):** `POST /api/export`, `POST /api/import`.

After import, bind with the **new** deck id from `idMap` or `agent-deck deck list`.

---

## 9. Non-functional requirements

| NFR | Target | Measurement |
|-----|--------|-------------|
| NFR-1 Export latency (full collection, 50 cards) | p95 < 5 s | Local; n ≥ 20 on M-series Mac |
| NFR-2 Import latency (same bundle) | p95 < 10 s | Same |
| NFR-3 Bundle size (50 cards) | < 5 MB | File size |
| NFR-4 Secret safety | 0 secret material in bundle | Unit tests on sanitize + zip/json scan |
| NFR-5 Forward compatibility | Reject unknown `version` with actionable error | Integration test |

---

## 10. Out of scope

| Item | Rationale |
|------|-----------|
| Credentials (metadata or secrets) | Explicit product cut; keys stay on each machine |
| Encrypted / plaintext secrets in bundle | Same |
| Preserve / upsert by source UUID | Natural-key reuse instead |
| Overwrite existing card body on reuse | v1 warns only |
| Cloud sync / multi-user replication | [MVP.md](./MVP.md) non-goals |
| MCP `export_bundle` / `import_bundle` | MVP: import/export is CLI/dashboard only |
| `exec_runs`, session binding, harness files | Not layout data |
| Icon cache | Re-fetch favicons |
| Git-tracked skills / app code | User owns in git |

---

## 11. Milestones

| Phase | Exit criteria |
|-------|---------------|
| **v1** | Zod schemas; link-or-create import; CLI units; REST; dashboard; shared-card + multi-deck-import tests; SC-1, SC-4 |

---

## 12. Open decisions

| Question | Default if undecided | Owner |
|----------|----------------------|-------|
| OD-1 Import bundle from older Agent Deck on newer host? | Reader accepts `version: 1` only; ship migration adapter when v2 needed | Eng |
| OD-2 Overwrite card config on reuse? | Defer; warn only in v1 | Eng |

---

## 13. How to use this PRD

| Consumer | Directive |
|----------|-----------|
| **Engineer** | Implement format → export → import → CLI; land tests before UI. |
| **AI codegen** | Read §7; generate `export-bundle.ts` + `packages/backend/src/export-import/` + CLI wiring; run round-trip tests. |
| **Reviewer** | Trace US-1 / US-4 to Req IDs and tests; verify Out of scope not re-introduced. |
| **User (migration)** | Export → copy file → import → follow report for OAuth; re-add API keys; `bind_workspace` with new deck id. |

---

## Appendix — source notes

| Source | Captured as |
|--------|-------------|
| Agent Deck playbook `pb_ai_codegen_prd` on **dev** deck | Document structure |
| Agent Deck playbook `pb_product_principle` | Voice, scope discipline |
| Chi — port env; no credentials in bundle | US-1, Out of scope |
| [MVP.md](./MVP.md) as-built; bind session-only | §1, drop preserve_ids |
| [PRD_DECK_DISPLAY.md](./PRD_DECK_DISPLAY.md) | No `deck.yaml` auto-bind |

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
- [x] Pricing section skipped with justification (§5)
