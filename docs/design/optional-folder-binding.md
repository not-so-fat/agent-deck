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

Launch deck header, then folder assignment (an existing `use.json`), then default deck. Confirmed by the investigation ticket (NOT-598); see [Default deck](#default-deck).

## Keeps unchanged

- Only the user changes the deck; `switch_deck` still needs human approval.
- Remote and grant-bound sessions keep their grants; this note covers local MCP sessions only.
- A launch-selected deck (unattended workers) is untouched.

## Open questions

- Where the default deck is stored and how it is set: decided in [Default deck](#default-deck) (the investigation ticket, NOT-598).
- Whether "this workspace by default" in `switch_deck` should keep writing a folder assignment in phase 1, or write the default deck instead: decided in [Default deck](#default-deck), answer 6.
- How the explain-only session and its approval flow (shipped for unassigned folders, NOT-597) behave once most sessions are bound to the default deck: see [Default deck](#default-deck), answer 5.

## Not in scope

- Cursor's per-project server approval. That is host behaviour; it only matters while a project entry exists.
- A `use --repair-all` command and pin-specific `doctor` states. They only repair or diagnose pins, which this design stops requiring.

## Default deck

Decided by NOT-598 (this ticket). Six questions, six answers; each answer cites the repo file that is the evidence.

1. **No user-level default deck setting exists today.** The three lookalikes are not user settings: `defaultDeckId` in `packages/backend/src/mcp-session-binding.ts` comes only from the launch env (constructor `env.deckId`, reported as `deckSource: 'env'`); `default_deck` in `packages/backend/src/auth/client-grants.ts` is a per-remote-grant field applied only to grant sessions (`resolveGrantDeck`); `decks.is_active` / `setActiveDeck` in `packages/backend/src/models/database.ts` is legacy-only and unused by agent scoping or the dashboard (`docs/MVP.md`). The only live "default" with binding semantics is the per-folder assignment `<workspace>/.agent-deck/use.json` (`packages/backend/src/playbooks/stub-sync.ts`, written by `packages/cli/src/assignment.ts`).

2. **Storage is `$AGENT_DECK_HOME/default-deck.json`, i.e. `path.join(resolveAgentDeckHome(), 'default-deck.json')` (`packages/shared/src/utils/agent-deck-home.ts`).** A JSON file at the home root has precedent (`stop-request.json` / `last-stop.json` in `packages/cli/src/shutdown-reason.ts`). Shape mirrors `use.json` v3 (`packages/backend/src/playbooks/stub-sync.ts`): `{ "version": 1, "deckId": "<uuid>", "deckName": "<display only>", "updatedAt": "<iso>" }`; `deckId` is authoritative and compared by id, never by name (precedent: `resolveBindingActiveSource` in `packages/backend/src/mcp-session-binding.ts`). A missing or unreadable file means "no default", like `readUseManifest` returning null. **Deleted deck:** no delete-time cascade — `deleteDeck` (`packages/backend/src/models/database.ts`, route in `packages/backend/src/routes/decks.ts`) already leaves dangling references (per-folder `use.json` files) untouched. Instead the default is validated at resolve time: when it names a missing deck, `initialize` degrades to the existing unassigned flow (explain-only session plus `request_deck_assignment`), exactly as a manifest naming a deleted deck degrades via `markUnassigned` today (`packages/backend/src/mcp-server.ts`); the file is left in place and revalidated on every `initialize`.

3. **Set, show, and clear each need no more than one command or one click.** CLI: a new top-level `agent-deck default [<deck>] [--clear]` (`packages/cli/src/index.ts` — `default` is not in `TOP_LEVEL_COMMANDS`, so there is no collision): bare shows the current default (id plus name, or "none"); with a deck name or id sets it (deck-ref resolution precedent: `packages/cli/src/use.ts`); `--clear` deletes the file. Dashboard: the decks surface (`apps/agent-deck/src/components/deck-management-panel.tsx`, which already owns per-deck actions) gets a per-deck "Set as default" one-click action plus a current-default row with a one-click Clear. The approval pages (`apps/agent-deck/src/pages/deck-switch-approve.tsx`) stay approval-only and are not settings surfaces.

4. **Strict precedence, highest first, no ties** (extends `resolveHeaderDeck` in `packages/backend/src/mcp-server.ts`):
   1. Launch deck header (`x-agent-deck-deck-id`) — an explicit header always wins; an invalid one fails closed (401), as today.
   2. Folder assignment — an existing `<workspace>/.agent-deck/use.json`, consulted only when no header is present; a dangling one degrades to unassigned (phase-1 compatibility).
   3. User default deck — `$AGENT_DECK_HOME/default-deck.json`, consulted only when neither of the above resolved; a dangling one degrades to unassigned.

   Evidence: `resolveHeaderDeck` in `packages/backend/src/mcp-server.ts` already implements "header wins, manifest only when the header is absent", and the `else if (unassigned)` branch takes whatever resolves to nothing. Grant sessions are untouched: their default still comes from `resolveGrantDeck` in `packages/backend/src/auth/client-grants.ts`.

5. **`request_deck_assignment` does not work from a session bound to the default deck; such a session reports binding source `default`.** The tool keeps its already-assigned guard (`packages/backend/src/mcp-tools/register.ts` answers "Session is already assigned to a deck" for bound sessions) — a default-bound session is bound, so the agent moves it with `switch_deck`, and the tool stays the remedy only for genuinely unassigned sessions (no header, no assignment, no usable default), whose approval flow is unchanged (`workspace-default` still writes the folder assignment plus host entries: `applyDeckAssignmentResolution` in `packages/backend/src/trusted-session/store.ts`). Binding source: a new `default` value is added to `BindingActiveSourceSchema` (`packages/shared/src/schemas/deck-display.ts`, today `session | workspace | launch`) via `resolveBindingActiveSource` (`packages/backend/src/mcp-session-binding.ts`), reported by `get_session_binding` / `get_session_context` (`packages/backend/src/mcp-tools/register.ts`) and rendered in the first-turn receipt as `default deck, no folder pin` per Mechanism step 4 — reusing `session` would read as an override and reusing `launch` would conflate with header-selected decks.

6. **In phase 1, the persistent scope of `switch_deck` sets the user default deck; it does not write a folder assignment.** This is the option that needs no per-folder file for a working connection, per the Principle above. Concretely: the `workspace-default` decision in `applyDeckSwitchResolution` (`packages/backend/src/trusted-session/store.ts`) writes `$AGENT_DECK_HOME/default-deck.json` instead of `use.json` (no host-entry writes on this path), and the human label changes from "This workspace by default" to "Set as my default deck" in `DECK_SWITCH_SCOPE_LABELS` (`packages/backend/src/mcp-tools/elicitation.ts`) and on the dashboard button (`apps/agent-deck/src/pages/deck-switch-approve.tsx`); the NOT-298 workspaceRoot gating in those files drops for this scope since no workspace write remains. Phase-1 compatibility holds: existing `use.json` files still take precedence (answer 4), so a pinned folder keeps its deck, and `agent-deck use` (`packages/cli/src/use.ts`) remains the only writer of new folder assignments for users who explicitly want a per-folder deck.
