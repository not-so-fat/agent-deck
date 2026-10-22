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

### First-render check with Agent Deck's own bridge and status line (2026-10-22T01:27Z)

This is acceptance criterion 5, run at this branch's code. Raw logs and the
harness are in
[`fixtures/not-513/e2e-2026-10-22/`](./fixtures/not-513/e2e-2026-10-22/).

Setup. The operator's production instance holds the default ports, so this
branch's backend and MCP server ran isolated on `8513`/`8514`, with a temp
`AGENT_DECK_HOME` ([`env.sh`](./fixtures/not-513/e2e-2026-10-22/harness/env.sh)).
The bridge and the status line were the real built CLI
(`node packages/cli/dist/bin.js mcp-launch` / `statusline`). Each was wrapped
only to log ([`bridge-wrap.sh`](./fixtures/not-513/e2e-2026-10-22/harness/bridge-wrap.sh),
[`statusline-wrap.sh`](./fixtures/not-513/e2e-2026-10-22/harness/statusline-wrap.sh)).
The status line had `refreshInterval: 1`. A temp git folder
(`/private/tmp/not513-e2e/ws`) stood in for the repo, so that its `.mcp.json` and
`use.json` writes stayed out of the worktree.

- Three decks: `Folder Default`, `Launched Deck`, `Other Session`.
- **Sibling session.** A real `agent-deck mcp-launch` bridge ran with
  `CLAUDE_CODE_SESSION_ID=11111111-…` on `Other Session`
  ([`sibling.mjs`](./fixtures/not-513/e2e-2026-10-22/harness/sibling.mjs)). It
  stayed live for the whole run. With only that entry, the old folder-only
  query named `◆ Other Session …`, which is the reported bug.
- **New session.** With `use.json` = `Launched Deck`, real interactive
  `claude` 2.1.307 was started under a pty with `--strict-mcp-config`
  ([`pty-run.py`](./fixtures/not-513/e2e-2026-10-22/harness/pty-run.py)).
- **Folder default changed.** About 16 s after the session's bridge
  registered, the driver ran `agent-deck use "Folder Default"`. This changes
  the folder default the way a second terminal would, so the launched deck
  and the folder default differ. (`mcp-launch` takes its deck from `use.json`
  when it starts, so this is the race-free way to get a session whose deck
  is not the folder default.)

Result. These are all 53 status line renders, from
[`statusline-renders.txt`](./fixtures/not-513/e2e-2026-10-22/statusline-renders.txt):

```
01:28:00.191Z  ◆ Agent Deck · session starting                                  (1 render)
01:28:01.416Z  ◆ Launched Deck · 0 MCP · 0 keys · 0 playbooks · ⌘ember (…)        (14 renders)
01:28:15.412Z  ◆ Launched Deck · … · ⌘ember (…) · session (default Folder Default) (38 renders, after `use "Folder Default"`)
```

- Every render carried stdin `session_id` = env `CLAUDE_CODE_SESSION_ID` =
  `75dc1403-2035-4764-8940-291b9accaa3e`. The bridge was spawned with the
  same value (`claude-bridge-stderr.txt`).
- The first render named no deck. Every later render named `Launched Deck`.
  No render named `Other Session`, and none showed `Folder Default` as its
  deck. The folder-only query was logged next to each render, and the whole
  time it would have shown `◆ Agent Deck · multiple session decks` (and
  `◆ Other Session` before registration).
- The terminal output shows Claude drawing `◆ Agent Deck · session starting`
  and then patching it in place to `◆ Launched Deck · 0 MCP · …`
  ([`terminal-statusline-bytes.txt`](./fixtures/not-513/e2e-2026-10-22/terminal-statusline-bytes.txt)).

Side observations. Neither is caused by this change and both are out of
scope here:

- Claude 2.1.307 sends a `server/discover` probe before `initialize` (also
  in the earlier probe log). The bridge has no session yet, gets an HTTP 400,
  and logs a spurious "server restarted … re-initialization failed" line.
  `initialize` and registration then go through normally.
- After `/exit`, this session's live entry was still registered
  (`post-run-display.txt`). So Claude did not end the bridge with a clean
  stdin close. A bridge whose stdin closes cleanly does unregister: a manual
  check at the same build went from the deck to `session starting`. The
  leftover entry is aged out by the NOT-309 expiry. It is keyed by its own
  host session id, so it can never be shown to another session.

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

- A new Claude session's status line names its own deck as soon as its
  bridge handshake registers, and shows `session starting` (not a sibling
  session's deck) before that. In the real run, that was one render, about
  1.2 s.
- Mixed-version note: bridge and status line ship in the same CLI, so they
  upgrade together; a new status line against an old bridge (no stored id)
  stays on `session starting` for that folder until the bridge upgrades.
  No silent wrong-deck regression in any combination.
