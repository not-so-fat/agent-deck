# Design note — One default deck, no folder pins needed

**Status:** Accepted direction (2026-11-13), revised the same day to the simplest mechanism. Not yet implemented; work is tracked in Linear (NOT-598, NOT-600, NOT-601, NOT-602, NOT-603).
**Related:** `docs/decisions/cursor-mcp-config-resolution.md`, `docs/SETUP.md` (pure-MCP connection), `docs/superpowers/specs/2026-09-20-session-deck-switching-redesign.md`

## Problem

Folder binding exists for UX: the right deck follows the folder. In practice it is the most fragile part of the connection. For Cursor, a chat reaches a deck only if all of these hold:

1. `.agent-deck/use.json` exists in the folder.
2. `.cursor/mcp.json` exists in the folder with an `x-agent-deck-workspace` header (Cursor sends no folder information on its own).
3. The user enabled that project server in Cursor Settings (Cursor shows no prompt).
4. The folder is opened as the first root (Cursor often does not load project MCP for other roots).

If any one is missing, the chat lands in the explain-only unassigned session and every task tool fails with `GRANT_REQUIRED`. Observed on 2026-11-13: a legacy launcher entry in one folder, a missing pin in another, and `doctor` reporting "Issues: none" for the second.

## Principle

The connection must always work, with nothing to write or approve per folder.

## Mechanism (the simplest one)

1. The **global headerless entry** (`~/.cursor/mcp.json` and the equivalents for other hosts, written by `agent-deck setup`) is the whole connection.
2. A session with no deck header binds to the **user's default deck**.
3. To use another deck, the user approves the existing `switch_deck` request (this session only, or as the new default). Nothing else changes the deck.
4. The first-turn receipt line says when the deck came from the default (`default deck, no folder pin`), so a wrong deck is visible on turn one.

That is all. There is no per-folder file to write, no per-project approval, no repair command and no pin-specific `doctor` states.

## What happens to existing folder pins

- **Phase 1 (this work):** existing `use.json` assignments and per-folder entries keep working and keep precedence, so nothing already set up breaks. Docs, setup output and agent text stop recommending `agent-deck use` as a connection step. No new pin tooling is built.
- **Phase 2 (decided on evidence):** run the default-deck mechanism for a while, then decide whether to remove pin writing and approval handling entirely. The decision depends on whether per-folder decks turn out to be needed in daily use.

## Precedence

Launch deck header, then folder assignment (an existing `use.json`), then default deck. The investigation ticket confirms this and settles storage and the set/clear surface.

## Keeps unchanged

- Only the user changes the deck; `switch_deck` still needs human approval.
- Remote and grant-bound sessions keep their grants; this note covers local MCP sessions only.
- A launch-selected deck (unattended workers) is untouched.

## Open questions

- Where the default deck is stored and how it is set (the investigation ticket, NOT-598).
- Whether "this workspace by default" in `switch_deck` should keep writing a folder assignment in phase 1, or write the default deck instead.
- How the explain-only session and its approval flow (shipped for unassigned folders) behave once most sessions are bound to the default deck.

## Not in scope

- Cursor's per-project server approval. That is host behaviour; it only matters while a project entry exists.
- A `use --repair-all` command and pin-specific `doctor` states. They only repair or diagnose pins, which this design stops requiring.
