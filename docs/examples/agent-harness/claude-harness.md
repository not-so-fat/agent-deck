<!-- Merged into ~/.claude/CLAUDE.md by `agent-deck setup` (between agent-deck:harness markers) -->

## Agent Deck

**Connect first:** Connection has three layers: host transport, folder assignment, then session bootstrap. Cursor / Claude users configure transport with `agent-deck setup --client cursor|claude --start`, then restart the host. Codex transport comes from the enabled Agent Deck plugin's bundled `.mcp.json`, which launches `agent-deck mcp-launch`; `agent-deck setup --client codex` installs or refreshes this AGENTS.md guidance but does not install the plugin. Run `agent-deck use <deck>` in an IDE folder when its assignment is missing or legacy, then reload or retry MCP. Claude Code: `claude mcp list` should show agent-deck as Connected when the backend is running.

**Agent Deck hard gate:** When Agent Deck MCP is configured for the current session, or `.agent-deck/use.json` indicates that it is expected, bootstrap is mandatory. This includes launch-selected sessions that deliberately have no assignment file. Before reading repo files, running task commands, or answering the task, require `get_session_binding` and `get_bound_deck` to succeed. If the tools are unavailable, disconnected, return `GRANT_REQUIRED`, or otherwise fail, stop and report the connection problem — do not improvise without the deck. Checking for the optional assignment signal, checking whether Agent Deck is configured, and other read-only connection diagnostics are allowed before the gate passes.

**Session opener (first turn only):** These calls verify an existing connection; they do not create it. The folder's deck comes from `.agent-deck/use.json`, which `agent-deck use <deck>` writes — the connection carries it; the agent does **not** pick a deck and must **not** call `get_decks`. When Agent Deck MCP is configured for the session, call `get_session_binding` then `get_bound_deck`, and tell the user **exactly one line** using `display_summary` (e.g. `◆ dev · 2 MCP · 0 keys · 1 playbooks`). Match the task against the returned playbook triggers and call `get_playbook` for every match before taking task action. If tools are unavailable, repair the host transport first. On `GRANT_REQUIRED` ("No deck selected for this connection"), tell the user to run `agent-deck use <deck>` in the folder and reload MCP, then stop. For an unattended session, fix `x-agent-deck-deck-id` / the launch config instead. If `.agent-deck/use.json` already assigns the deck and only the project MCP pin is missing, that `use` can succeed from a host agent sandbox; creating a new assignment or refreshing stubs needs an unsandboxed terminal (home store write). Do **not** repeat the status line every turn unless the user asks or the bind changes.

**Later turns:** Deck scope comes from the launch-selected connection (folder assignment or launch header). Do not re-bind unless the user asks for deck administration. Changing a folder's deck needs the user's dashboard approval (admin elevation) and only works where the folder has an assignment file; otherwise the agent gets `DECK_FIXED` or `ADMIN_REQUIRED` and should tell the user instead of retrying.

Before declining for missing tools (Slack, Linear, GitHub, etc.), use agent-deck MCP: `get_bound_deck`, `call_service_tool`. Don't hardcode deck IDs.

**Deck admin (create/switch/edit deck):** Normal agents get `ADMIN_REQUIRED`. Call `request_admin_elevation`; user approves in the dashboard/menubar. After approval, `mode` is `agent-admin` until lease expiry or `exit_admin_mode`. Surface shared-deck workspace counts before mutating a deck used elsewhere. Changing the folder assignment still requires that file to exist (`DECK_FIXED` when it does not).

Deck playbooks are task recipes — thin trigger stubs from `agent-deck use` plus `get_bound_deck` / `get_playbook`. **Never** mirror playbook bodies into `.cursor/skills/`, rules, or Claude skills — one source of truth on the deck; stubs are pointers only.

### When user asks for a playbook task

1. `get_playbook(pb_x)` before improvising (`get_bound_deck` triggers point you here).
2. Follow the playbook body; use `call_service_tool` for deck MCPs.

### Playbooks — refine from outcomes (self-improvement)

**When the user corrects your output** (the write trigger — no need to have called `get_playbook` earlier in the session):

**Update case** (a playbook covered this task): fix the output, then `get_playbook` and read `openPatches`. If an open proposal addresses the **same** lesson, pass its `id`(s) in `supersedes` and fold into one better `propose_playbook_patch` (do not file a sibling). If open patches are different problems, omit `supersedes`. Prefer one `add_item` to Gotchas/Checklist; include `evidence.user_feedback_excerpt` as a short verbatim quote of the correction.

**Genesis case** (no playbook covered the task): before ending, `propose_playbook_patch { kind: "create", new_playbook: { title, triggers, body with one gotcha } }` — a few lines is the right size.

**Defer when unsure** (`kind: "signal_only"`): if the correction is plausible but not yet clearly generalizable (edge case, one-off, or needs sibling corrections before the lesson is clear), call `propose_playbook_patch { kind: "signal_only", evidence, rationale }` — logs the signal with no patch proposal. Prefer immediate `update`/`create` when the lesson is clear.

**Curate from a pasted dashboard prompt:** when the user pastes a curation prompt from the Feedback table (`/feedback-signals` → Copy for agent; Markdown + YAML list, each row leads with `id`), group the signals, then `propose_playbook_patch` with consolidated ops and `signal_ids` of every consumed id. That links rows (still open) until the patch is accepted. Do not invent a list-feedback MCP tool — browse/discard is dashboard-only.

**Explicit user-directed playbook edits** ("fix the playbook to say X"): direct `update_playbook` is dashboard-only — use `propose_playbook_patch` with `rewrite_body` unless they will apply the edit in the dashboard themselves.

Tell the user in one line that a proposal was filed (or a signal was logged for later dashboard curation); review happens in the dashboard.

**How to shape proposals:** generalize project-specific names but keep concrete gotchas; place lessons in Checklist/Gotchas; use `rewrite_body` only when structure cannot absorb the lesson.

**propose_playbook_patch ops:**

| Situation | Op | Notes |
|-----------|-----|-------|
| New gotcha or checklist item | `add_item` | `section`: ## heading; `text`: bullet (leading `-` optional) |
| Replace one list line | `amend_item` | `anchor`: exact line including `-` prefix — **not prose** |
| Delete one list line | `remove_item` | Same anchor rules as amend |
| Edit prose or a whole section | `rewrite_body` | Not amend_item on paragraphs |
| Change trigger phrases | `set_triggers` | Then user runs `agent-deck use <deck>` to refresh stubs |

Wrong: `amend_item` with a prose sentence as anchor → **409** at propose. Right: `rewrite_body` for prose edits.
