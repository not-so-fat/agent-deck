# ADR — NOT-513: Claude session identity for the status line

**Status:** Accepted (identifier exists — `CLAUDE_CODE_SESSION_ID`)
**Date:** 2026-10-22
**Linear:** NOT-513
**Claude Code version observed:** 2.1.307 (`claude --version`)
**Related:** NOT-309 (stale-entry expiry), NOT-191 (idle cleanup / unregister on close),
NOT-296 (concurrent-session neutral display, `workspace default` label)

## Context

In a new Claude session the status line can name the wrong deck. The status line
resolves the deck by folder only (`GET /api/scope/display?workspaceRoot=`):
with exactly one live entry it shows that entry's deck even when the entry
belongs to another session, and a new session renders its status line before
its own MCP session registers — so the first lines can only be another
session's deck, the neutral line, or the saved `use.json` deck.

The remaining gap: the status line has no way to tell which live entry is its
own. Candidates for a shared identifier readable by both the MCP bridge
process (`agent-deck mcp-launch`) and the status line command
(`agent-deck statusline`):

1. an environment variable Claude sets for MCP children / status line commands;
2. the `session_id` field in the status line stdin payload;
3. a value in the MCP `initialize` request.

## Evidence (2026-10-22, Claude Code 2.1.307)

Probes: throwaway stdio MCP server (`mcp-probe.mjs` — logs process env and
every JSON-RPC message, answers the minimal handshake) and throwaway status
line command (`statusline-probe.sh` — logs env and stdin). Both live under
[`fixtures/not-513/`](./fixtures/not-513/) with the raw logs.

| # | Candidate | Readable by bridge (MCP child) | Readable by status line command | Verdict |
|---|-----------|-------------------------------|---------------------------------|---------|
| 1 | `CLAUDE_CODE_SESSION_ID` env | **Yes** — observed in every run (print and interactive); unset in the parent shell, so genuinely set by Claude | **Yes** — observed in the interactive run, same value as the MCP child | **Shared identifier** |
| 2 | stdin `session_id` | No (MCP children get no such payload) | **Yes** — observed in the interactive run, equal to the env value | Status-line side; used first, env as fallback |
| 3 | MCP `initialize` params | **No** — params are `{protocolVersion, capabilities, clientInfo}` only, no session field | n/a | Eliminated |

### Interactive run (real TUI, 2026-10-22T01:09Z)

`claude --settings settings.json --mcp-config mcp.json` was started under a pty
([`pty-run.py`](./fixtures/not-513/pty-run.py)) with `CLAUDE_CODE_SESSION_ID`,
`CLAUDECODE`, `MUSE_SESSION_ID` and `CLAUDE_CODE_ENTRYPOINT` removed from the
parent env. It accepted the folder-trust prompt, sent no prompt and exited.
Raw logs (only `CLAUDE_CODE_MESSAGING_TOKEN` redacted) are in
[`fixtures/not-513/interactive-2026-10-22/`](./fixtures/not-513/interactive-2026-10-22/).

Status line command (`statusline-probe.txt`), first render at `01:09:42Z`:

```
--- stdin ---
{"session_id":"3ed21291-5aef-4a13-ae71-b2eaf165588d","transcript_path":"…/3ed21291-5aef-4a13-ae71-b2eaf165588d.jsonl","cwd":"/private/tmp/not513-probe",…,"version":"2.1.307",…}
--- session-like env ---
CLAUDE_CODE_CHILD_SESSION=1
CLAUDE_CODE_ENTRYPOINT=cli
CLAUDE_CODE_SESSION_ID=3ed21291-5aef-4a13-ae71-b2eaf165588d
CLAUDE_PID=13716
CLAUDE_PROJECT_DIR=/private/tmp/not513-probe
CLAUDECODE=1
```

MCP child (`mcp-probe.txt`), same session:

```json
{"event":"spawn","time":"2026-10-22T01:09:42.552Z","pid":13781,"env_session_like":{…,"CLAUDE_CODE_ENTRYPOINT":"cli","CLAUDE_PROJECT_DIR":"/private/tmp/not513-probe","CLAUDE_CODE_SESSION_ID":"3ed21291-5aef-4a13-ae71-b2eaf165588d","CLAUDECODE":"1"}}
{"event":"msg","time":"2026-10-22T01:09:45.400Z","method":"initialize","id":0,"params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}},"clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.307",…}}}
```

SessionStart hook (`hook-probe.txt`) saw the same `session_id` on stdin and
the same `CLAUDE_CODE_SESSION_ID` in its env.

What this shows:

- **Equality:** the status line's stdin `session_id`, the status line's
  `CLAUDE_CODE_SESSION_ID` env, and the MCP child's `CLAUDE_CODE_SESSION_ID`
  env are all `3ed21291-5aef-4a13-ae71-b2eaf165588d` in one session. The
  bridge and the status line can both read the same id.
- **Ordering:** the status line first rendered at `01:09:42Z`, before the
  MCP child received `initialize` (`01:09:45.400Z`). So the first lines
  always come before registration, and the "session starting" state is
  what the user sees until the bridge registers.
- `CLAUDE_CODE_SESSION_ID` was not in the parent env, so Claude set it.

### Earlier print-mode runs

In `claude -p` runs the MCP child env carried `CLAUDE_CODE_SESSION_ID`, a fresh
UUID each run (5 runs: `037a8613…`, `9baf06e1…`, `eec883b2…`, `cf1b7641…`,
`7285c3c6…`). The status line and hooks never ran in print mode. The
`initialize` params were identical to the interactive run. `MUSE_SESSION_ID`
in those logs came from the harness parent env, not from Claude.

### Not verified in the sandbox

The full first-render check with Agent Deck's own bridge and status line
(acceptance criterion 5) needs this branch's backend on the default ports.
The operator's production instance holds those ports, so the check stays an
**[operator]** step: start `claude` in this repo on a non-default deck. The
expected result is `◆ Agent Deck · session starting` and then the launched
deck, never the folder default or another session's deck.

## Decisions

### D1. Shared identifier: `CLAUDE_CODE_SESSION_ID`

The bridge reads `process.env.CLAUDE_CODE_SESSION_ID` (trimmed, non-empty)
and forwards it as the `x-agent-deck-host-session-id` HTTP header on every
request (single choke point: `requestHeaders()`). The MCP server adopts it
adopt-once per transport session (same pattern as the NOT-304 correlation
id) and includes it in the `POST /api/scope/live-display` body; the
registry stores it as `hostSessionId` on the entry.

It is display-routing metadata only: it never selects a deck, grants access,
or participates in auth — same authority class as the correlation id.

### D2. Status line sends its own id; resolver prefers self-match

`agent-deck statusline` resolves its host session id as
stdin `session_id` first (`resolveStatusLineSessionId`), then the
`CLAUDE_CODE_SESSION_ID` env fallback, and sends it as
`GET /api/scope/display?workspaceRoot=…&hostSessionId=…` when present.
No id → byte-for-byte today's behavior (Cursor path unchanged — Cursor
never sets the env var and its payload shape is untouched).

`resolveDeckDisplay` with a `hostSessionId`:

- workspace match contains an entry with that `hostSessionId` → that
  entry's deck (even when other sessions disagree — that is the point);
- otherwise (no match, or a non-blank id that fails format validation) → the neutral `◆ Agent Deck · session starting` state, which
  names no deck: never another session's deck, and not the saved
  workspace default either (the session simply has not registered yet).

### D3. No new commands, no Cursor/expiry/cleanup/agreement changes

Stale-entry expiry, unregister on close, the multi-session agreement rule,
and the Cursor status line are untouched. Live entries without a
`hostSessionId` (older bridge, non-Claude clients) keep today's folder
resolution; a `hostSessionId` that matches nothing always yields
"session starting", never a guess.

## Consequences

- A new Claude session's first status line names its own deck as soon as its
  bridge handshake registers, and shows `session starting` (not a sibling
  session's deck) before that.
- Mixed-version note: bridge and status line ship in the same CLI, so they
  upgrade together; a new status line against an old bridge (no stored id)
  stays on `session starting` for that folder until the bridge upgrades.
  No silent wrong-deck regression in any combination.
