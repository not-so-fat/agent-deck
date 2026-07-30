# Publishing Agent Deck

> **Cursor:** release steps are also in `.cursor/rules/npm-release-workflow.mdc` (loaded when editing `CHANGELOG.md`, `package.json`, or `PUBLISHING.md`).

## Packages

| npm package | Purpose |
|-------------|---------|
| `@agent-deck/shared` | Types and schemas |
| `@agent-deck/backend` | API, MCP server, SQLite, vault (includes bundled dashboard in `static-ui/`) |
| `@agent-deck/cli` | CLI — `start`, `doctor`, `credential`, `exec` (bin: `agent-deck`) |

Publish **in order**: shared → backend → cli.

## Prerequisites

- Node.js **24** (or **20+**) on the publish machine ([SETUP.md](./SETUP.md#nodejs-version-policy))
- npm account with access to publish `@agent-deck/*` (create the [npm org](https://www.npmjs.com/org/create) if needed)
- Logged in: `npm login`

## Version bump

```bash
# Set all package.json + server.json to the same semver
npm run version:sync -- 1.2.0

npm install
npm run build:release
```

Update `CHANGELOG.md`, then commit.

## Git tags & GitHub releases

Tag every npm release so `git checkout v1.2.1` matches what shipped.

| Tag format | Example |
|------------|---------|
| Annotated git tag | `v1.2.1` (matches root `package.json` / npm) |
| Points at | The `Ship X.Y.Z: …` commit on `main` |

### After publish

```bash
# Tag current HEAD (reads version from package.json), push, and create GitHub Release from CHANGELOG
npm run release:tag:push
```

### One-time backfill (older releases)

```bash
npm run release:tag:backfill
```

Scans `git log` for `Ship 1.2.1:` / `… at 1.1.5` subjects and tags those commits. Skips tags that already exist.

### Manual

```bash
git tag -a v1.2.1 -m "Agent Deck 1.2.1"
git push origin v1.2.1
gh release create v1.2.1 --title "1.2.1" --notes-file .temporal/logs/release-notes-1.2.1.md
```

## Dry run (local)

```bash
npm run build:release
npm run release:smoke   # also runs inside build:release — fresh HOME + npm pack + setup artifacts
npx @agent-deck/cli doctor
npx @agent-deck/cli start --open
```

**Release integration smoke** (`scripts/release-smoke.sh`) simulates what a user gets from npm: pack CLI, `setup --client claude` in a clean `HOME`, assert `statusline.sh` + `settings.json` exist, stdout is one clean line. Playbook: [examples/playbooks/npm-release-integration-smoke.md](./examples/playbooks/npm-release-integration-smoke.md).

Dashboard: `http://127.0.0.1:1111`  
MCP: `http://127.0.0.1:1110/mcp`

Dev repo (`npm run dev:all`) uses `:8000` / `:3001` so both can run together — see [SETUP.md](./SETUP.md#ports).

## Publish to npm

Tests must pass first (`npm test`). Publish is blocked if any workspace test fails.

```bash
npm run publish:packages
npm run release:tag:push
```

`release:tag:push` tags the ship commit, pushes `vX.Y.Z`, and creates a GitHub Release with notes from `CHANGELOG.md` (requires `gh` CLI).

This runs the full test suite, `build:release`, then publishes shared → backend → cli.

Or step by step:

```bash
npm run build:release
npm publish -w @agent-deck/shared --access public
npm publish -w @agent-deck/backend --access public
npm publish -w @agent-deck/cli --access public
```

The `@agent-deck/cli` package sets `mcpName` to match `server.json` for MCP Registry verification.

## MCP Registry

After npm publish:

1. Install [mcp-publisher](https://modelcontextprotocol.io/registry/quickstart)
2. Authenticate (GitHub namespace for `io.github.not-so-fat/agent-deck`)
3. Publish `server.json` from repo root

Users still run **`npx @agent-deck/cli start`** locally — the registry entry documents the HTTP MCP endpoint. After install, the command is still **`agent-deck`**.

## Distribution (what users install)

Agent Deck is **one engine** (`@agent-deck/cli`). Deck **display** is **terminal-only** (Claude Code / Cursor CLI prompt footer via `statusLine`).

| Artifact | Required? | Channel | What it does |
|----------|-----------|---------|--------------|
| **`@agent-deck/cli`** | **Yes** | npm | Backend API, MCP server, dashboard, vault, `setup`, `start`, `credential`, `exec` |
| **CLI status line** | No (default on) | `~/.cursor/cli-config.json` or `~/.claude/settings.json` | Prompt footer for **terminal** agents only |

### User paths

**Everyone (agents work):**

```bash
npx @agent-deck/cli@latest setup --client cursor --start
```

Writes MCP config, starts backend, and (by default) installs the terminal status line. Skip status line: `--no-statusline`.

**Claude Code / Cursor CLI terminal:** status line appears above the prompt when the host runs `statusLine.command` (see [PRD_DECK_DISPLAY.md](./PRD_DECK_DISPLAY.md)).

**Cursor IDE Agent chat:** no deck display API — use MCP `get_session_binding` or dashboard. Out of scope.

**Monorepo contributors:** `npm run dev:all` instead of `agent-deck start`; statusline tries API port `8000` then `1111`.

## End-user install (Claude Code)

```bash
npx @agent-deck/cli setup --client claude --start
```

Or step by step:

```bash
npx @agent-deck/cli start
```

```bash
claude mcp add --scope user --transport http agent-deck http://127.0.0.1:1110/mcp
```

### MCP client setup

| Client | Command |
|--------|---------|
| Cursor (global) | `agent-deck setup --client cursor` |
| Cursor (project) | `agent-deck setup --client cursor --scope project` |
| Claude Code | `agent-deck setup --client claude` (uses `claude mcp add` → `~/.claude.json`; fallback writes same file — **not** `settings.json`) |
| Claude Code (project) | `agent-deck setup --client claude --scope project` → `.mcp.json` |
| Claude Desktop | `agent-deck setup --client claude-desktop` (stdio bridge via supergateway) |

Add `--start` to launch Agent Deck after writing config.

### Managed install + auto-upgrade

**Recommended:** managed home install (Claude-style). Existing decks/credentials are untouched.

```bash
curl -fsSL https://raw.githubusercontent.com/not-so-fat/agent_deck/main/scripts/install.sh | bash
# or: npx @agent-deck/cli@latest install
export PATH="$HOME/.local/bin:$PATH"
```

| Command / env | Behavior |
|---------------|----------|
| `agent-deck install` | Unpack `@agent-deck/cli` into `~/.agent-deck/versions/`, point `current`, write `~/.local/bin/agent-deck` |
| `agent-deck upgrade` | Managed: download + activate; npm-global: `npm install -g @agent-deck/cli@latest` |
| `agent-deck upgrade --check` | Show if an update exists |
| (managed default) | Background check ≤1×/24h; download pending; activate on next `start`/`doctor`/`upgrade` (never on statusline/menubar) |
| `AGENT_DECK_DISABLE_AUTOUPDATER=1` | Disable background check/download/activate (manual `upgrade` still works) |
| `AGENT_DECK_AUTO_UPGRADE=1` | npm-global only: upgrade via `npm i -g` on `start` |
| `AGENT_DECK_NO_UPDATE_CHECK=1` | npm-global only: disable update notification on start |

Windows: use `npm install -g` until a managed shim exists.

Optional env:

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_DECK_PORT` | `1111` | API + dashboard (dev repo uses `8000` for API) |
| `AGENT_DECK_MCP_PORT` | `1110` | MCP HTTP endpoint (dev repo uses `3001`) |
| `AGENT_DECK_HOME` | `~/.agent-deck` | Database, credential metadata, and managed `versions/` |

## Development vs published

| Mode | Command | Dashboard |
|------|---------|-----------|
| **Dev** (hot reload) | `npm run dev:all` | `http://localhost:3000` (Vite proxy) |
| **Published / release** | `npx @agent-deck/cli start` | `http://127.0.0.1:1111` (bundled static UI) |
