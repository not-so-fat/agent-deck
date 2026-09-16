---
name: agent-deck-session
description: Use at session start in a deck-bound workspace, or when the user asks for the deck status line / which deck is active.
---

# Agent Deck session opener

When `.agent-deck/use.json` exists, this opener is a hard gate. Complete it before reading
repository files, running task commands, or answering the task. Once per conversation (or
after bind changes):

1. `get_session_binding`
2. `get_bound_deck`
3. Print **exactly one** line from `display_summary` (e.g. `◆ dev · 2 MCP · 0 keys · 1 playbooks`)
4. Match the task against the returned playbook triggers. For every match, use the
   `agent-deck-playbooks` skill and call `get_playbook` before taking task action.

If the Agent Deck tools are unavailable, disconnected, return `GRANT_REQUIRED`, or either
required call fails, stop and report the connection problem. Do not inspect the repository,
improvise from memory, or silently fall back to another route. Before the gate passes, only
read-only diagnostics needed to restore Agent Deck are allowed.

Do not repeat the status line every turn unless the user asks or the bind changes.
