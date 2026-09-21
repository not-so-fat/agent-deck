# Monorepo scope (session binding)

> **Switching contract:** agent-initiated `switch_bound_deck` switching below is **superseded by** [Session/default deck-switching redesign](./superpowers/specs/2026-09-20-session-deck-switching-redesign.md) (NOT-204). Agents may only request a switch; a human approves it as This session only or This workspace by default.

**Status:** As-built — session-only binding (no repo `deck.yaml`).

## One workspace path, many decks

Agent Deck scopes **per MCP session**, not per git root file. Multiple agents can open the same monorepo path and bind **different** decks:

```
  Agent A  →  bind_workspace({ workspaceRoot: "/repo", deckId: "web-stack" })
  Agent B  →  bind_workspace({ workspaceRoot: "/repo", deckId: "api-stack" })
```

Call `switch_deck` to request a deck change mid-session — the user approves it as This session only or This workspace by default; the active deck is unchanged until approval and no reload is needed.

## Choosing a deck

1. Dashboard **My Decks** → copy icon copies the deck **UUID**
2. MCP `get_decks` lists available decks
3. `bind_workspace({ workspaceRoot, deckId })` on session start (see [agent harness](./AGENT_HARNESS.md))

## What workspace root is for

`workspaceRoot` groups live display (status line, menu bar, dashboard session chips) and helps agents know which project they are in. It does **not** auto-select a deck.

## Legacy note

Earlier versions used `.agent-deck/deck.yaml` at the repo root. That manifest is **removed** — delete any leftover files; they are ignored.
