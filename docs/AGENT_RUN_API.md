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
| Grant not finalization-enabled (finalize only) | 403 | `FINALIZATION_CAPABILITY_REQUIRED` |

## Endpoints

| Method and path | Purpose |
|-----------------|---------|
| `GET /api/agent-runs/capabilities` | Clients whose real host preflight passes, with profile support |
| `POST /api/agent-runs` | Start or resume (requires `Idempotency-Key`) |
| `GET /api/agent-runs/:runId` | Status |
| `GET /api/agent-runs/:runId/events?after=<cursor>&limit=<n>` | Ordered normalized events |
| `POST /api/agent-runs/:runId/cancel` | Idempotent cancel |
| `GET /api/agent-runs/:runId/changes` | Candidate manifest of a terminal prepared run ([finalization](#finalization-one-reviewed-manifest--one-local-commit)) |
| `POST /api/agent-runs/:runId/finalize` | One reviewed manifest → one local commit (requires `Idempotency-Key`) |

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

## Finalization: one reviewed manifest → one local commit

A coordinator that reviewed an edit run can turn exactly the files the run
changed into **one local commit** on the Agent Deck host — without the coding
agent ever holding `.git` authority and without the caller running Git.

**Policy / mechanism split.** The caller (for example Botmancers) owns the
review *policy*: which run, which reviewed manifest, the `reviewId`, the
commit message. Agent Deck owns the *mechanism*: it proves that manifest
against the repository and creates the commit with a fixed set of Git
plumbing commands (repository hooks and fsmonitor disabled). There is no
endpoint that accepts Git arguments.

**Same-host workspace.** The repository is always the run's captured `cwd`
on the Agent Deck host. `/changes` and `/finalize` take no `cwd`; a request
that adds one is `400 INVALID_REQUEST`.

**Capability opt-in.** Finalizing needs a grant with **both** `runsEnabled`
and `finalizationEnabled` (default `false`; existing and run-only grants
cannot finalize). The owner enables it on the same route:

```bash
curl -X PUT http://127.0.0.1:1111/api/agent-grants/<grantId>/capabilities \
  -b <dashboard-cookie> -H 'content-type: application/json' -d '{"finalizationEnabled":true}'
```

Only the **creating** grant, on a deck it is still allowed, reads `/changes`
or finalizes; the owner dashboard cannot (`401 GRANT_REQUIRED`).

### 1. Prepare before launch

Add `"prepareFinalization": true` to `POST /api/agent-runs`. It is valid only
with `"tools": "edit"`, a `cwd` inside a Git worktree whose `HEAD` is a commit
on a local branch (or detached), and a **clean Git index** (nothing staged or
unmerged). Otherwise the run fails before any adapter starts:
`422 FINALIZATION_INVALID` or `409 INDEX_DIRTY`. A dirty *working tree* is
fine: before launch Agent Deck records a private baseline of every
pre-existing dirty path and its content digest. Status shows only

```json
"finalization": { "baselineRef": "bl_…", "baselineDigest": "<sha256>", "state": "prepared", "commit": null }
```

(`state` becomes `finalizing`, then `finalized` with the commit id). Runs
without `prepareFinalization` report `"finalization": null` and can never be
finalized (`409 FINALIZATION_NOT_PREPARED`).

### 2. Read the candidate manifest

Once the run is terminal (`ended`, `error`, `died`, or `canceled`; otherwise
`409 RUN_NOT_TERMINAL`):

```bash
curl http://<agent-deck-host>/api/agent-runs/<runId>/changes -H "Authorization: Bearer $GRANT"
# {"success":true,"data":{"runId":"run-…","baselineRef":"bl_…","baselineDigest":"…","baseCommit":"<HEAD>",
#   "files":[{"path":"src/a.ts","sha256":"…","mode":"100644"},{"path":"old.txt","sha256":null,"mode":null}],
#   "manifestDigest":"…"}}
```

`files` is every path the run produced, ordered by path: repository-relative,
`sha256` of the exact working-tree bytes, Git `mode` (`100644`/`100755`), and
`sha256: null, mode: null` for a deletion. Pre-existing dirty paths that the
run left byte-identical are excluded; if the run changed one,
`409 BASELINE_MISMATCH`. Agent Deck's own `.agent-deck/` folder (the deck
binding) is never a candidate and never committable. No file content or host
path is returned. A run that produced a symlink, a submodule change, or a
nested repository is `422 PATH_INVALID`.

### 3. Finalize

```bash
curl -X POST http://<agent-deck-host>/api/agent-runs/<runId>/finalize \
  -H "Authorization: Bearer $GRANT" -H 'Idempotency-Key: review-42' -H 'content-type: application/json' \
  -d '{"baselineDigest":"…","expectedBaseCommit":"<baseCommit>","reviewId":"review-42",
       "commitMessage":"Fix the parser","files":[…exactly the reviewed manifest…]}'
# 200 {"success":true,"data":{"runId":"run-…","finalizationState":"finalized","commit":"…","tree":"…",
#      "parent":"<expectedBaseCommit>","manifestDigest":"…","fileCount":2,"reviewId":"review-42"}}
```

`reviewId` is 1–200 printable ASCII characters; `commitMessage` is non-empty,
at most 8192 characters, and used verbatim; `files` holds 1–1000 entries.
Before staging Agent Deck re-checks the baseline, `HEAD` and its ref, the
index, every path (no absolute path, `..`, `.git` segment, `.agent-deck/`,
duplicate, submodule, or path through a symlink), and the latest candidate
snapshot: the manifest must equal it exactly — same paths, digests, and modes.
It then stages exactly those paths **in a private index** from the verified
bytes, re-reads the staged set and blob digests, writes one commit whose only
parent is `expectedBaseCommit`, and moves the ref by compare-and-swap. The
real index is held under Git's own `index.lock` throughout and replaced only
after the ref moved, so it then matches the new `HEAD`; unrelated dirty files
stay dirty and byte-identical. Agent Deck never checks out, resets, cleans,
deletes working-tree files, pushes, or opens a pull request.

| Failure | Status | `error_code` |
|---------|--------|--------------|
| Missing/invalid `Idempotency-Key` | 400 | `IDEMPOTENCY_KEY_REQUIRED` |
| Body not the strict schema (empty manifest, extra field such as `cwd`) | 400 | `INVALID_REQUEST` |
| Run not prepared / not terminal | 409 | `FINALIZATION_NOT_PREPARED` / `RUN_NOT_TERMINAL` |
| Workspace no longer the captured Git worktree | 422 | `FINALIZATION_INVALID` |
| `expectedBaseCommit` or `HEAD`/ref differs from the baseline | 409 | `BASE_MISMATCH` |
| Index has staged or unmerged changes | 409 | `INDEX_DIRTY` |
| `baselineDigest` stale, or a pre-existing dirty path changed | 409 | `BASELINE_MISMATCH` |
| Absolute, traversal, `.git`, `.agent-deck/`, duplicate, submodule, or symlink path | 422 | `PATH_INVALID` |
| Manifest names a path the run did not change, or omits one it did | 409 | `PATH_UNEXPECTED` |
| A digest or mode differs from the working tree or staged blob | 409 | `DIGEST_MISMATCH` |
| Same key with another body, or another finalization for this run | 409 | `IDEMPOTENCY_CONFLICT` |
| `index.lock` or ref lock held, or another finalization on this repository ref | 409 | `GIT_LOCK_CONFLICT` |
| The ref moved before the compare-and-swap | 409 | `REF_RACE` |
| Canceled before the commit | 409 | `FINALIZATION_CANCELED` |
| Git itself failed (for example no `user.name`/`user.email` on the host repo) | 500 | `FINALIZATION_FAILED` |

**Idempotency.** A run has at most one finalization. The same
`Idempotency-Key` with the same normalized request (manifest order does not
matter) returns the original result — across backend restarts and without
running Git again; a concurrent identical request waits for and shares the
first one's result. Any other request for a finalized or in-progress run is
`409 IDEMPOTENCY_CONFLICT`. A failure before the commit frees the key, so a
corrected retry may reuse it.

**Cancellation.** `POST /api/agent-runs/:runId/cancel`, or the caller
disconnecting, cancels an in-flight finalization up to the moment the ref
moves: the private index and the `index.lock` it created are removed and the
working tree, real index, and ref are untouched (`409 FINALIZATION_CANCELED`).
Once the ref moved the commit stands; cancellation never rewrites history.
Finalizations serialize per repository and ref and fail closed — they never
wait — on a held lock. If the backend dies mid-finalization, the next start
marks it `finalized` when the ref already points at the recorded commit, and
otherwise releases it, removing only the staging files it created.

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

Finalization adds `grant.finalization_enabled` / `grant.finalization_disabled`,
`agent_run.finalization_prepared`, `agent_run.changes_read`, and
`agent_run.finalized` (outcome plus a stable reason code such as
`base_mismatch`, `git_lock_conflict`, or `replayed`). These rows carry a typed
`detail` with only an opaque `repositoryId` (`repo_<hex>`, never the host
path), the baseline and manifest digests, the file count, and the commit and
tree ids when one exists — never file names, contents, or the commit message.

## Not in this API

Push, pull-request creation, merge, branch management, checkout, reset,
clean, and file deletion are deliberately absent: finalization stops at one
local commit, and anything after it is the coordinator's (or owner's) job.

A control plane on one host driving runners on others (runner registration,
scheduling, leases, heartbeats, session migration, remote workspace
provisioning) is a deferred idea; see design §3.3 for the conditions under
which it would be revisited.
