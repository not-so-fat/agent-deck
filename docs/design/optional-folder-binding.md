# Design note — Folder binding is optional; the connection always works

**Status:** Accepted direction (2026-11-13). Not yet implemented; implementation is tracked in Linear tickets filed after this note merged.
**Related:** `docs/decisions/cursor-mcp-config-resolution.md`, `docs/SETUP.md` (pure-MCP connection), NOT-50 (explain-only session), NOT-597 (approve assignment from the unassigned session)

## Problem

Folder binding exists for UX: the right deck follows the folder. In practice it is the most fragile part of the connection. For Cursor, a chat reaches a deck only if all of these hold:

1. `.agent-deck/use.json` exists in the folder.
2. `.cursor/mcp.json` exists in the folder with an `x-agent-deck-workspace` header (Cursor sends no folder information on its own).
3. The user approved that project server in Cursor, once per folder.
4. The folder is opened as the first root (Cursor often does not load project MCP for other roots).

If any one is missing, the chat lands in the explain-only unassigned session and every task tool fails with `GRANT_REQUIRED`. A convenience feature can therefore take down the whole connection. Observed on 2026-11-13: a legacy launcher entry in one folder, and a missing pin in another. `doctor` reported "Issues: none" for the second.

## Principle

The connection must always work. Folder binding refines the deck choice; it must never be required for a deck to be reachable.

## Proposal

1. **Default deck for headerless sessions.** A session with no workspace header (the global fallback entry alone) binds to the user's default deck instead of the explain-only session. The user chooses the default; it is not guessed by the agent.
2. **Folder pin is optional.** `agent-deck use <deck>` still writes `.agent-deck/use.json` and the per-folder entry for folders that need a different deck. A missing or unapproved pin falls back to the default deck.
3. **The session receipt is the safety net.** The first-turn `display_summary` line already names the deck and the `session (default …)` suffix, so a wrong deck is visible on the first turn. Add a source marker (for example `default deck, no folder pin`) so a silent fallback is distinguishable from a pinned folder.
4. **`doctor` reports the real state.** Per host and folder: `pinned`, `using default deck (no folder pin)`, `pin present, not approved`, `assignment present, pin missing`. Each with one repair command.
5. **`agent-deck use --repair-all`.** Writes missing pins for every folder that has a `use.json`. Replaces finding broken folders one at a time.

## Keeps unchanged

- Only the user changes the deck; `switch_deck` still needs human approval.
- A folder with an explicit assignment keeps it. The default deck applies only when no workspace is identified.
- Remote and grant-bound sessions keep their grants; this note covers local MCP sessions only.

## Open questions

- Does a user-level default deck already exist as a setting, or does it need adding? (Today the default is per workspace.)
- Should an assigned folder whose pin is broken warn loudly (receipt marker plus `doctor`) or block until repaired? This note recommends warn, because blocking is the behaviour being removed.
- How does NOT-597 (approve an assignment from the explain-only session) interact? If the unassigned session stops being the common landing place, NOT-597 mostly serves no-default setups.

## Not in scope

Changing Cursor's per-project server approval. That is host behaviour; Agent Deck can only detect it (`~/.cursor/projects/<slug>/mcp-approvals.json`) and say so.
