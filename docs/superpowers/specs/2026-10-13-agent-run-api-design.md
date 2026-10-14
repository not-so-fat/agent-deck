# Agent run API — same-host execution design

**Date:** 2026-10-13  
**Status:** Approved for API ticketing  
**Scope:** Agent Deck backend API with coding agents on the Agent Deck host  
**Future idea:** Agent Deck control plane and coding-agent runner on different hosts

## 1. Value and decision

An authenticated coordinator can start, observe, cancel, and continue a coding-agent run through Agent Deck without shelling out to the Agent Deck CLI or reading host files.

The first API executes Codex, Claude, Cursor, or Muse on the **same host as Agent Deck**. It reuses the shipped `agent-deck run` semantics and deck-binding gate. Separating the Agent Deck control plane from a remote execution runner is intentionally documented but is not part of this implementation phase.

## 2. Existing substrate

Agent Deck already ships the execution behavior that the API needs:

- `packages/cli/src/run.ts` owns the run lifecycle, normalized JSONL events, `meta.json`, deck-binding validation, and tool-profile selection.
- `packages/cli/src/run-<client>.ts` owns each coding-agent adapter and its preflight, launch, resume, and result normalization.
- `packages/cli/src/run-status.ts` reads run status and logs without requiring callers to parse files.
- `packages/cli/src/run-detach.ts` keeps a run alive after the launching shell disconnects.
- `packages/backend/src/auth/client-grants.ts` and trusted-session policy provide remote authentication and deck allowlisting.
- The personal hosted appliance already defines one owner, one Agent Deck installation, and authenticated remote clients.

> **Compatibility note (NOT-479, slice 1).** The run service now lives in the backend package as `@agent-deck/backend/agent-run` (`packages/backend/src/agent-run/`), because the CLI already depends on the backend and the backend cannot depend on the CLI. It owns the binding gate, Claude probe, adapters, `meta.json`/JSONL records, and status/event reads; the CLI keeps argument parsing, console output, the prompt file, and `--detach`. Hosts inject `resolveDeck` and a read-only `resolveDeckBinding(cwd)`; the CLI supplies its collection lookup and folder assignment reader, and the backend must supply equivalents in slice 2. Two details for slice 2: validation and adapter remedies are still CLI-worded (they name `--cwd`, `--tools`, `agent-deck use`), so the HTTP layer should map them to API errors rather than echo them; and `status`/`events` resolve only default-location runs (`<home>/runs/<runId>/`), since a CLI `--log` elsewhere is not indexed.

> **As-built note (NOT-480, slice 2).** Shared Zod schemas live in `packages/shared/src/schemas/agent-run.ts`; routes in `packages/backend/src/routes/agent-runs.ts` only validate, authorize, dispatch to the slice-1 service's non-blocking `launch`, and map results.
> - **States.** `starting` (launch acknowledged: the run record exists but no event is logged yet), `running`, `ended`, `error`, `died`. `canceled` waits for NOT-481 (now shipped; see below).
> - **Run capability.** Grants carry `runsEnabled` (default `false`, so existing grants stay MCP-only). The owner toggles it with `PUT /api/agent-grants/:id/capabilities` `{ runsEnabled: boolean }`, which audits `grant.runs_enabled` / `grant.runs_disabled`. `allowedDecks` still applies to every create and read.
> - **Errors.** Auth failures use the trusted-session codes: `GRANT_REQUIRED` (401: missing, malformed, revoked, or expired bearer), `RUN_CAPABILITY_REQUIRED` (403), and `RESOURCE_OUT_OF_SCOPE` (403: deck not allowed). Run codes: `INVALID_REQUEST` 400, `REQUEST_TOO_LARGE` 413, `IDEMPOTENCY_KEY_REQUIRED` 400, `IDEMPOTENCY_CONFLICT` 409, `DECK_NOT_FOUND` 404, `WORKSPACE_INVALID` / `WORKSPACE_MISMATCH` 422, `CLIENT_UNAVAILABLE` 503, `PROFILE_UNSUPPORTED` 422, `RESUME_UNVERIFIED` 422 (a codex `resumeSessionId` that no matching Agent Deck run on this host started; NOT-484 provenance), and `RUN_NOT_FOUND` 404. Messages are API-worded and never echo CLI remedies.
> - **Bounds.** Prompt ≤ 64 KiB of characters; body ≤ 256 KiB; events page ≤ 1000 (default 200). In hosted mode, mutations share the per-client mutation limit, and failed run bearers (401) on any method are limited per socket client, so anonymous reads cannot grow the audit table without bound.
> - **Read scope.** Reads are deck-scoped, not grant-scoped: any run-enabled grant allowed on a run's deck can read that run's status and events, including runs another grant started. Per-grant run ownership is an open product decision.
> - **Deferred.** Capability discovery (§4.1) and cancellation (§4.4) are not implemented in this slice.

> **As-built note (NOT-481, slice 3).** Supported caller documentation: [`docs/AGENT_RUN_API.md`](../../AGENT_RUN_API.md); operator smoke record: [`docs/superpowers/smoke/2026-10-13-not-481-agent-run-api-smoke.md`](../smoke/2026-10-13-not-481-agent-run-api-smoke.md). Everything still executes on the Agent Deck host; §3.3 remains a deferred idea.
> - **Capabilities.** `GET /api/agent-runs/capabilities` returns `{ host: "same-host", clients }`, listing only clients whose launch preflight passes now (Claude also needs `claude auth status`). Each entry states `start` and `resume` profiles and `resumeRequires`: `same_profile_provenance` for codex (NOT-484), `none` otherwise. Static per-client profiles live in `RUN_CLIENT_PROFILES` (`agent-run/adapter.ts`).
> - **Process ownership.** Backend launches pass `ownProcessGroup`, so codex/cursor/muse spawn as process-group leaders and the group id is recorded in `meta.json` (`pgid`, `pgidStartedAt`); the Claude SDK gets an `AbortController`. CLI runs are unchanged (foreground clients still receive ^C).
> - **Cancel.** `POST /api/agent-runs/:runId/cancel` appends a terminal `canceled` log line, persists `state: canceled`, then signals only the recorded group (SIGTERM, SIGKILL after 5 s). The stream records nothing afterwards, and the events route stops at `canceled`. A terminal run returns its state unchanged; `409 RUN_NOT_CANCELABLE` covers a run live under another process without a recorded group.
> - **Reconciliation.** `reconcileRunState` (`agent-run/records.ts`) is the one state derivation for status reads and for the startup pass: `canceled` line → `canceled`; recorded terminal state stands; live owner → `running`; otherwise `error` line → `error`, `end` after a `success` result whose receipt matches `meta.deckName` → `ended`, other `end` → `error`, nothing terminal → `died`. At route registration the backend persists those results for every `running` record it does not own and signals orphaned groups; on close it stops its own groups without recording an outcome.
> - **Read scope (supersedes slice 2).** Status, events, and cancel are grant-scoped: a grant reaches only runs it created, on decks it is still allowed (`403 RESOURCE_OUT_OF_SCOPE` otherwise). The owner dashboard (`requireRunGrantOrDashboard`) can inspect and cancel every run; only grants start runs.
> - **Audit.** `agent_run.canceled` (reason `already_terminal` on a repeat), `agent_run.reconciled` (`run_died`, `run_error`, `run_canceled`), and `agent_run.denied` with `run_not_cancelable`; identifiers only.

> **As-built note (NOT-486, finalization).** Caller contract: [`docs/AGENT_RUN_API.md` § Finalization](../../AGENT_RUN_API.md#finalization-one-reviewed-manifest--one-local-commit). Policy (which reviewed manifest, review id, message) stays with the caller; Agent Deck owns only the mechanism and exposes no Git command surface.
> - **Baseline.** `prepareFinalization: true` (edit only) runs a host `beforeStart` gate in the run service after every launch gate and immediately before the run record and adapter start; it fails closed as `FINALIZATION_INVALID` (non-Git cwd, unborn HEAD, non-branch symbolic ref) or `INDEX_DIRTY`. The private baseline (repo root, git dirs, ref, base commit, and each pre-existing dirty path's content state) lives in `agent_run_baselines`; status shows only `finalization: { baselineRef, baselineDigest, state, commit }`.
> - **Capability.** Grants carry `finalizationEnabled` (default `false`, migrated off for existing grants), toggled by `PUT /api/agent-grants/:id/capabilities` independently of `runsEnabled` (`grant.finalization_enabled` / `_disabled`). `/changes` and `/finalize` are `requireRunGrant` routes scoped to the creating grant; `/finalize` also requires `finalizationEnabled` (`403 FINALIZATION_CAPABILITY_REQUIRED`).
> - **Mechanism.** `agent-run-api/git-finalize.ts`: Git with `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `GIT_OPTIONAL_LOCKS=0`, and redirecting `GIT_*` variables stripped. Finalize takes the real `index.lock` (O_EXCL), copies the index to a private file, re-derives the candidate snapshot under the lock, requires manifest equality, stages via `hash-object --no-filters --stdin` from bytes whose SHA-256 was just verified plus `update-index --index-info`, re-reads `diff-index --cached` and every staged blob, `commit-tree -p expectedBaseCommit`, then `update-ref <ref> <new> <expectedBaseCommit>`. Only after the ref moves does the private index replace the real one through the held lock. `.agent-deck/` is reserved (never a candidate, never committable); symlinks, submodules, and nested repositories fail closed as `PATH_INVALID`.
> - **Idempotency and recovery.** `agent_run_finalizations` allows one finalization per run and one per `(grant, Idempotency-Key)`, keyed by a hash of the normalized request; pre-commit failures release the claim. The pending commit and public result are recorded before `update-ref`, and the created lock's inode after locking, so startup recovery marks the run `finalized` when the ref already points there and otherwise releases it, deleting only its own private index and lock.
> - **Cancellation.** Run cancel (and caller disconnect) aborts an in-flight finalization at checkpoints up to the commit object; after the ref moves it is ignored.
> - **Audit.** `AuditEntry` gains an optional typed `detail` (opaque `repositoryId`, baseline/manifest digests, file count, commit, tree), sanitized by pattern on write and read so no path, name, message, or content can be stored.
> - **Out of scope (unchanged).** Push, PR creation, merge, branch management, checkout, reset, clean, file deletion, remote runners.

The missing boundary is a backend-owned run service and authenticated HTTP contract. Today `agent-deck run` is a local CLI process with host-local `cwd`, PID, log, and metadata state. The backend exposes no run lifecycle routes.

## 3. Concrete flows

### 3.1 Remote coordinator, same-host executor

1. The owner installs Agent Deck and a supported coding-agent CLI on one host and signs that CLI in.
2. The owner gives a coordinator, such as Botmancers, a revocable Agent Deck grant that explicitly allows agent runs and selected decks.
3. The coordinator submits a run naming an allowed deck, a coding-agent client, an absolute working directory on the Agent Deck host, a prompt, and a tool profile.
4. Agent Deck validates the grant, deck, working-directory assignment, client preflight, and request idempotency before launching model work.
5. Agent Deck returns an opaque `runId` immediately. The coordinator reads status and ordered events through HTTP.
6. A later continuation creates a new run with the prior opaque `sessionId`. Client-specific resume restrictions remain explicit and fail closed.
7. Cancellation stops the host process group and records a terminal canceled event. The coordinator never needs a host PID or log path.

### 3.2 Local CLI compatibility

The existing CLI remains supported. Its command shape, normalized events, and per-client permission behavior stay compatible. The CLI and HTTP routes must use one host-local execution service so fixes do not drift between two run implementations.

The CLI is still the local operator surface; the API is the integration surface. Botmancers and other products must not invoke the CLI over SSH or infer private run-file paths.

### 3.3 Future remote runner idea

A later design may split Agent Deck into a control plane and an outbound-connected runner colocated with the coding agent and repository. In that topology the API contract remains the coordinator boundary, while run placement, workspace identity, leases, heartbeats, and session affinity move behind a worker protocol.

This phase does **not** add runner registration, scheduling, leases, host selection, remote workspace provisioning, or session migration.

Revisit the runner design when any of these becomes a real requirement:

- Agent Deck cannot be installed on the coding-agent host.
- One Agent Deck installation must schedule across multiple execution hosts.
- A coding session must survive or move across host replacement.
- Raw host paths are no longer an acceptable workspace identifier.

## 4. HTTP contract

All identifiers are opaque. The API never returns host PIDs, private log paths, coding-agent credentials, or deck secrets.

### 4.1 Capability discovery

`GET /api/agent-runs/capabilities`

Returns the coding-agent clients available on the Agent Deck host and stable restrictions relevant to callers, including whether start and resume support `readonly` and `edit`. Availability is based on the same real preflight used by the CLI, not merely on a configured client name.

### 4.2 Start or continue

`POST /api/agent-runs`

```json
{
  "deckId": "deck-id",
  "client": "codex",
  "cwd": "/host/path/to/repository",
  "prompt": "Implement the accepted change.",
  "tools": "edit",
  "resumeSessionId": "optional-opaque-session-id"
}
```

- `client` is one of the shipped run adapters.
- `tools` is explicit and defaults to `readonly` only when omitted.
- `cwd` is always interpreted on the Agent Deck host. Its `.agent-deck/use.json` assignment must match `deckId`; the API never rewrites the assignment.
- `resumeSessionId` creates a new run that continues the session when that client can enforce the requested profile. Unsupported combinations fail before model work.
- The request carries an `Idempotency-Key`. Repeating the same key and body returns the original run; reusing the key with another body returns `409`.
- Success returns `202` with `{ runId, state }`.

### 4.3 Observe

- `GET /api/agent-runs/:runId` returns stable lifecycle state, client, deck, tools, timestamps, and opaque `sessionId` when known.
- `GET /api/agent-runs/:runId/events?after=<cursor>` returns ordered normalized events and a next cursor. A bounded long-poll or SSE representation may be added without changing event semantics.
- Terminal states are `ended`, `error`, `died`, and `canceled`. `running` is never inferred as success merely because launch was acknowledged.

The existing normalized event meanings remain the source: `text`, `tool`, `notice`, `result`, `end`, and `error`. Cancellation adds a terminal `canceled` event rather than disguising operator cancellation as an execution error.

### 4.4 Cancel

`POST /api/agent-runs/:runId/cancel`

Cancellation is idempotent. It terminates the owned process group, records the terminal state, and prevents further result delivery. Canceling an already terminal run returns its terminal state without changing history.

## 5. Authorization and safety

- Remote execution is an explicit grant capability; existing MCP-only grants do not gain model-spend or filesystem authority automatically.
- A run-enabled grant remains constrained to its `allowedDecks`.
- `edit` is explicit per run. The API does not upgrade a resumed session beyond permissions the adapter can enforce.
- The existing deck-binding check prevents a request from pairing an arbitrary host path with another deck.
- Prompt size and request body size are bounded before launch.
- Run creation, denial, cancellation, and terminal outcome are audited without prompts, results, credentials, authorization headers, or filesystem contents.
- Hosted deployments report no available clients unless the backend host really has the client installed and authenticated.

## 6. Ownership boundary

Agent Deck owns one execution attempt: authentication, preflight, launch, observation, cancellation, and continuation of an explicitly named session.

The caller owns workflow policy. Agent Deck does not automatically compose implementation, review, and revision; does not decide whether reviewer feedback is sufficient; and does not wake another agent. Tank or another coordinator decides which run to start next.

## 7. Persistence and recovery

The API and CLI use one canonical run record. A backend restart must reconcile a recorded `running` run against the host process and normalized event log, producing `running`, `died`, or a terminal state without inventing success.

Run metadata must retain the request identity needed for authorization and idempotency, but not the bearer secret. Existing JSONL events may remain the canonical detailed log for this phase; any SQLite index is a lookup/cache, not a second event history.

Retention is an operator policy and does not alter run semantics. Deleting expired run evidence is separate from canceling a run.

## 8. Delivery slices

1. Extract the shipped CLI lifecycle and client adapters behind one host-local execution service used by both CLI and backend.
2. Add shared schemas, run-capable grant authorization, idempotent start/resume, status, and ordered event reads.
3. Add capability discovery, cancellation, restart reconciliation, audit coverage, and same-host API smoke evidence.
4. Integrate consuming products after the Agent Deck contract is proven independently.

## 9. Non-goals

- Remote runner registration or a worker protocol.
- Scheduling across multiple coding-agent hosts.
- Repository cloning, worktree creation, or workspace synchronization.
- Session migration between hosts.
- A fixed implementation/review/revision workflow.
- A new prompt language or parsing instructions from model prose.
- Silent fallback from the API to SSH or caller-side CLI execution.
- Multi-user SaaS tenancy, billing, quotas, or horizontal scaling.

## 10. Exit predicate

From an authenticated client process that is not shelling out to Agent Deck, an owner can start a run through HTTP on a run-enabled deck grant, observe its ordered events to a truthful terminal state, continue a supported session with the unchanged opaque session ID, cancel an in-flight run, and recover accurate status after an Agent Deck backend restart. The coding-agent process and repository are on the Agent Deck host, and existing CLI behavior remains compatible.
