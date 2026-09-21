# Agent Deck MVP — Development Spec

**Status:** Modules 1–3 implemented (as-built)  
**Doc role:** Product / scope spec (PRD equivalent for this repo)  
**Last aligned:** 2026-06-30  
**Vision / future reference:** [Agent Deck v2](file:///Users/not_so_fat/workspace/Obsidian/lexicon-personal/Ideas/personal/Agent%20Deck%20v2.md) (Obsidian) — full card model, API profiles, workflow tiers.  
**Related PRDs:** [PRD_EXPORT_IMPORT.md](./PRD_EXPORT_IMPORT.md) (CLI + dashboard metadata export/import) · [PRD_DECK_DISPLAY.md](./PRD_DECK_DISPLAY.md)

**Goal:** Ship **Modules 1–3** on top of v1 (MCP proxy + decks). Prove unconscious scoping, centralized API keys, and reusable playbooks.

---

## MVP delivers

| Module | Feature | User outcome |
|--------|---------|--------------|
| **1. Scope** | Session `bind_workspace` + optional env | Agent picks deck per session; no repo file |
| **2. Vault** | Credentials in Keychain + `agent-deck exec` | One place for API keys; scripts run without `.env` |
| **3. Playbooks** | Playbook cards + MCP read/write tools | Repeat procedures without re-explaining in chat |

**Explicitly out of MVP scope** (see vision doc): API profile catalog, `call_api`, workflow manifest runner, save-from-chat extractor, progressive tool discovery, session phases.

**In MVP:** API keys via **Credential** cards and env injection — not deferred.

---

## Terminology (as-built)

| Term | Meaning |
|------|---------|
| **Bound deck** | Deck for an **agent MCP session** via `bind_workspace({ workspaceRoot, deckId })`, `switch_bound_deck`, env `AGENT_DECK_DECK_ID`, or header `x-agent-deck-deck-id`. |
| **Editing deck** | Deck selected in the **dashboard** for layout edits (`localStorage`: `agent-deck-editing-deck-id`). Does not affect agent scope. |
| **My Collection** | Dashboard vault UI — all registered MCP services, API keys, and playbook cards (not a sidebar list). |
| **Legacy active deck** | v1 `decks.is_active` + `POST /api/decks/:id/activate` + `GET /api/decks/active` still exist in the API/DB for backward compatibility; **MVP agent scoping and dashboard do not use them**. |

---

## As-built notes (impl vs original draft)

Changes agreed during MVP implementation:

1. **No global active deck for agents** — scoping is per MCP session (`bind_workspace` + `deckId`), not “one active deck for the whole MCP server.”
2. **No repo deck manifest** — `.agent-deck/deck.yaml` is not read; agents bind explicitly each session.
3. **MCP tool names** — primary tools use `*_bound_deck_*`; `*_active_deck_*` tools remain as **deprecated aliases**.
4. **Dashboard** — selects an **editing deck** only; copy deck id from deck sidebar; **Import Deck** removed.
5. **API keys** — shown only in **My Collection** (with MCP cards); vault API requires `x-agent-deck-client: dashboard`.
6. **Fixed card colors** — MCP `#39FF14`; API keys `#F9386D`; playbooks `#FFFFFF`; MCP registration no longer exposes a color picker.
7. **MCP card logos** — favicons auto-resolved from MCP URL on register; served at `GET /api/services/:id/icon` (POC shipped).
8. **v1 header migration** — not automated; re-register as Credential + optional `credential_id` on Service.
9. **Playbook cards** — stored in SQLite collection (like MCP/API key cards); markdown body + dependency refs; no filesystem discovery.

---

## Non-goals (MVP)

- Replacing Cursor skill loading mechanism (see [PLAYBOOKS_AND_SKILLS.md](./PLAYBOOKS_AND_SKILLS.md))
- Running or bundling third-party CLIs (only wrap via `exec`)
- Cloud sync / multi-user
- Breaking v1 MCP proxy behavior

---

## Architecture (MVP)

```
┌─────────────────────────────────────────────────────────┐
│  Agent host (Cursor)                                     │
│    └── MCP → localhost:3001/mcp (dev) or :1110/mcp (CLI) │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  Agent Deck                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Deck scope  │  │ Vault        │  │ Playbooks     │ │
│  │ (session)   │  │ (Keychain)   │  │ (cards)       │ │
│  └─────────────┘  └──────────────┘  └───────────────┘ │
│  ┌─────────────┐  ┌──────────────┐                     │
│  │ MCP proxy   │  │ CLI: exec    │                     │
│  │ (v1)        │  │              │                     │
│  └─────────────┘  └──────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

---

## Module 1 — Scope

### Session binding

Each MCP session starts **unbound**. The agent calls `bind_workspace({ workspaceRoot, deckId })` with a deck id from `get_decks` or the dashboard (My Decks → copy icon).

**Agent binding:**

> **Switching contract:** agent-initiated `switch_bound_deck` switching below is **superseded by** [Session/default deck-switching redesign](./superpowers/specs/2026-09-20-session-deck-switching-redesign.md) (NOT-204). Agents may only request a switch; a human approves it as This session only or This workspace by default.

1. MCP `bind_workspace({ workspaceRoot, deckId })` — required `deckId`; sets workspace + deck for this session
2. MCP `switch_bound_deck({ deckId })` — change deck mid-session
3. Optional env `AGENT_DECK_WORKSPACE` + `AGENT_DECK_DECK_ID` for dev/single-session defaults

**Precedence:** session `deckId` / `x-agent-deck-deck-id` → env default → error (unbound)

**Dashboard** does not activate decks for agents. It only **edits** whichever deck you select (UI state in `localStorage`). Copy the deck id from the deck sidebar for `bind_workspace`.

Monorepo note: same workspace path can bind different decks per concurrent MCP session — see [MONOREPO_SCOPE.md](./MONOREPO_SCOPE.md).

### Behavior

1. Agent calls `get_decks`, then `bind_workspace` with workspace root and `deckId`.
2. Concurrent sessions at the same path can use different `deckId` values via session binding.
3. No fallback to a global active deck or `decks.is_active`.

### Deliverables

- [x] Backend: `GET /api/scope/deck` (requires session deck id header)
- [x] MCP: `bind_workspace`, `switch_bound_deck`, `get_session_binding`, `get_bound_deck` (deprecated `get_active_deck` alias)
- [x] Dashboard: editing deck selector, copy deck id
- [x] Docs: monorepo session binding — [MONOREPO_SCOPE.md](./MONOREPO_SCOPE.md)
- [x] Removed: repo `.agent-deck/deck.yaml`, `setup_repo_deck`, `get_repo_deck_status`, `POST /api/scope/resolve`

---

## Module 2 — Vault (API keys)

### Credential model (MVP)

Single card type — no separate Secret entity in UI (Keychain is storage backend).

```yaml
# ~/.agent-deck/credentials/cred_ashby.yaml (metadata only)
id: cred_ashby
label: Ashby API
scheme: http_basic_user    # bearer | header | http_basic_user
header_name: null          # for scheme: header
env_name: ASHBY_API_KEY    # injected by exec
tags: [hiring]
```

Value stored in **macOS Keychain** (service: `agent-deck`, account: `cred_ashby`). SQLite holds metadata only.

### Who sets `id`, `env_name`, and `scheme`?

| Field | Dashboard (human) | CLI / REST (power user) | Agent |
|-------|-------------------|-------------------------|-------|
| `label`, secret value | User enters name + key | User or script | Should not register secrets in chat |
| `id` (`cred_*`) | **Auto** from label slug | Optional override | Read-only; use ids from bound deck |
| `env_name` | **Auto** (`OPENAI_API_KEY` style) | Optional `--env-name` | Read-only; use for `exec` / scripts |
| `scheme` | **Auto** (`bearer` default) | Optional `--scheme` | Read-only |

Humans never pick env var names in the UI. Agents **discover** metadata via the bound deck — they do not invent env names at runtime.

### Deck scoping (strict enforcement)

- **Vault (collection)** = all registered API keys. Dashboard only via `GET /api/credentials/vault` with header `x-agent-deck-client: dashboard`.
- **Bound deck** = project boundary for agents. Agents only see credentials on the session-bound deck (via `bind_workspace` / `x-agent-deck-deck-id`).
- **Editing deck (dashboard)** = drag target for MCP and API key cards. Drag onto deck to link; drag out to unlink — keys stay in the vault.
- **Unique display names** — deck `name`, service `name`, playbook `title`, and credential `label` are UNIQUE (users/agents distinguish by name, not UUID).

Client header `x-agent-deck-client`:

| Value | Client | Credential access |
|-------|--------|-------------------|
| `dashboard` | Agent Deck UI | Full vault CRUD; deck linking for any deck |
| `agent` or omitted | MCP / scripts | Bound-deck mutations only; collection metadata read; no secret CRUD |

**Dashboard-only (human-in-the-loop):**

- API key **secret** create, rotate, update value (`POST/PUT/rotate /api/credentials`)
- MCP **OAuth** browser flow (`/api/oauth/*`)

**Agent MCP tools (collection + bound deck):**

| Tool | Purpose |
|------|---------|
| `bind_workspace` / `switch_bound_deck` | Bind session to workspace + deck |
| `get_session_binding` | Workspace, effective deck, `display_summary` |
| `get_decks`, `get_bound_deck`, `create_deck` | Deck read/create (`get_bound_deck` includes services, credentials, playbook summaries) |
| `manage_deck_card` | Link, unlink, or reorder cards on bound deck (`card_type`: service \| credential \| playbook) |
| `list_collection` | Collection metadata (optional `card_type` filter) |
| `register_service` / `update_service` | MCP collection create/update (delete via dashboard/CLI) |
| `update_service_tool_settings` | Enable/disable proxied tools |
| `register_playbook` / `update_playbook` | Playbooks (delete via dashboard/CLI) |
| `get_playbook` | Full playbook body + dependencies |
| `list_service_tools` / `call_service_tool` | Proxy to services on bound deck |

**Not MCP:** secrets, OAuth consent, delete card, import/export — dashboard/CLI (`agent-deck service|playbook|deck list|delete`, `agent-deck export all|export deck|import`). Optional profile: `AGENT_DECK_MCP_TOOL_PROFILE=runtime|standard|legacy` (default `standard`). See [MCP_TOOL_OPTIMIZATION.md](./MCP_TOOL_OPTIMIZATION.md).

Deprecated (removed from `standard`; available in `legacy` profile only): `get_active_deck`, `list_active_deck_*`, `list_bound_deck_*`, `list_playbooks`, `list_collection_*`, `add_*_to_bound_deck`, `remove_*_from_bound_deck`.

### Dashboard UI (Module 2)

- **My Collection** — MCP, API key, and playbook playing cards (MCP `#92E4DD`, API key `#F9386D`, playbook `#FFFFFF`).
- **Deck editor** — fan of cards for the **editing deck**; drag-and-drop from collection (agents can also link via MCP tools).
- **Register MCP / Register API key** — modals; MCP color picker removed.
- **MCP logos** — auto-fetched favicon on register; `iconUrl` → `GET /api/services/:id/icon`.

### Agent-facing REST (metadata only — never secret values)

```http
GET /api/credentials
→ bound-deck credentials only (requires x-agent-deck-workspace or x-agent-deck-deck-id)

GET /api/credentials/vault
→ dashboard header required; full vault for My Collection

GET /api/credentials/:id
→ 403 unless credential is on bound deck (dashboard: full access with header)

GET /api/decks
→ agent: credentials stripped from non-bound decks

POST /api/decks/:deckId/credentials   { credentialId }   (agent: bound deck only)
DELETE /api/decks/:deckId/credentials   { credentialId }   (agent: bound deck only)

GET /api/credentials/collection
→ all credential metadata (no secrets); agent-safe for linking

GET /api/playbooks/collection
→ all playbook cards; agent-safe for linking
```

**Legacy (v1, not used for MVP agent scoping):**

```http
GET /api/decks/active
POST /api/decks/:id/activate
```

See **Agent MCP tools** table above for the full tool surface.

**Exec injection:** `agent-deck exec --deck <id> --connections cred_a,cred_b -- <cmd>` validates each credential is on the deck when `--deck` is set. Agents run scripts; they never receive raw keys in tool results.

### Migration from v1

- Existing `services.headers` with `Authorization` → **manual**: create Credential + Keychain entry, set `credential_id` on Service (no auto-migration).
- MCP services may reference `credential_id` instead of inline headers.

### CLI: `agent-deck exec`

```bash
agent-deck exec \
  --deck <deck-id> \
  --connections cred_ashby,cred_openai,cred_slack \
  [--dry-run] \
  -- <command...>
```

Behavior:

1. Resolve each credential → fetch from Keychain.
2. Build env map from `env_name` → value.
3. Spawn child with inherited env + injected vars (never print secrets).
4. Log credential **ids** used (audit), not values.

Subcommands (MVP):

```bash
agent-deck credential add cred_ashby --env-name ASHBY_API_KEY --scheme http_basic_user
agent-deck credential list
agent-deck credential rotate cred_ashby   # prompt for new value
```

Package: `packages/cli`.

### Deliverables

- [x] Keychain adapter (macOS first; Linux secret-service later)
- [x] Credential CRUD API + dashboard UI (My Collection cards)
- [x] `packages/cli` with `exec` subcommand
- [ ] Migrate v1 header storage (manual only; see Migration from v1)
- [x] Tests: exec injects env; agent MCP cannot read raw values

---

## Module 3 — Playbooks (cards)

### Playbook card model

Playbooks are **first-class cards** in My Collection — same lifecycle as MCP and API key cards:

- Register in dashboard → appears in **My Collection** (white `#FFFFFF`, label **PB**)
- Drag onto a **deck** to scope for agents
- Agent retrieves via `get_bound_deck` (summaries) / `get_playbook` (bound deck only)

Stored in SQLite (`playbooks` + `deck_playbooks`). Body is markdown; metadata includes triggers, optional exec/skill hints, and **dependencies** on other cards.

**Playbooks vs Cursor Skills:** playbooks are scoped runbooks on the deck connection graph; skills are repo-native agent behavior. They complement each other — see [PLAYBOOKS_AND_SKILLS.md](./PLAYBOOKS_AND_SKILLS.md).

```typescript
{
  id: "pb_hiring_inbox",       // auto from title slug
  title: "Hiring inbox",
  body: "# Steps\n1. …",       // markdown instructions / API guides
  triggers: ["check inbox"],
  dependsOnCredentialIds: ["cred_ashby", "cred_openai"],
  dependsOnServiceIds: ["<mcp-service-uuid>"],
  exec: "agent-deck exec …",   // optional
  skill: ".cursor/skills/…"    // optional
}
```

### Dependencies

- Declared manually (optional checkboxes in dashboard) or **auto-detected** on save from content — dashboard POST and agent `register_playbook` / `update_playbook` (matches `cred_*` ids, env names, MCP names/uuids, and `--connections` flags in body/exec)
- **Details modal** shows resolved dependencies + warnings for missing refs
- **Delete API key / MCP** → blocked (409) if any playbook references it
- **Remove from deck** (drag out) → confirm if playbooks depend on that card

### Agent API

```http
GET /api/playbooks/vault          → dashboard: all playbook cards
GET /api/playbooks                → agent: playbooks on bound deck
GET /api/playbooks/summaries      → agent: id, title, triggers
GET /api/playbooks/:id            → full body + dependencies
GET /api/playbooks/dependents/check?credentialId=…|serviceId=…

POST   /api/playbooks             → create card + auto-detect deps (dashboard and agent)
PUT    /api/playbooks/:id         → update + re-detect deps (dashboard: any; agent: on bound deck)
DELETE /api/playbooks/:id         → dashboard: delete

POST   /api/decks/:deckId/playbooks   { playbookId }
DELETE /api/decks/:deckId/playbooks   { playbookId }
```

### MCP tools (`:1110/mcp` CLI · `:3001/mcp` dev)

| Tool | Args | Returns |
|------|------|---------|
| `get_bound_deck` | — | Deck snapshot including playbook summaries (id, title, triggers) |
| `get_playbook` | `playbook_id` | Full body + dependencies |
| `register_playbook` | `title`, `body`, optional `triggers`, `playbook_id`, `exec`, `skill`, dependency overrides, `add_to_bound_deck`, `auto_detect_dependencies` | Created playbook + resolved dependencies |
| `update_playbook` | `playbook_id`, optional fields above | Updated playbook + resolved dependencies |
| `manage_deck_card` | `action`, `card_type`, `card_id` | Link/unlink playbook (or other card) on bound deck |

No `run_playbook` executor — agent reads content and follows steps.

### Dashboard

- **Register playbook** button (sidebar, white card style)
- Playbook cards in **My Collection** with drag-and-drop; dependencies auto-detected on save
- **Details** on click — instructions, dependencies, missing-ref warnings

### Examples

Template content for registration: [docs/examples/playbooks/](./examples/playbooks/) (copy into Register playbook form — not auto-loaded from disk).

### Deliverables

- [x] Playbook card schema + SQLite storage
- [x] CRUD API + deck linking
- [x] Dependency warnings on delete / deck removal
- [x] MCP tools `get_bound_deck` (playbook summaries), `get_playbook`, `register_playbook`, `update_playbook`
- [x] Dashboard: collection cards + registration + details modal
- [x] Example markdown in `docs/examples/`

---

## Reference integration — hiring CLI (Ashby)

Dogfood target for Modules 2–3. External repo: `ashby-triage` (local Python CLI).

### Connection map

| Credential | env var | Used by |
|------------|---------|---------|
| `cred_ashby` | `ASHBY_API_KEY` | Ashby REST (HTTP Basic) |
| `cred_openai` | `OPENAI_API_KEY` | LLM triage |
| `cred_slack` | `SLACK_BOT_TOKEN` | Post decisions |

No MCP for Ashby — validates **API key + exec** path.

### Target layout (in ashby-triage repo, not agent_deck)

```
ashby-triage/
  roles/              # unchanged — user's domain logic
  .claude/skills/hiring/SKILL.md
```

Agent binds via `bind_workspace({ workspaceRoot, deckId: "<hiring-deck-uuid>" })`.

Register hiring playbooks as **cards** in Agent Deck (dashboard or `register_playbook` MCP tool). Sample content: [docs/examples/playbooks/](./examples/playbooks/).

### MVP validation commands

```bash
# Register creds once (global store)
agent-deck credential add cred_ashby --env-name ASHBY_API_KEY --scheme http_basic_user
agent-deck credential add cred_openai --env-name OPENAI_API_KEY --scheme bearer
agent-deck credential add cred_slack --env-name SLACK_BOT_TOKEN --scheme bearer

# Run without .env
cd ashby-triage
agent-deck exec --deck <deck-id> --connections cred_ashby,cred_openai,cred_slack -- \
  uv run hiring inbox --dry-run
```

### Agent path (Module 3)

1. `bind_workspace` → bound deck includes hiring playbook cards + cred refs (linked in dashboard).
2. User: “Check hiring inbox.”
3. Agent: `get_playbook(pb_hiring_inbox)` → follows steps → suggests `agent-deck exec …`.
4. Agent refines playbook via `update_playbook` after a run (dependencies re-detected automatically).

### Future (vision doc only)

- API profile `api_ashby` with endpoint catalog
- Workflow card Tier 2 binding CLI permanently
- Manifest for confirm loops / SQLite cache

---

## Implementation order (historical)

1. **Module 2** (vault + exec)
2. **Module 1** (repo deck yaml)
3. **Module 3** (playbooks + MCP tools)

---

## Success criteria

- [x] Open `agent_deck` repo in Cursor → v1 MCP proxy still works.
- [ ] Register 3 credentials; run hiring CLI via `exec` with no `.env` (dogfood in external `ashby-triage` repo).
- [x] Playbook markdown discoverable; agent retrieves via `get_playbook`.
- [x] No secret values in SQLite, MCP responses, or logs.
- [x] README links to this doc (see [README](../README.md); user-facing tool list may still mention legacy names — prefer this doc for MVP behavior).

---

## Resolved decisions

| Question | Decision |
|----------|----------|
| Deck yaml links DB deck vs inline services | **`deck_id`** — reuse v1 dashboard |
| Credential store path | **`~/.agent-deck/credentials/`** yaml + Keychain |
| Linux vault | macOS first; stub Linux |
| CLI package location | **`packages/cli`** |
| Global active deck vs workspace bind | **Workspace bind** for agents; dashboard uses editing deck only |
| MCP tool naming | **`*_bound_deck_*`** primary; `*_active_deck_*` deprecated |
| Card colors | **Fixed** by type (MCP green, API key magenta, playbook white) |
| API key UI location | **My Collection** cards only (not sidebar vault list) |

---

## Related docs

- [PRD_EXPORT_IMPORT.md](./PRD_EXPORT_IMPORT.md) — collection/deck metadata export/import (CLI + dashboard; no credentials; skip on unique name)
- [PRD_DECK_DISPLAY.md](./PRD_DECK_DISPLAY.md) — bound deck visibility in Cursor/Claude (proposed)
- [README.md](./README.md) — documentation index and conventions
- [PLAYBOOKS_AND_SKILLS.md](./PLAYBOOKS_AND_SKILLS.md) — when to use playbooks vs Cursor skills
- [MONOREPO_SCOPE.md](./MONOREPO_SCOPE.md) — monorepo session binding
- [ARCHITECTURE.md](./ARCHITECTURE.md) — components, secrets, data model
- [DEVELOPMENT.md](./DEVELOPMENT.md) — contribute, test
- [examples/playbooks/](./examples/playbooks/) — sample playbook markdown
- Vision: Agent Deck v2 (Obsidian) — API profiles, workflow tiers
