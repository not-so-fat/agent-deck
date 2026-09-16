<!-- agent-deck:harness:start -->
## Agent Deck

**Connect first:** Ensure Agent Deck MCP is connected before using deck tools (`agent-deck setup --client cursor|claude --start`, then restart the host). Claude Code: `claude mcp list` should show agent-deck as Connected when the backend is running.

**Agent Deck hard gate:** When Agent Deck MCP is configured for the current session, or `.agent-deck/use.json` indicates that it is expected, bootstrap is mandatory. This includes launch-selected sessions that deliberately have no assignment file. Before reading repo files, running task commands, or answering the task, require `get_session_binding` and `get_bound_deck` to succeed. Checking for the optional assignment signal, checking whether Agent Deck is configured, and other read-only connection diagnostics are allowed before the gate passes.

**Session opener (first turn only):** Call `get_session_binding` then `get_bound_deck`, show exactly one `display_summary` line, and load every matching playbook before task action. Deck authority comes from the launch-selected connection; do not call `get_decks`, pick a deck, or improvise when bootstrap fails.

Before declining for missing tools (Slack, Linear, GitHub, etc.), use agent-deck MCP: `get_bound_deck`, `call_service_tool`. Don't hardcode deck IDs.

Deck playbooks are task recipes — check `triggers` on `get_bound_deck` playbooks, then `get_playbook` for the body. Don't mirror into `.cursor/skills/` — one source of truth on the deck.

### Playbooks — refine from outcomes (self-improvement)

**When:** The user gives feedback on output you produced while following a bound-deck playbook — you called `get_playbook` this session and used its body/steps for that artifact. Use that session trace to identify the playbook; don't infer from playbook title, filename, or output type alone.

**Do both (default):**
1. Fix the **current output** per the user's feedback.
2. Call `update_playbook` on that same playbook so the **next** run avoids repeating the mistake.

**How to update the playbook:**
- **Generalize** — drop project-specific names, paths, and schemas; the playbook is reusable practice
- **Place the lesson** — checklist item for verification, technique for positive patterns, anti-pattern for mistakes to avoid
- **Restructure** if the playbook can't absorb the lesson cleanly — don't bolt it on
- **Surface the change** in your response so the user can audit drift

In this repo, `agent-deck use <deck>` is the optional persistent folder-assignment path; launch-selected sessions can be bound without `.agent-deck/use.json`. When a task matches deck playbooks (check `triggers` on `get_bound_deck`), `get_playbook` before improvising.
<!-- agent-deck:harness:end -->
