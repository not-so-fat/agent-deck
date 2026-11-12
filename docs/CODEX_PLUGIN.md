# Codex Plugin & HOL Marketplace — Design / Implementation Guide

**Goal:** get Agent Deck listed in [hashgraph-online/awesome-codex-plugins](https://github.com/hashgraph-online/awesome-codex-plugins) (invited by the HOL CEO), packaged so the same bundle also serves Claude Code and Cursor users.

**Status:** Option A implemented (monorepo root) · local `plugin-scanner` **100/100**, zero high/critical · HOL awesome-list PR pending green scanner CI on `main` · owner: not-so-fat · created 2026-07-18 · as-built 2026-07-19

**As-built notes**

- Layout: Option A at repo root (not a thin sibling repo). Scanner scans the monorepo; [`.plugin-scanner.toml`](../.plugin-scanner.toml) `ignore_paths` mirrors [`.codexignore`](../.codexignore) so product surfaces (`apps/`, `packages/`, `scripts/`, …) do not tank secrets/code-quality checks.
- No `.mcp.json` ships in the bundle: the Codex/Claude plugins declare no MCP server (skills and guidance only). The connection is plain host MCP config written by `agent-deck setup` (global headerless fallback, port **1110** on the installed daemon) and `agent-deck use` (per-folder entry). Dev override lives in local `.cursor/mcp.json` (3001).
- Claude Code: [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json) + [`marketplace.json`](../.claude-plugin/marketplace.json) share the same `skills/`.
- Version: `scripts/sync-versions.mjs` updates `.codex-plugin/plugin.json` and Claude plugin manifests.

---

## 1. How the marketplace works (verified 2026-07-18)

`awesome-codex-plugins` is both an awesome list and an installable Codex marketplace:

- Your PR adds **one line to their README**. Their CI generator then mirrors your plugin bundle from your repo into `plugins/<owner>/<repo>/` and regenerates `plugins.json` / `marketplace.json`. You never commit bundle files into their repo.
- Listed plugins also appear on the hosted registry at `hol.org/registry/plugins`.
- Users install via `codex plugin marketplace add <repo-url>` or the Codex desktop/IDE settings.

**Hard requirements for listing** (from their `CONTRIBUTING.md`):

| Requirement | Detail |
|---|---|
| `.codex-plugin/plugin.json` | Valid manifest at repo root |
| Scanner score | HOL `plugin-scanner` ≥ **80/130**, **no high/critical findings** |
| Scanner in CI | `hashgraph-online/ai-plugin-scanner-action@v1` running on main + PRs, verified at review |
| `SECURITY.md` | Vulnerability disclosure policy |
| `LICENSE` | MIT or Apache-2.0 recommended (we have MIT ✔) |
| Repo hygiene | No hardcoded secrets, no dangerous MCP commands, SHA-pinned GitHub Actions, lockfiles (✔ `package-lock.json`) |
| PR content | One README line, alphabetical within category, + scanner score or CI-run link |

Scanner score categories (max 130): Manifest 31 · Security 36 · Operational Security 20 · Best Practices 15 · Marketplace 15 · Skill Security 15 · Code Quality 10. See their `SCANNER_GUIDE.md`.

## 2. Design decision: bundle in the monorepo vs. a dedicated plugin repo

The generator mirrors the **whole source repo** as the bundle (trimmed by `.codexignore`), and the scanner scans the repo you submit.

**Decision:** Option A (plugin files at `agent_deck` repo root). Baseline scanner after ignore + compliance artifacts: **100/100**, zero high/critical (2026-07-19). Option B remains the escape hatch only if future scanner/product churn reintroduces uncorrectable high/critical findings on the monorepo surface.

**Option A — plugin files at `agent_deck` repo root** (shipped)
- `+` The awesome-list line links to the product repo: stars, README, docs all compound.
- `+` One repo to version; plugin version can ride `sync-versions.mjs`.
- `−` Scanner runs against a large monorepo — mitigated by `.plugin-scanner.toml` `ignore_paths` (mirrors `.codexignore`). `.codexignore` still trims the *installed* bundle.

**Option B — dedicated `not-so-fat/agent-deck-codex-plugin` repo**
- `+` Tiny scan surface; near-guaranteed clean score; no churn in the product repo.
- `−` List entry points at a thin repo, not the product; second repo to release-manage.

**Decision gate (resolved 2026-07-19):** local `plugin-scanner` 2.0.1015 scores **100/100** with zero high/critical after packaging + ignore_paths → **Option A**. Option B remains an escape hatch if future findings cannot be ignored or fixed in-repo.

Everything below is written for Option A; it transfers to Option B unchanged (the files just live in the thin repo).

## 3. What ships in the bundle

```
agent_deck/
├── .codex-plugin/
│   └── plugin.json          # Codex manifest (new)
├── .codexignore             # trims bundle to plugin files only (new)
├── skills/
│   ├── agent-deck-setup/SKILL.md      # install/start/doctor (new)
│   ├── agent-deck-session/SKILL.md    # bootstrap session, deck status line (new)
│   └── agent-deck-playbooks/SKILL.md  # use playbooks + refine-from-outcomes (new)
├── SECURITY.md              # disclosure policy (new)
└── LICENSE, README.md, package-lock.json   # exist ✔
```

### 3.1 `.codex-plugin/plugin.json`

Modeled on live marketplace entries (e.g. `changelog-forge`):

```json
{
  "name": "agent-deck",
  "version": "1.4.4",
  "description": "Decks of MCP tools, keys, and self-improving playbooks that bind per-workspace.",
  "author": { "name": "not-so-fat", "url": "https://github.com/not-so-fat" },
  "homepage": "https://github.com/not-so-fat/agent-deck",
  "repository": "https://github.com/not-so-fat/agent-deck",
  "license": "MIT",
  "keywords": ["mcp", "playbooks", "agent-context", "codex-plugin"],
  "skills": "./skills/",
  "interface": {
    "displayName": "Agent Deck",
    "shortDescription": "Decks of tools, keys, and self-improving playbooks.",
    "longDescription": "Bind a deck to your workspace and every session starts with the right MCP tools, credentials, and task playbooks — and playbooks learn from your corrections via a review queue.",
    "developerName": "not-so-fat",
    "category": "Productivity",
    "capabilities": ["Read", "Write"],
    "websiteURL": "https://github.com/not-so-fat/agent-deck",
    "privacyPolicyURL": "https://github.com/not-so-fat/agent-deck/blob/main/SECURITY.md",
    "termsOfServiceURL": "https://github.com/not-so-fat/agent-deck/blob/main/LICENSE",
    "defaultPrompt": ["Bind this workspace's deck and show the deck status line."],
    "brandColor": "#0ea5e9",
    "composerIcon": "./assets/icon.svg"
  }
}
```

`mcpServers` must **not** be declared: the plugin ships skills and guidance only, and the connection is plain host MCP config (see 3.3). A plugin-declared server would sit beside the per-folder entry as a second deck-less server instead of being replaced by it. Prefer `Read`/`Write` capabilities over `Interactive` unless you also ship an `.app.json` connector.

Version: add `.codex-plugin/plugin.json` to `scripts/sync-versions.mjs` so it tracks the package version.

### 3.2 Skills — thin trigger stubs, per the deck philosophy

Playbook bodies live on the deck; the plugin ships only generic protocol stubs (same rule as `.cursor/skills/` stubs — pointers, never mirrored content). This also helps Skill Security scoring: no fat prompt bodies, no elevated steps.

- **`agent-deck-setup`** — triggers: "set up agent deck", "agent deck not connected". Body: diagnose daemon health, host transport, folder assignment, and Codex instruction discovery separately. If agent-deck is missing, guide `npx @agent-deck/cli@latest install`; if outdated, `agent-deck upgrade`; if the daemon is down, `agent-deck start --daemon`. Codex connects over pure MCP (streamable HTTP): a global headerless fallback entry plus a per-folder entry carrying the workspace header — no `agent-deck` executable lookup. `agent-deck setup --client codex` writes the global fallback and marker-merges bootstrap guidance into global `~/.codex/AGENTS.md` (or project `./AGENTS.md`) without replacing other instructions; it does not install the plugin (skills). When the host shows no tools: trust the folder, approve the project entry, repair a missing or legacy folder assignment with `agent-deck use <deck>`, then reload MCP / retry. Read-only checks only; the *user* runs install commands.
- **`agent-deck-session`** — triggers: session start when Agent Deck MCP is configured. Body: bootstrap is fail-closed for both launch-selected sessions and optional `.agent-deck/use.json` assignments — require `get_session_binding` → `get_bound_deck`, print the one-line `display_summary`, load every matching playbook, and stop before task work if the tools or selected deck are unavailable. Once per session.
- **`agent-deck-playbooks`** — triggers: task matches a bound-deck playbook / user corrects playbook-derived output. Body: check `triggers` on `get_bound_deck`, `get_playbook` before improvising; on correction, `propose_playbook_patch` (update case) or `kind: "create"` (genesis case) with `evidence.user_feedback_excerpt`.

Skill format is the standard Agent Skills `SKILL.md` (name/description frontmatter) — identical for Codex and Claude Code, so one `skills/` tree serves both (§5).

### 3.3 No bundled connection — host MCP config carries it

The plugin declares no MCP server: no `mcpServers` key in the manifest, no `.mcp.json` in the bundle. The connection is plain host MCP config — pure MCP with no `agent-deck` executable lookup, so desktop-launched hosts (minimal `PATH`) connect:

- `agent-deck setup --client codex|claude` writes the **global headerless fallback** (`http://127.0.0.1:1110/mcp`, no headers — `~/.codex/config.toml`, `~/.claude.json`). Folders with no assignment connect through this entry and land in the explain-only unassigned session.
- `agent-deck use <deck>` writes a same-name **per-folder entry** carrying the workspace header (`.codex/config.toml`, `.mcp.json`); it shadows the fallback where an assignment exists, and the daemon resolves the deck from `.agent-deck/use.json`.

When the host shows no tools, first run `agent-deck start --daemon` and `agent-deck setup --client codex|claude` (with the plugin installed), then: trust the folder, approve the project entry, run `agent-deck use <deck>`, then reload MCP.

Two constraints shape this:

1. **The daemon must already be running** — the HTTP entry cannot start it on demand — hence the `agent-deck-setup` skill as the recovery path. A refused connection at the entry means the entry is present but the daemon is down (`agent-deck start --daemon`).
2. **Dev-on-3001 stays in Cursor-local `.cursor/mcp.json`** — never commit a dev-port override where release config could pick it up.

### 3.4 `.codexignore`

Trim the installed bundle to plugin files only:

```
apps/
packages/
node_modules/
venv/
logs/
misc/
scripts/
docs/
*.log
turbo.json
tsconfig.json
server.json
```

(Keep: `.codex-plugin/`, `skills/`, `README.md`, `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, `assets/`.)

## 4. Compliance work

- **`SECURITY.md`** — supported versions, private disclosure contact (GitHub Security Advisories), response SLA, scope note that the daemon binds to `127.0.0.1` only and keys are stored locally. The key-vault story is a genuine differentiator here — say it plainly.
- **SHA-pin actions** — audit `.github/workflows/ci.yml`: every `uses:` pinned to a full commit SHA (scanner checks this).
- **Scanner workflow** — add `.github/workflows/hol-plugin-scanner.yml` exactly per their `CONTRIBUTING.md` (checkout pinned to `11bd71901bbe5b1630ceea73d27597364c9af683`, `min_score: 80`, `fail_on_severity: high`, SARIF upload). Must be green on `main` before submitting; the PR includes the run URL.
- **Local preflight** (also the Step 0 spike):

  ```bash
  pipx install --force "plugin-scanner==2.0.1015"   # pinned wheel; SHA256 in their CONTRIBUTING.md
  plugin-scanner scan . --format text
  plugin-scanner lint . && plugin-scanner verify .
  ```

## 5. Cross-platform: Claude Code and Cursor

- **Claude Code**: add `.claude-plugin/plugin.json` (+ optional `.claude-plugin/marketplace.json` so the repo is directly addable via `/plugin marketplace add not-so-fat/agent-deck`), referencing the **same** `skills/` and likewise declaring no MCP server. Near-zero marginal cost, and it makes "works across Codex, Claude Code, and Cursor" literally true at install level.
- **Cursor**: already served by `agent-deck setup --client cursor` (stub generation). No new artifact; the README line and registry copy just mention it.

## 6. Implementation plan

| # | Step | Acceptance |
|---|---|---|
| 0 | **Scanner spike** on monorepo baseline | Score + findings list in hand → Option A/B decision |
| 1 | `SECURITY.md` | Exists, linked from README |
| 2 | `.codex-plugin/plugin.json` + `assets/icon.svg` | `plugin-scanner lint .` manifest checks pass |
| 3 | `skills/` (3 stubs) | Bodies < ~30 lines each; no playbook content; no elevated steps |
| 4 | `.codexignore`; no `.mcp.json` in the bundle (§3.3) | Bundle lists only plugin files; connection is host MCP config |
| 5 | Fix scanner findings | `scan .` ≥ 80, zero high/critical |
| 6 | Scanner CI workflow; SHA-pin audit of `ci.yml` | Green run on `main` |
| 7 | `.claude-plugin/` manifests | Installable via Claude Code plugin marketplace |
| 8 | Sync versions script covers plugin.json | `npm run version:sync` updates it |
| 9 | Fork + PR to awesome-codex-plugins | See below |

**The submission line** (Community Plugins → *Development & Workflow*, alphabetical — lands between "Aegis" and "Agent Guard"):

```markdown
- [Agent Deck](https://github.com/not-so-fat/agent-deck) - Decks of MCP tools, keys, and self-improving playbooks that bind per-workspace, for Codex, Claude Code, and Cursor.
```

PR description: scanner score output + link to the passing CI run on `main`. Do **not** include `plugins/`, `plugins.json`, or `marketplace.json` — their generator owns those.

## 7. Risks & open questions

- **Scanner vs. monorepo** — mitigated for Option A via `.plugin-scanner.toml` `ignore_paths`; re-check after large product-code adds that live outside ignore patterns.
- **HTTP-only MCP** — install UX depends on the daemon running; the setup skill mitigates. HTTP-only is the design (NOT-566): Codex re-initializes natively per the spec, so no stdio entrypoint is planned.
- **Registry metadata** — `interface.category` values in the wild include "Productivity"; no published enum found. Copy whatever the reviewer requests.
- **"Claim Your Plugin" / Trust Scores** — the list has a claim flow and trust scoring; after merge, claim the entry so we control the registry listing.
