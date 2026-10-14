# Agent run HTTP API (same host)

The integration surface for coordinators (Botmancers, Tank, your own scripts)
that start and observe coding-agent runs through Agent Deck without shelling
out to `agent-deck run` or reading host files. The local operator surface is
still the CLI; see [DELEGATION.md](./DELEGATION.md) for per-client behavior.

Design: [2026-10-13 agent run API design](./superpowers/specs/2026-10-13-agent-run-api-design.md).
Shared Zod schemas: `packages/shared/src/schemas/agent-run.ts`. Routes:
`packages/backend/src/routes/agent-runs.ts`.

## Same-host assumption

Every run executes **on the Agent Deck host**: the coding-agent CLI (Codex,
Claude, Cursor, Muse), its sign-in, and the repository all live on the
machine running the Agent Deck backend. The HTTP caller is a separate process
and may be remote, but Agent Deck never executes on, clones to, or syncs
with the caller's machine. There is no remote runner, scheduler, or session
migration in this API.

- `cwd` is an absolute path **on the Agent Deck host**. It must already be
  assigned to the requested deck (`agent-deck use <deck>` there, which writes
  `.agent-deck/use.json`); the API never rewrites the assignment.
- Responses never carry host pids, log paths, credentials, or the prompt.
  Model output (event `text`, `tool` names, `result`) is returned as the
  client produced it and can mention host paths.

## Authentication: explicit run grant

Callers use an Agent Deck grant bearer (`Authorization: Bearer adg_…`).
Grants are MCP-only by default; the owner must enable runs explicitly:

```bash
# Owner (dashboard session): enable runs on an existing grant
curl -X PUT http://127.0.0.1:1111/api/agent-grants/<grantId>/capabilities \
  -b <dashboard-cookie> -H 'content-type: application/json' -d '{"runsEnabled":true}'
```

A run-enabled grant may start runs only on its `allowedDecks`. It reads and
cancels only runs **it** started; another grant's run returns
`403 RESOURCE_OUT_OF_SCOPE`. The owner dashboard (cookie or admin secret)
can inspect and cancel every run but cannot start one.

| Failure | Status | `error_code` |
|---------|--------|--------------|
| Missing, malformed, revoked, or expired bearer | 401 | `GRANT_REQUIRED` |
| Grant not run-enabled | 403 | `RUN_CAPABILITY_REQUIRED` |
| Deck not allowed, or run started by another grant | 403 | `RESOURCE_OUT_OF_SCOPE` |

## Endpoints

| Method and path | Purpose |
|-----------------|---------|
| `GET /api/agent-runs/capabilities` | Clients whose real host preflight passes, with profile support |
| `POST /api/agent-runs` | Start or resume (requires `Idempotency-Key`) |
| `GET /api/agent-runs/:runId` | Status |
| `GET /api/agent-runs/:runId/events?after=<cursor>&limit=<n>` | Ordered normalized events |
| `POST /api/agent-runs/:runId/cancel` | Idempotent cancel |

Success bodies are `{ "success": true, "data": … }`; errors are
`{ "success": false, "error": "<message>", "error_code": "<CODE>" }`.

### Capabilities

```json
{ "host": "same-host",
  "clients": [
    { "client": "codex", "start": ["readonly", "edit"], "resume": ["readonly", "edit"],
      "resumeRequires": "same_profile_provenance" } ] }
```

A client is listed only when the same preflight a launch runs passes right
now (binary installed and signed in; for Claude also `claude auth status` and
the SDK). A configured-but-unusable client is simply absent.

Per-client resume restrictions:

| Client | Resume | Restriction |
|--------|--------|-------------|
| `codex` | `readonly`, `edit` | `same_profile_provenance`: `codex exec resume` accepts no sandbox flag, so a resume continues only a session an Agent Deck run on this host started with the **same** deck, cwd, and tools. Anything else fails before model work with `422 RESUME_UNVERIFIED`; switching a readonly session to `edit` is never possible. |
| `claude`, `cursor`, `muse` | `readonly`, `edit` | `none`: the profile is re-applied on every resume. |

### Start or resume

```bash
curl -X POST http://<agent-deck-host>/api/agent-runs \
  -H "Authorization: Bearer $GRANT" -H 'Idempotency-Key: build-42-attempt-1' \
  -H 'content-type: application/json' \
  -d '{"deckId":"<deck>","client":"codex","cwd":"/srv/repos/app","prompt":"…","tools":"readonly"}'
# 202 {"success":true,"data":{"runId":"run-…","state":"starting"}}
```

Add `"resumeSessionId": "<sessionId from an earlier status>"` to continue a
session under a new run. Repeating a key with the same body returns the
original run; the same key with another body is `409 IDEMPOTENCY_CONFLICT`.
Other pre-launch failures (no model work happens): `400 INVALID_REQUEST`,
`413 REQUEST_TOO_LARGE`, `404 DECK_NOT_FOUND`, `422 WORKSPACE_INVALID`,
`422 WORKSPACE_MISMATCH`, `503 CLIENT_UNAVAILABLE`, `422 PROFILE_UNSUPPORTED`,
`422 RESUME_UNVERIFIED`.

### States

| State | Meaning |
|-------|---------|
| `starting` | Launch acknowledged; no event yet. Never implies success. |
| `running` | Events are arriving and the owning process is alive. |
| `ended` | Terminal. The client reported a `success` result and the session receipt named the run's deck. |
| `error` | Terminal. Client failure, non-success result, or a receipt for another deck. |
| `died` | Terminal. The owning process went away without a terminal event (for example a backend crash). |
| `canceled` | Terminal. Canceled through the API; nothing the client delivers afterwards is recorded. |

### Events

Ordered by `seq` (the 1-based position in the canonical log; stable across
reads). Types: `text`, `tool`, `notice`, `result`, `end`, `error`, and
`canceled`. Pass `nextCursor` as `after` to read the next page. A terminal
state read alongside a page means that page already holds the terminal
event. `canceled` is always the last event of a canceled run.

### Cancel

`POST /api/agent-runs/:runId/cancel` (no body) returns the run's status.
For a running run it records `canceled` and sends SIGTERM (then SIGKILL after
5 s) to the process group the run owns: the client process and whatever it
started, nothing else. Canceling a terminal run returns its terminal state
and changes nothing. `409 RUN_NOT_CANCELABLE` means the run is live under
another host process that recorded no process group (not reachable for runs
this backend started).

## Restart recovery

When the backend starts it reconciles every run still recorded as
`running` that it does not own: a live owner stays `running`; otherwise the
canonical log decides (`canceled` line → `canceled`, `error` line → `error`,
`end` after a `success` result with a matching receipt → `ended`, any other
`end` → `error`) and a run with no terminal line becomes `died`. The result
is persisted, and a process group left behind by the dead owner is stopped,
because nothing records its output any more. A graceful backend shutdown
stops the groups of runs it owns; they reconcile as `died` at the next start.

## Audit

Run creation, denial, terminal outcome, cancellation (`agent_run.canceled`,
`already_terminal` on a repeat) and reconciliation (`agent_run.reconciled`
with `run_died`, `run_error`, or `run_canceled`) are audited with grant and
run identifiers only — never prompts, results, paths, or credentials.

## Not in this API

A control plane on one host driving runners on others (runner registration,
scheduling, leases, heartbeats, session migration, remote workspace
provisioning) is a deferred idea; see design §3.3 for the conditions under
which it would be revisited.
