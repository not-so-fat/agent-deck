# Publishing Agent Deck

> **Cursor:** release steps are also in `.cursor/rules/npm-release-workflow.mdc` (loaded when editing `CHANGELOG.md`, `package.json`, or `PUBLISHING.md`).

## Packages

| npm package | Purpose |
|-------------|---------|
| `@agent-deck/shared` | Types and schemas |
| `@agent-deck/backend` | API, MCP server, SQLite, vault (includes bundled dashboard in `static-ui/`) |
| `@agent-deck/cli` | CLI — `start`, `doctor`, `credential`, `exec` (bin: `agent-deck`) |

Publish **in order**: shared → backend → cli.

## Release flow (agent + one approval)

No npm login is needed for a normal release. The agent prepares everything,
pushes the `vX.Y.Z` tag, and a GitHub Actions workflow publishes to npm via
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC —
no npm token anywhere). The only human step is the owner approving the `npm`
environment on GitHub.

1. `npm run version:sync -- X.Y.Z` — all workspaces + `server.json`
2. Update `CHANGELOG.md` for `X.Y.Z`
3. `npm install` && `npm run build:release` (includes the release smoke)
4. Commit on `main`: `Ship X.Y.Z: <short why>.`
5. Push `main`
6. **Agent:** `npm run release:tag:push-only` (creates and pushes the annotated
   `vX.Y.Z` tag; this starts `.github/workflows/release.yml` — do **not**
   create the GitHub Release locally)
7. **Human:** approve the `npm` environment when GitHub asks (the workflow
   waits for the owner's review)
8. **Agent:** watch the workflow to green, then verify
   `npm view @agent-deck/cli version` shows `X.Y.Z`. The workflow creates the
   GitHub Release from the `CHANGELOG.md` section after all three packages
   are live.

## Prerequisites

- Node.js **24** (or **20+**) on the machine preparing the release ([SETUP.md](./SETUP.md#nodejs-version-policy))
- No npm login for a normal release — publishing happens in GitHub Actions
  with OIDC. (`npm login` + OTP is only needed for the
  [manual fallback](#manual-fallback-local-publish).)
- One-time owner setup (before the first workflow release):
  - On [npmjs.com](https://www.npmjs.com), each of `@agent-deck/shared`,
    `@agent-deck/backend`, `@agent-deck/cli` trusts publisher
    `not-so-fat/agent-deck`, workflow `release.yml`, environment `npm`
    (canonical repo name — `agent_deck` only redirects).
  - In repo Settings → Environments, environment `npm` requires the owner's
    review.

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

### Normal path: push the tag, the workflow does the rest

```bash
# Agent: tags the Ship commit and pushes vX.Y.Z — starts release.yml
npm run release:tag:push-only
```

Pushing the tag triggers `.github/workflows/release.yml`, which waits for the
owner's `npm` environment approval, then verifies the tag
(`scripts/release-guard.mjs`: tag == root version, workspaces + `server.json`
in sync, tag on `main`, `CHANGELOG.md` section present), runs
`npm run build:release`, publishes shared → backend → cli with provenance
(skipping versions already on npm, so a re-run finishes a partial publish),
and finally creates the GitHub Release with notes from the `CHANGELOG.md`
section. Watch it (`gh run watch`) and confirm with
`npm view @agent-deck/cli version`.

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
npx @agent-deck/cli start
# opens dashboard with a secure session; --no-open for headless
```

**Release integration smoke** (`scripts/release-smoke.sh`) simulates what a user gets from npm: pack CLI, verify the tarball ships `dist/muse-skills/*/SKILL.md` byte-identical to root `skills/*/SKILL.md`, run `setup --client claude` and `setup --client muse` in a clean `HOME`, assert `statusline.sh` + `settings.json` plus Muse MCP settings + four managed skills exist, stdout is one clean line. Playbook: [examples/playbooks/npm-release-integration-smoke.md](./examples/playbooks/npm-release-integration-smoke.md).

Dashboard: opened by `start` / `agent-deck open`; `status` never prints the disposable bootstrap URL (API listens on `http://127.0.0.1:1111`)
MCP: `http://127.0.0.1:1110/mcp`

Dev repo (`npm run dev:all`) uses `:8000` / `:3001` so both can run together — see [SETUP.md](./SETUP.md#ports).

## Publish to npm

Normal releases publish from `.github/workflows/release.yml` (trusted
publishing, no npm login): the workflow runs the full test suite via
`build:release`, publishes shared → backend → cli, and creates the GitHub
Release. The agent watches the run and verifies
`npm view @agent-deck/cli version` afterwards.

### Manual fallback (local publish)

Only when the workflow cannot be used. Requires an npm account with access to
`@agent-deck/*`, `npm login`, and OTP for each publish:

```bash
# Human: local publish (OTP)
npm run publish:packages
```

`publish:packages` runs the full test suite, `build:release`, then publishes
shared → backend → cli. Afterwards the agent tags and releases locally:

```bash
# Agent: only for the manual fallback — the workflow owns this normally
npm run release:tag:push
```

`release:tag:push` tags the ship commit, pushes `vX.Y.Z`, and creates a GitHub
Release with notes from `CHANGELOG.md` (requires `gh` CLI).

Or step by step (human):

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

## Discoverability

| Channel | Notes |
|---------|-------|
| **GitHub** | Demo GIF, README |
| **npm** | `npm install -g @agent-deck/cli` |
| **MCP Registry** | `server.json` — see [MCP Registry](#mcp-registry) above |
| **Codex marketplace** | `.codex-plugin/` + HOL listing (pending awesome-codex-plugins PR after green CI) — [CODEX_PLUGIN.md](./CODEX_PLUGIN.md) |
| **Codex AGENTS.md** | `agent-deck setup --client codex` marker-merges global guidance; `--scope project` targets the current repo |
| **Claude Code** | `/plugin marketplace add` via `.claude-plugin/` |
| **Cursor** | `agent-deck setup --client cursor` |
| **Muse** | `agent-deck setup --client muse` installs native bootstrap skills; `--scope project` merges root `AGENTS.md` (workspace trust required) |

## Distribution (what users install)

Agent Deck is **one engine** (`@agent-deck/cli`). Deck **display** is **terminal-only** (Claude Code / Cursor CLI prompt footer via `statusLine`; Muse has no status line).

| Artifact | Required? | Channel | What it does |
|----------|-----------|---------|--------------|
| **`@agent-deck/cli`** | **Yes** | npm | Backend API, MCP server, dashboard, vault, `setup`, `start`, `credential`, `exec` (ships `dist/muse-skills/*/SKILL.md` copied from root `skills/` at build) |
| **CLI status line** | No (default on for Cursor/Claude) | `~/.cursor/cli-config.json` or `~/.claude/settings.json` | Prompt footer for **terminal** agents only (not Muse) |

### User paths

**Everyone (agents work):**

```bash
npx @agent-deck/cli@latest setup --client cursor --start
```

Writes MCP config, starts backend, and (by default) installs the terminal status line. Skip status line: `--no-statusline`.

**Claude Code / Cursor CLI terminal:** status line appears above the prompt when the host runs `statusLine.command` (see [PRD_DECK_DISPLAY.md](./PRD_DECK_DISPLAY.md)).

**Cursor IDE Agent chat:** no deck display API — use MCP `get_session_binding` or dashboard. Out of scope.

**Muse:** no status line or plugin install. `agent-deck setup --client muse` writes MCP + native bootstrap skills; `--scope project` merges root `AGENTS.md` (workspace trust required). Start a new Muse process after setup and verify `/mcp` shows `agent-deck`.

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
| Codex (global instructions) | `agent-deck setup --client codex` → global HTTP fallback in `~/.codex/config.toml` + `~/.codex/AGENTS.md`; plugin supplies skills |
| Codex (project instructions) | `agent-deck setup --client codex --scope project` → `./AGENTS.md` |
| Cursor (global) | `agent-deck setup --client cursor` → global HTTP fallback in `~/.cursor/mcp.json`; plugin supplies skills |
| Cursor (project) | `agent-deck setup --client cursor --scope project` → `.cursor/mcp.json` |
| Claude Code | `agent-deck setup --client claude` (uses `claude mcp add` with the headerless HTTP fallback → `~/.claude.json`; fallback writes the same entry — **not** `settings.json`) |
| Claude Code (project) | `agent-deck setup --client claude --scope project` → `.mcp.json` |
| Claude Desktop | `agent-deck setup --client claude-desktop` (Agent Deck's built-in stdio bridge) |
| Muse (global) | `agent-deck setup --client muse` → MCP settings + three native bootstrap skills (no status line, no plugin) |
| Muse (project) | `agent-deck setup --client muse --scope project` → headed HTTP `.mcp.json` entry (same shape as `use`) + root `AGENTS.md` merge (trust the workspace) |

Add `--start` to launch Agent Deck after writing config. Per-repo assignment: `agent-deck use <deck>` (plain or `--client muse` — both write the identical headed HTTP `.mcp.json` entry Muse accepts; the `--client muse` form also warns outside a git repository and when the user settings still hold the legacy launcher entry). After Muse setup, start a new Muse process and check `/mcp`; the first turn calls `get_session_context` once and shows exactly one verbatim `display_summary` line.

### Managed install + auto-upgrade

**Recommended:** managed home install (Claude-style). Existing decks/credentials are untouched.

```bash
curl -fsSL https://raw.githubusercontent.com/not-so-fat/agent_deck/main/scripts/install.sh | bash
# or: npx @agent-deck/cli@latest install
export PATH="$HOME/.local/bin:$PATH"
```

Compat: `npm install -g @agent-deck/cli` still works; `agent-deck install` switches only the CLI binary (no data migration).

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
| **Dev** (hot reload) | `npm run dev:all` | Vite at `http://localhost:3000` (proxy; open via that UI) |
| **Published / release** | `npx @agent-deck/cli start` | Opens with bootstrap cookie; API on `127.0.0.1:1111` |
