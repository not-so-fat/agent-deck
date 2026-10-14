# NOT-481 same-host agent run API smoke (operator record)

**Date:** 2026-10-13 (UTC 2026-10-14T02:11–02:15)
**Agent Deck code under test:** `75d17a4d22415d05bafe365143dd2dfd6ddbc0b2` (branch `yusukemuraoka0208/not-481-agent-deck-run-api-capabilities-cancellation-restart`; `packages/backend` built with `npm run build` from that commit and started with `node dist/index.js`)
**Host:** one macOS host runs Agent Deck, Codex, and the workspace. Isolated `AGENT_DECK_HOME=/tmp/not481-smoke/home`, `PORT=18481`, `HOST=127.0.0.1`.
**Codex:** `codex --version` → `codex-cli 0.157.1`; `codex login status` → `Logged in using ChatGPT`.
**Caller:** a separate shell script that only runs `curl` against the public HTTP API with a run grant bearer. It never runs `agent-deck`, never reads `<home>/runs/`, and never reads `meta.json` or `run.jsonl`. Lines marked `host:` are operator-side `pgrep` checks, not caller evidence.

## Redactions

| Shown as | Meaning |
|----------|---------|
| `<run-grant>` | `adg_…` grant bearer (run-enabled, `allowedDecks` = the smoke deck) |
| `<deck>` | smoke deck id |
| `run-…-<r1>` … `<r4>` | random 6-hex suffix of each run id (the timestamp part is real) |
| `<S1:01a1382e…c345cab>` | the Codex thread id of run r1; every occurrence is the **same** full value |
| `<S3>`, `<S4>` | Codex thread ids of runs r3 and r4 |
| `/Users/<owner>` | the owner's home directory inside model tool output |
| `<pid>` | host pids |

## Owner setup (dashboard authority, not the caller)

1. Bootstrap a dashboard session (admin secret → `POST /api/dashboard-auth/bootstrap/nonce` → `POST /api/dashboard-auth/bootstrap/session`).
2. `POST /api/decks {"name":"not481-smoke"}`.
3. `POST /api/agent-grants {"label":"not481-smoke-caller","defaultDeck":"<deck>","runsEnabled":true}`.
4. `git init` a workspace at `/tmp/not481-smoke/ws` and assign it to the deck (`.agent-deck/use.json` v3, as `agent-deck use` writes it).

## Results

| Check | Run | Result |
|-------|-----|--------|
| Capabilities from real preflight | — | `codex` listed with `start`/`resume` = `readonly`,`edit` and `resumeRequires: same_profile_provenance`; `cursor` and `muse` listed (installed and signed in); `claude` absent: `claude auth status` reports signed in, but `@anthropic-ai/claude-agent-sdk` does not resolve from `packages/backend` (it is a CLI dependency), so the adapter preflight fails and a Claude launch would return `503 CLIENT_UNAVAILABLE` |
| Read-only start reaches `ended` | r1 | `starting` → `ended`; ordered events `text`, `result` (`success`, `SMOKE_OK`), `end` |
| Read-only resume keeps the session id | r2 | new run id; status `sessionId` = r1's `sessionId` (`<S1>`, byte-identical); events `notice` (resume provenance), `text`, `result` (`SMOKE_OK_AGAIN`, which shows the resumed thread remembered turn 1), `end`; `ended` |
| Resumed `edit` stays refused | — | `422 RESUME_UNVERIFIED` before any model work (the codex guard is unchanged) |
| Cancel an in-flight real run | r3 | `running` → cancel `200 canceled` → repeat cancel `200 canceled` (idempotent); events end with exactly one `canceled`, no `result`/`end`/`error`; host shows no `codex exec` left |
| Canceled survives a backend restart | r3 | backend killed with SIGKILL and restarted: status and events still `canceled`, unchanged |
| Crash recovery is truthful | r4 | `running` when the backend was SIGKILLed (its Codex process kept running orphaned); after restart status is `died` (not `ended`), the orphaned Codex group was stopped, and cancel returns `died` unchanged; the owner dashboard reads the same `died` |
| Ended runs stay ended after restart | r1, r2 | `ended` |

Instance 2 was stopped with SIGTERM at the end (graceful shutdown, exit 0).

## Transcript (redacted)

The HTTP part was captured by the caller script. Request bodies are shown under `body:`.

```text
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/capabilities -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"host":"same-host","clients":[{"client":"codex","start":["readonly","edit"],"resume":["readonly","edit"],"resumeRequires":"same_profile_provenance"},{"client":"cursor","start":["readonly","edit"],"resume":["readonly","edit"],"resumeRequires":"none"},{"client":"muse","start":["readonly","edit"],"resume":["readonly","edit"],"resumeRequires":"none"}]}}
$ curl -s -X POST http://127.0.0.1:18481/api/agent-runs -H 'Authorization: Bearer <run-grant>' -H 'Idempotency-Key: smoke-start-1' -d '<body>'
  body: {"deckId":"<deck>","client":"codex","cwd":"/tmp/not481-smoke/ws","prompt":"Reply with exactly the word SMOKE_OK and nothing else. Do not run any tools or commands.","tools":"readonly"}
  -> HTTP 202 {"success":true,"data":{"runId":"run-20261014T021224-<r1>","state":"starting"}}
  (polled GET /agent-runs/run-20261014T021224-<r1> until state=ended)
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021224-<r1> -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021224-<r1>","deckId":"<deck>","client":"codex","tools":"readonly","state":"ended","sessionId":"<S1:01a1382e…c345cab>","startedAt":"2026-10-14T02:12:24.594Z","lastEventAt":"2026-10-14T02:12:35.247Z"}}
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021224-<r1>/events -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021224-<r1>","state":"ended","events":[{"seq":1,"ts":"2026-10-14T02:12:33.909Z","type":"text","text":"SMOKE_OK"},{"seq":2,"ts":"2026-10-14T02:12:34.018Z","type":"result","subtype":"success","result":"SMOKE_OK","sessionId":"<S1:01a1382e…c345cab>"},{"seq":3,"ts":"2026-10-14T02:12:35.247Z","type":"end","sessionId":"<S1:01a1382e…c345cab>"}],"nextCursor":"3"}}
$ curl -s -X POST http://127.0.0.1:18481/api/agent-runs -H 'Authorization: Bearer <run-grant>' -H 'Idempotency-Key: smoke-resume-1' -d '<body>'
  body: {"deckId":"<deck>","client":"codex","cwd":"/tmp/not481-smoke/ws","prompt":"What single word did you reply with last turn? Reply with exactly that word followed by _AGAIN. Do not run any tools or commands.","tools":"readonly","resumeSessionId":"<S1:01a1382e…c345cab>"}
  -> HTTP 202 {"success":true,"data":{"runId":"run-20261014T021240-<r2>","state":"running"}}
  (polled GET /agent-runs/run-20261014T021240-<r2> until state=ended)
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021240-<r2> -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021240-<r2>","deckId":"<deck>","client":"codex","tools":"readonly","state":"ended","sessionId":"<S1:01a1382e…c345cab>","startedAt":"2026-10-14T02:12:40.414Z","lastEventAt":"2026-10-14T02:12:44.357Z"}}
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021240-<r2>/events -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021240-<r2>","state":"ended","events":[{"seq":1,"ts":"2026-10-14T02:12:40.419Z","type":"notice","message":"Resuming codex thread <S1:01a1382e…c345cab> started by run run-20261014T021224-<r1>: the thread keeps its original sandbox (--tools readonly, read-only).","sessionId":"<S1:01a1382e…c345cab>"},{"seq":2,"ts":"2026-10-14T02:12:43.098Z","type":"text","text":"SMOKE_OK_AGAIN"},{"seq":3,"ts":"2026-10-14T02:12:43.208Z","type":"result","subtype":"success","result":"SMOKE_OK_AGAIN","sessionId":"<S1:01a1382e…c345cab>"},{"seq":4,"ts":"2026-10-14T02:12:44.357Z","type":"end","sessionId":"<S1:01a1382e…c345cab>"}],"nextCursor":"4"}}
$ curl -s -X POST http://127.0.0.1:18481/api/agent-runs -H 'Authorization: Bearer <run-grant>' -H 'Idempotency-Key: smoke-resume-edit' -d '<body>'
  body: {"deckId":"<deck>","client":"codex","cwd":"/tmp/not481-smoke/ws","prompt":"noop","tools":"edit","resumeSessionId":"<S1:01a1382e…c345cab>"}
  -> HTTP 422 {"success":false,"error":"resumeSessionId was not started by a matching codex run on this deck, cwd, and tools profile","error_code":"RESUME_UNVERIFIED"}
$ curl -s -X POST http://127.0.0.1:18481/api/agent-runs -H 'Authorization: Bearer <run-grant>' -H 'Idempotency-Key: smoke-cancel-1' -d '<body>'
  body: {"deckId":"<deck>","client":"codex","cwd":"/tmp/not481-smoke/ws","prompt":"Run the shell command `sleep 300` and wait for it to finish, then reply with exactly DONE.","tools":"readonly"}
  -> HTTP 202 {"success":true,"data":{"runId":"run-20261014T021254-<r3>","state":"starting"}}
  (operator, host-side only: codex processes before cancel)
  host: <pid> codex exec --json -s read-only -- Run the shell command `sleep 300` and wait for it to finish, then reply with exactly DONE.
  host: <pid> codex exec --json -s read-only -- Run the shell command `sleep 300` and wait for it to finish, then reply with exactly DONE.
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021254-<r3> -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021254-<r3>","deckId":"<deck>","client":"codex","tools":"readonly","state":"running","sessionId":"<S3>","startedAt":"2026-10-14T02:12:54.128Z","lastEventAt":"2026-10-14T02:13:03.070Z"}}
$ curl -s -X POST http://127.0.0.1:18481/api/agent-runs/run-20261014T021254-<r3>/cancel -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021254-<r3>","deckId":"<deck>","client":"codex","tools":"readonly","state":"canceled","sessionId":"<S3>","startedAt":"2026-10-14T02:12:54.128Z","lastEventAt":"2026-10-14T02:13:03.728Z"}}
$ curl -s -X POST http://127.0.0.1:18481/api/agent-runs/run-20261014T021254-<r3>/cancel -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021254-<r3>","deckId":"<deck>","client":"codex","tools":"readonly","state":"canceled","sessionId":"<S3>","startedAt":"2026-10-14T02:12:54.128Z","lastEventAt":"2026-10-14T02:13:03.728Z"}}
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021254-<r3>/events -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021254-<r3>","state":"canceled","events":[{"seq":1,"ts":"2026-10-14T02:12:58.481Z","type":"text","text":"I’m using the Agent Deck session skill because this workspace requires session bootstrap before any task command."},{"seq":2,"ts":"2026-10-14T02:13:03.070Z","type":"tool","name":"command:/bin/zsh -lc 'cat /Users/<owner>/.codex/plugins/cache/agent-deck/agent-deck/2.1.1/skills/agent-deck-session/SKILL.md'"},{"seq":3,"ts":"2026-10-14T02:13:03.728Z","type":"canceled","sessionId":"<S3>"}],"nextCursor":"3"}}
  (operator, host-side only: codex processes after cancel)
  host: (none)
$ curl -s -X POST http://127.0.0.1:18481/api/agent-runs -H 'Authorization: Bearer <run-grant>' -H 'Idempotency-Key: smoke-crash-1' -d '<body>'
  body: {"deckId":"<deck>","client":"codex","cwd":"/tmp/not481-smoke/ws","prompt":"Run the shell command `sleep 300` and wait for it to finish, then reply with exactly DONE.","tools":"readonly"}
  -> HTTP 202 {"success":true,"data":{"runId":"run-20261014T021316-<r4>","state":"starting"}}
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021316-<r4> -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021316-<r4>","deckId":"<deck>","client":"codex","tools":"readonly","state":"running","sessionId":"<S4>","startedAt":"2026-10-14T02:13:16.745Z","lastEventAt":"2026-10-14T02:13:21.573Z"}}
  (operator: kill -9 <backend-pid> to simulate a crash)
  (operator, host-side: orphaned codex after crash)
  host: <pid> codex exec --json -s read-only -- Run the shell command `sleep 300` and wait for it to finish, then reply with exactly DONE.
  (operator: start backend instance 2 from the same worktree HEAD, same home)
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021254-<r3> -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021254-<r3>","deckId":"<deck>","client":"codex","tools":"readonly","state":"canceled","sessionId":"<S3>","startedAt":"2026-10-14T02:12:54.128Z","lastEventAt":"2026-10-14T02:13:03.728Z"}}
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021254-<r3>/events -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021254-<r3>","state":"canceled","events":[{"seq":1,"ts":"2026-10-14T02:12:58.481Z","type":"text","text":"I’m using the Agent Deck session skill because this workspace requires session bootstrap before any task command."},{"seq":2,"ts":"2026-10-14T02:13:03.070Z","type":"tool","name":"command:/bin/zsh -lc 'cat /Users/<owner>/.codex/plugins/cache/agent-deck/agent-deck/2.1.1/skills/agent-deck-session/SKILL.md'"},{"seq":3,"ts":"2026-10-14T02:13:03.728Z","type":"canceled","sessionId":"<S3>"}],"nextCursor":"3"}}
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021316-<r4> -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021316-<r4>","deckId":"<deck>","client":"codex","tools":"readonly","state":"died","sessionId":"<S4>","startedAt":"2026-10-14T02:13:16.745Z","lastEventAt":"2026-10-14T02:13:23.008Z"}}
$ curl -s -X POST http://127.0.0.1:18481/api/agent-runs/run-20261014T021316-<r4>/cancel -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021316-<r4>","deckId":"<deck>","client":"codex","tools":"readonly","state":"died","sessionId":"<S4>","startedAt":"2026-10-14T02:13:16.745Z","lastEventAt":"2026-10-14T02:13:23.008Z"}}
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021224-<r1> -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021224-<r1>","deckId":"<deck>","client":"codex","tools":"readonly","state":"ended","sessionId":"<S1:01a1382e…c345cab>","startedAt":"2026-10-14T02:12:24.594Z","lastEventAt":"2026-10-14T02:12:35.247Z"}}
$ curl -s -X GET http://127.0.0.1:18481/api/agent-runs/run-20261014T021240-<r2> -H 'Authorization: Bearer <run-grant>'
  -> HTTP 200 {"success":true,"data":{"runId":"run-20261014T021240-<r2>","deckId":"<deck>","client":"codex","tools":"readonly","state":"ended","sessionId":"<S1:01a1382e…c345cab>","startedAt":"2026-10-14T02:12:40.414Z","lastEventAt":"2026-10-14T02:12:44.357Z"}}
  (operator, host-side: codex processes after restart reconciliation)
  host: (none)
$ curl -s -b <owner-dashboard-cookie> http://127.0.0.1:18481/api/agent-runs/run-20261014T021316-<r4>
  -> {"success":true,"data":{"runId":"run-20261014T021316-<r4>","deckId":"<deck>","client":"codex","tools":"readonly","state":"died","sessionId":"<S4>","startedAt":"2026-10-14T02:13:16.745Z","lastEventAt":"2026-10-14T02:13:23.008Z"}}
```

Two notes on the host checks: before the cancel, the second `pgrep` (for `sleep 300`) matched the `codex exec` argv itself, which contains that text, so both `host:` lines are the same Codex process; the model was still reading a skill file (event seq 2) and had not started `sleep` yet. So r3 was canceled mid-turn, not mid-`sleep`.
