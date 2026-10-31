# NOT-540 smoke: MCP-only delegation from a real Agent Dealer sandbox

Status: **pending operator run** — CI fixture evidence is recorded below. The
real-sandbox receipts are not recorded yet (see "Developer-session finding").

Records only safe identifiers and outcomes. No prompts containing secrets, no
host credentials, no host log paths.

## What the smoke proves

From a Dealer developer- or reviewer-style worktree, an agent using only
Agent Deck MCP can:

1. bootstrap with `get_session_context` (launch-selected deck and workspace,
   no `.agent-deck/use.json`);
2. `switch_deck` to another deck with **This session only** approval, then
   refresh `get_session_context`;
3. `start_run` with a pinned `playbookVersion` in the Dealer-supplied worktree;
4. page `get_run` with `after = nextCursor` to a terminal state;
5. resume with `start_run(resumeSessionId)` or stop with `cancel_run`;
6. confirm with `get_session_binding` that `workspace_default_deck_id` is
   unchanged (absent before and after).

## Qualifying environment (check before running)

- The sandbox `PATH` has no Agent Deck CLI.
- The sandbox shell cannot reach the host's loopback ports.
- The host Agent Deck is a build that includes NOT-539 (`start_run`,
  `get_run`, `cancel_run` appear in the session's MCP tool list).

Do not use the sandbox shell for any part of the smoke itself. Every step goes
through MCP tool calls.

## Developer-session finding (2026-10-31, Dealer session for NOT-540)

This Dealer developer session (deck `builder`, `deck_source: launch`, runtime
session badge `s63`) did **not** qualify, so the real smoke was not run from it:

| Check | Result |
|---|---|
| Agent Deck CLI on sandbox `PATH` | present (`~/.local/bin/agent-deck`) — fails "no CLI" |
| Sandbox shell → host loopback | reachable (one read-only health probe, used only to check whether the environment qualified; no delegation call) — fails "no loopback" |
| `start_run` / `get_run` / `cancel_run` in this session's MCP tool list | absent — the installed host is 2.3.2, before NOT-539 shipped |

Next action: after NOT-539 + NOT-540 ship and the host is upgraded, launch one
Dealer role session in a sandbox that has no Agent Deck CLI on `PATH` and no
loopback, then fill in the receipt below.

## Receipt (to fill in from the qualifying run)

```
date:                    YYYY-MM-DD
dealer issue / session:  NOT-___ / <dealer session id>
host agent-deck version: <version>
launch deck → session deck: <deck A> → <deck B> (This session only)
pinned playbook:         <playbookId>=<versionId>
start_run:               runId=<runId> state=<state>
get_run pages:           <seq:type, …> → terminal <state>
sessionId:               <sessionId>
tool profile:            readonly
final result:            <one-line sanitized result>
resume or cancel:        runId=<runId> state=<state>
workspace default:       before=<null|deck> after=<same>
sandbox CLI / loopback:  absent / unreachable (checked before the smoke)
```

## CI fixture evidence (Dealer-style, fake provider)

`packages/backend/src/mcp-tools/run-tools.http.test.ts` →
"NOT-540: runs the skill loop from a Dealer-style launch and leaves the saved
workspace default absent". Real MCP server and backend, fixture adapter, launch
deck header plus role worktree, no `.agent-deck/use.json`. It logs this receipt
(run ids differ per run):

```
NOT-540 receipt {"runId":"run-20261031T202509-567b6a","sessionId":"ses_1","tools":"readonly",
 "effectiveDeck":"beta","worktree":"ad-mcp-run-wt-…",
 "events":["1:text","2:tool","3:notice","4:result","5:end"],"terminal":"ended",
 "resumed":{"runId":"run-20261031T202509-109402","state":"ended"},
 "canceled":{"runId":"run-20261031T202509-e65eb5","state":"canceled"},
 "workspaceDefault":null,"useJson":"absent"}
```

The test also asserts that the launch used the switched deck, the canonical
worktree as cwd, and the pinned `{ playbookId, versionId }`, and that the
worktree contents are byte-identical before and after.
