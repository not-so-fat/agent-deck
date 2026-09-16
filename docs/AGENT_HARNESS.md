# Agent harness (AGENTS.md, CLAUDE.md & Cursor rules)

**Audience:** Agent Deck users on Codex, Claude Code, or Cursor
**Status:** Installed automatically by `agent-deck setup`  
**Related:** [PLAYBOOKS_AND_SKILLS.md](./PLAYBOOKS_AND_SKILLS.md), [examples/agent-harness/](./examples/agent-harness/)

Agent Deck exposes **tools** (MCP). Your agent’s **control plane** (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`) teaches *how* to use them. Setup treats the harness as a **required install step** alongside host MCP configuration where applicable. For Codex, the plugin owns MCP transport and setup only merges the harness. Agent Deck can run without the harness, but the intended workflow always installs it.

---

## What `setup` installs

| Client | Scope | File |
|--------|-------|------|
| **Codex** | global (default) | `~/.codex/AGENTS.md` (merged between `agent-deck:harness` markers; honors `CODEX_HOME`) |
| **Codex** | project | `./AGENTS.md` (same merge) |
| **Cursor** | global (default) | `~/.cursor/rules/agent-deck.mdc` |
| **Cursor** | project | `.cursor/rules/agent-deck.mdc` |
| **Claude Code** | global | `~/.claude/CLAUDE.md` (merged between `agent-deck:harness` markers) |
| **Claude Code** | project | `./CLAUDE.md` (same merge) |
| **Claude Desktop** | — | MCP only; use Claude Code/Cursor harness if you use those too |

```bash
npx @agent-deck/cli setup --client codex     # AGENTS.md harness; plugin owns MCP transport
npx @agent-deck/cli setup --client codex --scope project
npx @agent-deck/cli setup --client cursor    # MCP + global harness
npx @agent-deck/cli setup --client claude   # MCP + harness + status line (default)
npx @agent-deck/cli setup --client claude --no-statusline   # skip prompt footer
npx @agent-deck/cli setup --client cursor --scope project   # project MCP + project harness
```

**Order of operations:** when Agent Deck MCP is configured for the current session, or `.agent-deck/use.json` indicates that it is expected, it is a hard gate. The optional file is only one signal; launch-selected sessions with no assignment file are covered too. On the **first turn**, the harness requires `get_session_binding` and `get_bound_deck` before repo inspection or task action, shows `display_summary`, then loads every playbook whose trigger matches the task. If bootstrap fails, the agent stops instead of improvising without the deck. Checking for the assignment signal, checking configuration, and other read-only connection diagnostics is allowed before the gate passes. Terminal **status line** shows the bound deck after the MCP session registers its live display.

**Manual status line (merge into existing settings — do not paste terminal output):**

```json
"statusLine": {
  "type": "command",
  "command": "/Users/you/.agent-deck/bin/statusline.sh",
  "padding": 2
}
```

Refreshes on **prompt / conversation update** only (no `refreshInterval` timer). Bound lines include `(updated YYYY-MM-DD HH:mm)` from the last bind.

Prefer `agent-deck setup --client claude` (writes the script + merges JSON). Do **not** put `npx ...` directly in `command` — npm color codes can corrupt `settings.json` if copied from terminal output.

Re-running `setup` **updates** the harness in place (idempotent).

**Stale MCP tool list in Cursor:** Cursor caches tool descriptors per MCP server name. After upgrading Agent Deck, restart Cursor (or toggle MCP off/on in Settings) so removed tools like `setup_repo_deck` disappear. If you use both `agent-deck` (`:1110`) and `agent-deck-dev` (`:3001`), refresh **both** — a stopped or old dev server can leave ghost tools visible.

### Safety — we do not replace your other rules or skills

| What | Behavior |
|------|----------|
| **Other Cursor rules** (`~/.cursor/rules/*.mdc`) | **Never read or written** — only `agent-deck.mdc` |
| **Cursor skills** (`.cursor/skills/`, `~/.cursor/skills/`) | **Never touched** |
| **Claude `CLAUDE.md`** | **Merge only** — appends an `agent-deck:harness` block, or replaces **only** that block on re-setup; your other sections stay |
| **Codex `AGENTS.md`** | **Merge only** — global or project file; content outside `agent-deck:harness` markers stays untouched |
| **`agent-deck.mdc`** | Merge like CLAUDE.md — custom frontmatter and notes outside the harness markers are kept |

Add your own notes above/below the harness markers in `agent-deck.mdc`, or anywhere in `CLAUDE.md` outside the markers.

---

## Re-running `setup` or upgrading

| Action | MCP config | Harness | Your other rules / CLAUDE.md |
|--------|------------|---------|------------------------------|
| **`setup` again (same version)** | Re-merges `mcpServers.agent-deck` only; other MCP entries kept | **No-op** if template unchanged (`already current`); otherwise updates **only** the marked harness block | Untouched |
| **`setup` after editing harness by hand** | Same as above | Re-run **overwrites** text between `agent-deck:harness` markers with the stock template; your notes **outside** markers stay | Untouched |
| **`agent-deck upgrade`** | **Not run** — only replaces the global npm CLI package | **Not run** — run `setup` again if a release ships new harness wording | Untouched |
| **`npx @agent-deck/cli@latest setup`** | Updates `agent-deck` URL if host/port changed | Refreshes harness if the new CLI ships updated template text | Untouched |

**Data:** decks, collection, and credentials in `~/.agent-deck/` are separate from setup; upgrade does not reset them.

**Claude Code:** if `claude mcp add` succeeds, MCP is registered via the CLI as the stdio `agent-deck mcp-launch` bridge (second run is usually harmless). If the CLI fails, setup falls back to merging the same launcher into `~/.claude.json` or project `.mcp.json`.

---

## Harness content

Three behaviors in one rule block (templates stay generic — no project-specific examples):

0. **Fail-closed bootstrap** — when Agent Deck MCP is configured for the session or the optional assignment file indicates it is expected, require `get_session_binding` → `get_bound_deck` before any task work; load matching playbooks and stop on connection or deck-selection failure. This also covers launch-selected sessions without `.agent-deck/use.json`.
1. **Capability rescue** — use agent-deck before declining tool requests (`get_bound_deck`, `call_service_tool`).
2. **Playbooks as source of truth** — `get_bound_deck` playbook `triggers`, then `get_playbook`; don’t mirror into `.cursor/skills/`.
3. **Self-improvement loop** — applies when the user gives feedback on output you produced **after** `get_playbook` + following that playbook this session (identify from session trace, not title or artifact type). Default actions:
   1. Fix the current output.
   2. `update_playbook` on that playbook so the next run avoids the same mistake.
   Update principles:
   - Generalize lessons (drop project-specific names, paths, schemas)
   - Place correctly: checklist for verification, technique for patterns, anti-pattern for mistakes
   - Restructure the playbook if the structure can’t absorb the lesson cleanly
   - Surface what changed so the user can audit drift

**Project scope** documents the optional persistent folder assignment via `agent-deck use <deck>`; launch-selected sessions need no assignment file. Match playbook `triggers` on `get_bound_deck` before improvising.

**After upgrading** (repo-deck removal, MCP tool rename): re-run `setup` so the marked harness block in `~/.cursor/rules/agent-deck.mdc` or `CLAUDE.md` picks up current tool names (`get_bound_deck`, not `list_playbooks` / `list_bound_deck_services`). Editing the repo’s `packages/cli/src/agent-harness.ts` alone does not change already-installed global rules until `setup` runs again. Also **restart the host** so MCP tool cache drops removed names. Update any **deck playbooks** that still mention old tools — see [CHANGELOG](../CHANGELOG.md) migration table.

Templates: [cursor-agent-deck.mdc](./examples/agent-harness/cursor-agent-deck.mdc), [claude-harness.md](./examples/agent-harness/claude-harness.md).

---

## Manual edit / audit

- **Cursor:** edit `agent-deck.mdc`; `description` in frontmatter is what the rule picker shows (like a skill one-liner).  
- **Claude:** edit the `## Agent Deck` section between `<!-- agent-deck:harness:start/end -->` markers so `setup` can refresh without clobbering your other CLAUDE.md notes.  
- **Customize:** edit the file after setup; re-run `setup` only when you want the stock template refreshed.

---

## What Agent Deck does *not* do

- **No harness over MCP** — `bind_workspace` does not replace CLAUDE.md or Cursor rules.  
- **No auto-sync to skills** — playbooks stay on the deck; the harness points the agent at MCP.
