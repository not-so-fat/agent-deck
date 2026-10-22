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
| 1 | `CLAUDE_CODE_SESSION_ID` env | **Yes** — present in every run, fresh UUID per `claude` invocation (5 runs: `037a8613…`, `9baf06e1…`, `eec883b2…`, `cf1b7641…`, `7285c3c6…`); unset in the parent shell, so genuinely set by Claude | **Yes** — same main-process session id (`V()`); see binary evidence below | **Shared identifier** |
| 2 | stdin `session_id` | No (MCP children get no such payload) | Yes (documented payload; `resolveStatusLineSessionId` already parses it) | Status-line side only — used as first choice, env as fallback |
| 3 | MCP `initialize` params | **No** — observed params are `{protocolVersion, capabilities, clientInfo}` only, no session/token field | n/a | Eliminated |

Raw MCP-child spawn env (run 1, `run2-mcp.log` / `run3-plus-mcp.log`):

```json
{"env_session_like":{"MUSE_SESSION_ID":"1682286c-a0a9-490e-820a-f2603243a135","CLAUDE_CODE_TOOL_USE_ID":"call_01a…","AI_AGENT":"claude-code_2-1-307_harness","CLAUDE_CODE_ENTRYPOINT":"sdk-cli","CLAUDE_PROJECT_DIR":"/private/tmp/not513-probe","CLAUDE_CODE_SESSION_ID":"037a8613-6b9a-41fd-a7f3-24ddb543a456","CLAUDECODE":"1"}}
```

```json
{"event":"msg","method":"initialize","id":0,"params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}},"clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.307","description":"Anthropic's agentic coding tool","websiteUrl":"https://claude.com/claude-code"}}}
```

Notes on the observations:

- `MUSE_SESSION_ID` in the probe env is **inherited harness env** (it equals the
  builder session's own id and is set in the parent shell) — not set by Claude,
  not a candidate.
- The status line command and hooks do **not** run in `claude -p` (print) mode:
  `statusline-probe.log` and `hook-probe.log` stayed empty across all print
  runs, and interactive TUI could not be started in this sandbox (no pty
  devices: `script` → `openpty: Operation not permitted`, python `pty` →
  `out of pty devices`). So the status-line half rests on static evidence:
- Static evidence (`strings` on the 2.1.307 binary): the main process assigns
  its own env once per session (`process.env.CLAUDE_CODE_SESSION_ID=V()`),
  and both MCP-spawn sites build the child env with
  `{…, CLAUDE_PROJECT_DIR, CLAUDE_CODE_SESSION_ID:V(), CLAUDECODE:"1", …}` —
  exactly matching the runtime probe. Every Claude-spawned child therefore
  shares the same session id unless its spawn path explicitly scrubs it;
  the status line command takes `session_id` on stdin as well, so the
  status line resolves stdin first and env second and both name the same
  session.
- Operator follow-up (acceptance criterion 5) still covers the real
  interactive first-render check.

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
- otherwise → the neutral `◆ Agent Deck · session starting` state, which
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
