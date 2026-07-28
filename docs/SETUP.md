# Agent Deck — Setup Guide

Canonical install and environment reference. For OAuth / hosting / Slack confusion, start with **[OAUTH_AND_HOSTING.md](./OAUTH_AND_HOSTING.md)**.

## Prerequisites

- **Git**
- **npm** (comes with Node)
- **Node.js 24** (typical OS default) or **Node 20+** — see below

## Node.js version policy

| | |
|--|--|
| **Default (use this)** | **Node 24.x** — current OS / Homebrew / nvm default on new machines |
| **Minimum supported** | Node **20.0.0** (`engines` in all packages) |
| **Also supported** | 20, 22, 23, 24, 25, 26 (with matching `better-sqlite3` build) |
| **Optional nvm hint** | `.nvmrc` → `24` (only if you use nvm; **not** a downgrade to 20) |

Agent Deck does **not** require Node 20. We upgraded `better-sqlite3` (v12+) so current Node releases work with prebuilds. **Node 24 is what we develop and test against first** because that is what users already have.

### Check your version

```bash
node -v
```

- `v24.x.x` — expected default; no action needed
- `v20.x.x` — supported; run `npm install` on that version
- Anything below 20 — upgrade Node

### nvm users (optional)

If you use nvm and want the repo’s suggested version:

```bash
cd agent_deck
nvm install    # reads .nvmrc → 24
nvm use
node -v
```

If you already have Node 24 from the OS, **you do not need nvm or `.nvmrc`**.

### Native module mismatch

`better-sqlite3` is compiled for the Node version active during `npm install`. If you switch Node major versions, tests and the backend can fail with `NODE_MODULE_VERSION … was compiled against a different Node.js version`.

**Automatic:** `npm install` and `npm run test` run `scripts/rebuild-native.mjs` to recompile `better-sqlite3` for the current Node.

**Manual fix:**

```bash
npm rebuild better-sqlite3
# or: rm -rf node_modules && npm install
```

### Production / hosted backend

Use **Node 24** (`node:24-alpine` or current LTS on your host). Node 20 remains valid if your infra pins it — run the same install/rebuild on that runtime.

---

## Quick start (from source)

```bash
git clone https://github.com/not-so-fat/agent_deck.git
cd agent_deck
node -v    # v24.x recommended
npm install
npm run build
npm run dev:all
```

| Service | URL |
|---------|-----|
| Dashboard (dev) | http://localhost:3000 |
| Backend API | http://localhost:8000 |
| MCP | http://127.0.0.1:3001/mcp |

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:3001/backend-status
```

### Dev setup (unpublished CLI — menubar, badges)

Global `npm i -g @agent-deck/cli` tracks **published** npm only. Before release, use the monorepo CLI:

```bash
npm run build          # once
npm link -w @agent-deck/cli   # optional: `agent-deck` on PATH → local build

# With dev:all running (backend :8000, MCP :3001):
npm run setup:dev -- --client cursor --start
npm run setup:dev -- --client claude
```

On **macOS**, `setup` now **defaults to menubar** (SwiftBar plugin + status line + MCP + harness):

- Interactive terminal: tries `brew install --cask swiftbar` when SwiftBar is missing
- Sets SwiftBar’s plugin folder via `defaults write` (no manual Preferences step)
- Opt out: `--no-menubar`
- CI / scripts: `--no-menubar` or `AGENT_DECK_SETUP_NO_BREW=1`

Menubar-only refresh: `npm run setup:dev -- --menubar`

## Quick start (npm / end users)

```bash
npx @agent-deck/cli@latest setup --client cursor --start
# Dashboard → http://127.0.0.1:1111  (dev repo uses :8000 / :3000)
```

See [PUBLISHING.md](./PUBLISHING.md) and [README](../README.md).

### IDE deck indicator (optional)

MCP alone does **not** show the bound deck in Cursor IDE Agent chat. Terminal status line (Claude Code / Cursor CLI footer) is installed by default via `setup` — see [Distribution](./PUBLISHING.md#distribution-what-users-install).

## Ports

Two installs can run on the same machine without clashing:

| Mode | Backend | MCP | Dashboard |
|------|---------|-----|-----------|
| **Dev repo** (`npm run dev:all`) | 8000 | 3001 | http://localhost:3000 |
| **CLI / npx** (`agent-deck start`) | **1111** | **1110** | http://127.0.0.1:1111 |

Override CLI ports: `AGENT_DECK_PORT`, `AGENT_DECK_MCP_PORT`.

OAuth redirect URI follows the backend you use (e.g. dev → `http://127.0.0.1:8000/api/oauth/callback`, npx → `http://127.0.0.1:1111/api/oauth/callback`).

**Data directories:** production `agent-deck start` uses `~/.agent-deck/`. Monorepo dev (`npm run dev:all`) uses `~/.agent-deck/dev/` so decks and OAuth credentials do not mix with production.

### File store & git sync

Collection cards and deck layouts are mirrored as files under the data home (`manifest.json`, `playbooks/`, `services/`, `credentials/`, `decks/`). SQLite is a rebuildable cache — do not commit `agent_deck.db`. Layout and format: [STORE_FORMAT.md](./STORE_FORMAT.md).

**Agent Deck never runs git.** To sync across machines, initialize a git repo in your data home (or a subtree), ignore `*.db` and other local artifacts, commit the file tree, push/pull yourself, then run `agent-deck reindex` (or restart the backend). Keychain secrets and OAuth tokens stay on each machine.

One-shot `.agent-deck.json` export/import remains for sharing a layout without git — see [PRD_EXPORT_IMPORT.md](./PRD_EXPORT_IMPORT.md).

### Secrets & OAuth storage

Sensitive values use the same **OS secret store** as API keys (macOS Keychain; dev fallback file under `~/.agent-deck/`). **SQLite holds metadata only** — not plaintext secrets.

| What | Keychain account | SQLite (metadata) |
|------|------------------|-------------------|
| API key value | `cred_*` (per credential) | label, scheme, `env_name`, tags |
| OAuth **client secret** | `oauth-client-secret:{serviceId}` | Client ID, auth/token URLs, scope |
| OAuth **access + refresh tokens** | `oauth-tokens:{serviceId}` (JSON bundle) | `oauth_token_expires_at`, `oauth_has_token` |

**Migration:** older installs that stored client secrets or tokens in SQLite migrate automatically on first read (connect, MCP call, or token refresh). Legacy `Authorization` headers duplicated in `services.headers` are stripped after migration.

**API responses:** the dashboard sees `oauthHasToken` (boolean), not the bearer string. Collection warnings and OAuth status use that flag plus expiry.

**Performance:** Keychain reads are typically **sub‑millisecond to a few ms** on macOS — negligible next to MCP network calls (tens–hundreds of ms). Tokens are resolved when opening an MCP connection (cached for that session); refresh hits Keychain only when a token expires. You should not notice this in normal use. See [ARCHITECTURE.md — Secret storage](./ARCHITECTURE.md#secret-storage) for implementation detail.

Legacy reference:

| Port | Service |
|------|---------|
| 3000 | Vite frontend (**dev only**, `npm run dev:all`) |
| 8000 | Backend API (**dev repo**) |
| 3001 | MCP server (**dev repo**) |
| 1111 | Backend + bundled UI (**npx / CLI**) |
| 1110 | MCP server (**npx / CLI**) |

```bash
agent-deck status
agent-deck stop
agent-deck start --daemon          # background (recommended)
agent-deck start --daemon --force  # restart
```

**Daemon mode:** `agent-deck start --daemon` spawns a detached supervisor; backend/MCP logs go to `~/.agent-deck/logs/` (`backend.log`, `mcp.log`, `supervisor.log`). Foreground `agent-deck start` still works for debugging in an open terminal.

## Environment variables

### Core

| Variable | Purpose |
|----------|---------|
| `PORT` | Backend port (default `8000`) |
| `HOST` | Bind address |
| `NODE_ENV` | `development` / `production` |
| `AGENT_DECK_DEV` | `1` → data under `~/.agent-deck/dev` (monorepo `npm run dev:all` sets this). `0` → production home even if `NODE_ENV=development`. |
| `AGENT_DECK_HOME` | Data root override (DB, credentials yaml, secrets dir) |
| `AGENT_DECK_DB_PATH` | SQLite file override (smoke tests use `.temporal/logs/smoke-agent_deck.db`) |

### OAuth redirect (see [OAUTH_AND_HOSTING.md](./OAUTH_AND_HOSTING.md))

| Variable | Purpose |
|----------|---------|
| `AGENT_DECK_OAUTH_REDIRECT_URI` | Full callback URL override |
| `AGENT_DECK_PUBLIC_URL` | HTTPS origin → `{url}/api/oauth/callback` |
| `AGENT_DECK_DASHBOARD_URL` | Where to send browser after OAuth |

### Shared provider apps (maintainers)

| Variable | Purpose |
|----------|---------|
| `AGENT_DECK_SLACK_CLIENT_ID` | Agent Deck–owned Slack app |
| `AGENT_DECK_SLACK_CLIENT_SECRET` | Slack client secret (never commit) |

## Common issues

### NODE_MODULE_VERSION / better-sqlite3

You changed Node major after `npm install`:

```bash
npm rebuild better-sqlite3 -w @agent-deck/backend
```

### Port in use

```bash
agent-deck stop
```

### MCP tools missing after reconnect (Claude Code)

If `claude mcp list` shows agent-deck as **Connected** but the agent cannot call any `mcp__agent-deck__*` tool (`ToolSearch` returns no matches), the host session has a **stale tool index** — the server is healthy; the harness did not refresh after a brief disconnect.

**Fix:** Exit and restart the Claude Code session.

**Workaround:** Call the MCP JSON-RPC endpoint directly (`initialize` → `tools/call`) or use `curl` against `http://127.0.0.1:1110/mcp` (port may differ — check `claude mcp list`).

The terminal status line reflects the live MCP bind on the backend API; it stays **unbound** until `bind_workspace` and does not prove the harness can reach agent-deck when MCP is disconnected.

### Slack distribution requires HTTPS

[SLACK_OAUTH_APP.md](./SLACK_OAUTH_APP.md) — set `AGENT_DECK_PUBLIC_URL` on your hosted backend.

## Dashboard

Open the dashboard after [Quick start](#quick-start-npm--end-users) or `npm run dev:all`.

| Area | What it does |
|------|----------------|
| **My Collection** | All MCP, API key, and playbook cards (vault) |
| **Deck fan** | Cards on the **editing deck** — drag from collection to link/unlink |
| **My Decks** | Select which deck to edit; copy deck id (copy icon) |

**Terminology ([MVP.md](./MVP.md)):**

- **Editing deck** — dashboard UI only; does not change agent scope
- **Bound deck** — what agents see via `bind_workspace({ workspaceRoot, deckId })` or session override
- There is no “activate deck” for agents; ignore legacy API `POST /api/decks/:id/activate`

**Common tasks:**

1. **Register MCP** — remote URL, local stdio (tab in modal), or paste JSON config
2. **Register API key** — secret stored in Keychain; metadata in collection
3. **Register playbook** — markdown body; deps auto-detected on save
4. **OAuth** — Connect on MCP card; redirect URI shown in UI ([OAUTH_AND_HOSTING.md](./OAUTH_AND_HOSTING.md))
5. **Session bind** — agent calls `get_decks`, then `bind_workspace({ workspaceRoot, deckId })`
6. **Export / import layouts** — dashboard **Export all** / **Import** on My Collection, or per-deck Export on My Decks; CLI:

```bash
agent-deck export all -o backup.agent-deck.json
agent-deck export deck <uuid> -o my-deck.agent-deck.json
agent-deck import backup.agent-deck.json
```

Credentials and secrets are never included. Import creates cards/decks when names are new; **skips** any display name that already exists (same name = same card/deck). See [PRD_EXPORT_IMPORT.md](./PRD_EXPORT_IMPORT.md).

Card colors are fixed by type (MCP, API key, playbook). Service health and OAuth status update live via WebSocket.

---

## Development commands

```bash
npm run dev:all
npm test
npm run build
```

## Documentation map

| Guide | When to read |
|-------|----------------|
| [README.md](./README.md) | Doc index |
| [MVP.md](./MVP.md) | Shipped product & agent MCP |
| [OAUTH_AND_HOSTING.md](./OAUTH_AND_HOSTING.md) | Slack, HTTPS, local vs hosted |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Contributing |
| [SLACK_OAUTH_APP.md](./SLACK_OAUTH_APP.md) | Shared Slack app |
