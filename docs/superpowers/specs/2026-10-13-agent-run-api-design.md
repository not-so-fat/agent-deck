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
