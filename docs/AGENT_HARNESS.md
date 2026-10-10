# Agent harness (AGENTS.md, CLAUDE.md, Cursor rules & Muse skills)

**Audience:** Agent Deck users on Codex, Claude Code, Cursor, or Muse
**Status:** Installed automatically by `agent-deck setup`  
**Related:** [PLAYBOOKS_AND_SKILLS.md](./PLAYBOOKS_AND_SKILLS.md), [examples/agent-harness/](./examples/agent-harness/)

> **Switching contract:** deck-switching via admin elevation described here is **superseded by** [Session/default deck-switching redesign](./superpowers/specs/2026-09-20-session-deck-switching-redesign.md) (NOT-204).

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
| **Muse** | global (default) | Native skills under `$XDG_CONFIG_HOME/muse/skills/agent-deck-*/SKILL.md` (fallback `~/.config/muse/skills/`), stamped `<!-- agent-deck:managed-skill -->` |
| **Muse** | project | `./AGENTS.md` (same marker merge; Muse loads root `AGENTS.md` after workspace trust) |
| **Claude Desktop** | — | MCP only; use Claude Code/Cursor harness if you use those too |

```bash
npx @agent-deck/cli setup --client codex     # AGENTS.md harness; plugin owns MCP transport
npx @agent-deck/cli setup --client codex --scope project
npx @agent-deck/cli setup --client cursor    # MCP + global harness
npx @agent-deck/cli setup --client claude   # MCP + harness + status line (default)
npx @agent-deck/cli setup --client claude --no-statusline   # skip prompt footer
npx @agent-deck/cli setup --client cursor --scope project   # project MCP + project harness
npx @agent-deck/cli setup --client muse     # MCP + native bootstrap skills (no status line, no plugin install)
npx @agent-deck/cli setup --client muse --scope project   # project MCP + root AGENTS.md merge
```

**Muse flow:** `agent-deck setup --client muse` writes the MCP transport plus the three canonical bootstrap skills (`agent-deck-session`, `agent-deck-playbooks`, `agent-deck-setup`) from the CLI release artifact. Optional per repo: `agent-deck use <deck> --client muse` writes `.mcp.json` + `.agent-deck/use.json`, and `agent-deck setup --client muse --scope project` merges the full harness into root `AGENTS.md`. Trust the workspace so Muse loads `AGENTS.md`, then **start a new Muse process** (restart Muse) so MCP + skills reload. Verify with `/mcp` — `agent-deck` should appear. First turn: the agent calls `get_session_context` once and shows exactly one verbatim `display_summary` line. There is no Muse status line or plugin install — the transcript receipt is the binding record.

**Order of operations:** when Agent Deck MCP is configured for the current session, or `.agent-deck/use.json` indicates that it is expected, it is a hard gate. The folder's deck comes from that assignment file (written by `agent-deck use <deck>`); the connection carries it — the agent does not pick a deck. Launch-selected sessions with no assignment file are covered too. On the **first turn**, the harness requires one `get_session_context` call before repo inspection or task action, shows **exactly one transcript line** rendering `display_summary` verbatim, then loads every playbook whose trigger matches the task.

**Session receipt (canonical binding UX):** that first-turn `display_summary` line is the authoritative binding record for the session. `display_summary` is the one source string — the agent never reconstructs the deck name, counts, badge, or the `session (default …)` override suffix, and prints the suffix exactly as returned when the session deck differs from the workspace default. The receipt is not repeated on later turns while the binding is unchanged; a confirmed binding change allows exactly one new receipt. Terminal **status lines** (Claude/Cursor prompt footers, menu-bar badges) are optional secondary context and never override the transcript receipt — they are workspace-level and cannot be the source of truth when concurrent sessions use different decks. On `GRANT_REQUIRED`, it matches the message before acting: "No deck assigned to this folder…" keeps the run-`agent-deck use <deck>`-and-reload remedy, while "This MCP session has not bound yet…" retries once via `bind_workspace` (or `get_session_binding`) and then `switch_deck`, with no CLI step and no reload. To move to another deck the agent calls `switch_deck` and waits — the user approves it as This session only or This workspace by default; the active deck is unchanged until approval and no reload is needed. Checking for the assignment signal, checking configuration, and other read-only connection diagnostics is allowed before the gate passes. Terminal **status line** shows the bound deck after the MCP session registers its live display.

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

**Diagnosing a missing or stale harness:** `agent-deck status` and `agent-deck doctor` both print a read-only `Agent harness:` section naming each affected client/file and the exact repair command (`agent-deck setup --client cursor|claude|codex|muse`). Muse is current only when all three managed skills are present and current; a missing or stale skill names its `SKILL.md` path. Without a current harness the agent never learns the first-turn receipt, so repair it and restart the host (Muse: start a new process and re-check `/mcp`).

**Stale MCP tool list in Cursor:** Cursor caches tool descriptors per MCP server name. After upgrading Agent Deck, restart Cursor (or toggle MCP off/on in Settings) so removed tools like `setup_repo_deck` disappear. If you use both `agent-deck` (`:1110`) and `agent-deck-dev` (`:3001`), refresh **both** — a stopped or old dev server can leave ghost tools visible.

### Safety — we do not replace your other rules or skills

| What | Behavior |
|------|----------|
| **Other Cursor rules** (`~/.cursor/rules/*.mdc`) | **Never read or written** — only `agent-deck.mdc` |
| **Cursor skills** (`.cursor/skills/`, `~/.cursor/skills/`) | **Never touched** |
| **Claude `CLAUDE.md`** | **Merge only** — appends an `agent-deck:harness` block, or replaces **only** that block on re-setup; your other sections stay |
| **Codex `AGENTS.md`** | **Merge only** — global or project file; content outside `agent-deck:harness` markers stays untouched |
| **Muse skills** (`muse/skills/agent-deck-*/SKILL.md`) | **Managed only** — create missing, refresh stale managed, leave current unchanged; a same-name user-authored skill (no `agent-deck:managed-skill` stamp) fails setup with its path instead of overwriting |
| **Muse project `AGENTS.md`** | **Merge only** — same markers as Codex; content outside stays untouched; requires workspace trust |
| **`agent-deck.mdc`** | Merge like CLAUDE.md — custom frontmatter and notes outside the harness markers are kept |

Add your own notes above/below the harness markers in `agent-deck.mdc`, or anywhere in `CLAUDE.md`/`AGENTS.md` outside the markers. Never hand-edit between Muse skill stamps — re-run `agent-deck setup --client muse` to refresh.

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

0. **Fail-closed bootstrap** — when Agent Deck MCP is configured for the session or the optional assignment file indicates it is expected, require one `get_session_context` call before any task work; load matching playbooks and stop on connection or `GRANT_REQUIRED`. Do not call `get_decks` or choose a deck. This also covers launch-selected sessions without `.agent-deck/use.json`.
1. **Capability rescue** — use agent-deck before declining tool requests (`get_bound_deck`, `call_service_tool`).
2. **Playbooks as source of truth** — `get_bound_deck` playbook `triggers`, then `get_playbook`; don’t mirror into `.cursor/skills/`.
3. **Self-improvement loop** — applies when the user gives feedback on output you produced **after** `get_playbook` + following that playbook this session (identify from session trace, not title or artifact type). Default actions:
   1. Fix the current output.
   2. Propose a playbook patch (`propose_playbook_patch`) so the next run avoids the same mistake; dashboard review applies it.
   Update principles:
   - Generalize lessons (drop project-specific names, paths, schemas)
   - Place correctly: checklist for verification, technique for patterns, anti-pattern for mistakes
   - Restructure the playbook if the structure can’t absorb the lesson cleanly
   - Surface what changed so the user can audit drift

**Project scope** documents the optional persistent folder assignment via `agent-deck use <deck>`; launch-selected sessions need no assignment file. Match playbook `triggers` on `get_bound_deck` before improvising. Folder deck changes go through `switch_deck` + human approval (This session only or This workspace by default).

**After upgrading** (repo-deck removal, MCP tool rename): re-run `setup` so the marked harness block in `~/.cursor/rules/agent-deck.mdc` or `CLAUDE.md` picks up current tool names (`get_bound_deck`, not `list_playbooks` / `list_bound_deck_services`). Editing the repo’s `packages/cli/src/agent-harness.ts` alone does not change already-installed global rules until `setup` runs again. Also **restart the host** so MCP tool cache drops removed names. Update any **deck playbooks** that still mention old tools — see [CHANGELOG](../CHANGELOG.md) migration table.

Templates: [cursor-agent-deck.mdc](./examples/agent-harness/cursor-agent-deck.mdc), [claude-harness.md](./examples/agent-harness/claude-harness.md).

---

## Deck operating instructions (precedence + hot-switch contract)

`get_session_context` and `get_bound_deck` return the bound deck's exact `operatingInstructions` value. Empty instructions are always the empty string `''` — never null and never omitted. The value is deck-scoped: concurrent sessions bound to different decks each see only their own deck's instructions, and a hot switch never leaks the previous deck's value into the new context.

**First turn:** the bootstrap reads `operatingInstructions` and follows the non-empty instructions for this session's deck only.

**Hot switch:** after a confirmed session-only or workspace-default switch, the agent calls `get_session_context` once before more task work — no MCP reconnect is needed — and follows only the new deck's instructions. The previous deck's instructions stop applying immediately. The consumed `switch_deck` elicitation result carries the same refresh hint (`refresh.tool: get_session_context`).

**Precedence (highest first):** platform safety rules, then developer/user instructions, then authorization boundaries, then deck operating instructions. Deck prose can neither widen access nor enable extra tools; on any conflict the higher-priority instruction wins and the agent reports the conflict instead of complying.

**Two delivery paths:** the MCP initialize response carries the initially assigned deck's non-empty instructions in the server `instructions` field where the SDK/host surfaces it (an unassigned session still receives the existing recovery message; empty instructions omit the field). That value is frozen at connect time and never updates after a hot switch, so `get_session_context` is the authoritative live value on every host. MCP server instructions do not carry system-message priority in every host — the harness treats them as a bootstrap hint only.

### Host smoke checklist (initialize `instructions` vs `get_session_context`)

For each host: bind a deck whose instructions contain a distinctive marker (e.g. `SMOKE-deck-a`), connect, then approve a hot switch to a second deck with a different marker.

1. Connect the host to Agent Deck MCP on deck A. Record whether the host surfaces the server `instructions` value from the initialize response (verbatim marker visible to the agent without any tool call).
2. Call `get_session_context` and confirm `operatingInstructions` contains only the deck-A marker.
3. Request `switch_deck` to deck B and approve it (session-only is enough). Confirm no reconnect was needed.
4. Call `get_session_context` once and confirm `operatingInstructions` contains only the deck-B marker.
5. Confirm a concurrent deck-A session still returns only the deck-A marker.

Status vocabulary: **Verified** (observed on the named host build), **Unsupported** (the host ignores the field), **Unknown** (not run). The `get_session_context` path is host-independent — it is one MCP tool call — and is covered by backend protocol tests on every host.

| Host | Initialize `instructions` surfaced | `get_session_context` authoritative path |
|------|------------------------------------|------------------------------------------|
| Codex | Unknown — smoke not run in this sandbox (no host binary); re-run steps 1–5 on a workstation | Verified via backend protocol tests (`session-context`, initialize-response, switch-deck suites) |
| Claude Code | Unknown — smoke not run in this sandbox (no host binary); re-run steps 1–5 on a workstation | Verified via backend protocol tests (`session-context`, initialize-response, switch-deck suites) |
| Cursor | Unknown — smoke not run in this sandbox (no host binary); re-run steps 1–5 on a workstation | Verified via backend protocol tests (`session-context`, initialize-response, switch-deck suites) |
| Muse Code 1.4.3 | Unknown — the 2026-10-10 release smoke used project `AGENTS.md` for bootstrap and did not isolate initialize `instructions`; run steps 1–5 to classify | Verified live on PR #169 head `b3b49b12`: `/mcp` showed `agent-deck` connected, the first turn called `get_session_context` once, and the exact receipt was emitted once |

No claim is made here about host initialize-instruction behavior until a workstation run records it above.

### Muse release smoke evidence (2026-10-10)

The live operator smoke ran on macOS with Muse Code `1.4.3-R5018.1` against PR #169 head `b3b49b121922e1ddf7a7564a8f97154ca734277e`:

1. Built `@agent-deck/shared`, `@agent-deck/backend`, and `@agent-deck/cli` from that exact head.
2. Ran the built CLI's global `setup --client muse --no-menubar` twice. The first run created all three managed skills; the second reported `Muse skills already current`.
3. Ran `use planner --client muse`, then `setup --client muse --scope project --no-menubar` in the checkout.
4. Started a fresh trusted Muse process. `/mcp` reported server `agent-deck` as `connected` and listed `get_session_context` among its tools.
5. On the first agent turn, Muse loaded the project `AGENTS.md`, called `get_session_context` exactly once, and committed this single-line binding receipt:

```text
◆ planner · 1 MCP · 0 keys · 13 playbooks · ⌘s165
```

The redacted local session export recorded a clean exit, one user turn, the successful tool result, and the exact assistant message above. This proves the release-path exit predicate for Muse transport, native bootstrap guidance, trusted project rules, and the canonical session receipt. It does not classify Muse's separate initialize-`instructions` behavior or the hot-switch matrix in steps 1–5.

---

## Manual edit / audit

- **Cursor:** edit `agent-deck.mdc`; `description` in frontmatter is what the rule picker shows (like a skill one-liner).  
- **Claude:** edit the `## Agent Deck` section between `<!-- agent-deck:harness:start/end -->` markers so `setup` can refresh without clobbering your other CLAUDE.md notes.  
- **Muse:** global skills are managed files — do not hand-edit; project `AGENTS.md` follows the same marker rule as Codex (edits outside the markers survive refresh).  
- **Customize:** edit the file after setup; re-run `setup` only when you want the stock template refreshed.

---

## What Agent Deck does *not* do

- **No harness over MCP** — `bind_workspace` does not replace CLAUDE.md or Cursor rules.  
- **No auto-sync to skills** — playbooks stay on the deck; the harness points the agent at MCP.
