---
name: agent-deck-session
description: Use at session start when Agent Deck MCP is configured or expected, including launch-selected sessions, or when the user asks for the deck status line / which deck is active.
---

# Agent Deck session opener

When Agent Deck MCP is configured for the current session, or `.agent-deck/use.json` indicates
that it is expected, this opener is a hard gate. The file is only one optional signal; the
gate also includes launch-selected sessions that deliberately have no assignment file.
Complete the opener before reading repository files, running task commands, or answering the
task. Once per conversation (or after the selected deck changes):

1. `get_session_binding`
2. `get_bound_deck`
3. Print **exactly one** line from `display_summary` (e.g. `◆ dev · 2 MCP · 0 keys · 1 playbooks`)
4. Match the task against the returned playbook triggers. For every match, use the
   `agent-deck-playbooks` skill and call `get_playbook` before taking task action.

If the Agent Deck tools are unavailable, disconnected, return `GRANT_REQUIRED`, or either
required call fails, stop and report the connection problem. Do not inspect the repository,
improvise from memory, or silently fall back to another route. Before the gate passes,
checking for the optional assignment signal, checking whether Agent Deck is configured, and
other read-only diagnostics needed to restore the connection are allowed.

Give the operator a concrete recovery: use `agent-deck use <deck>` for an IDE folder
assignment, or fix `x-agent-deck-deck-id` / the launch configuration for an unattended
session.

Do not repeat the status line every turn unless the user asks or the bind changes.
