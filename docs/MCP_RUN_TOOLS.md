# MCP run tools: `start_run`, `get_run`, `cancel_run`

A bound Agent Deck MCP session — for example an agent that Agent Dealer
launched in a role worktree — can start, observe, resume, and cancel
coding-agent runs through MCP alone. It never executes the `agent-deck` CLI
and never needs to reach the host's loopback ports from its own sandbox.

Tools: `packages/backend/src/mcp-tools/run-tools.ts`. Backend routes:
`/api/trusted-session/agent-runs*` in `packages/backend/src/routes/agent-runs.ts`.
Schemas: `StartSessionAgentRunRequestSchema` and `SessionAgentRunResponseSchema`
in `packages/shared/src/schemas/agent-run.ts`.

## Host-local execution

The run executes **on the Agent Deck host** through the same Agent Run service
as `agent-deck run` and the [HTTP API](./AGENT_RUN_API.md): the same client
adapters, run records, ordered events, cancellation, restart recovery, and
playbook pins. Nothing executes in, clones into, or syncs with the caller's
sandbox.

## Deck and workspace come from the session, not the caller

| | Source | Not from |
|---|---|---|
| Deck | The runtime session's **live** deck — including a human-approved *This session only* `switch_deck` | a tool argument; `.agent-deck/use.json` |
| Workspace (cwd) | The **launch-bound** workspace: the `x-agent-deck-workspace` header on the launch request (or the host's `AGENT_DECK_WORKSPACE`) | a tool argument; `bind_workspace`; `.agent-deck/use.json` |

- `start_run` accepts no `deckId` and no `cwd`; an extra field is rejected
  before any launch.
- The workspace is adopted once per MCP session. `bind_workspace` can change
  the display workspace but never the execution workspace.
- The host directory must still exist (`WORKSPACE_INVALID` otherwise).
- The folder's `.agent-deck/use.json` is neither required nor read nor written
  for this entry point. The CLI and the grant-authenticated HTTP API keep
  their folder-assignment check unchanged.
- Remote-grant MCP sessions carry no trusted host workspace.

Without a launch-bound workspace every run tool fails with
`WORKSPACE_REQUIRED` before any client starts. The agent cannot fix this; the
launcher must provide the workspace when it starts the session.

## Tools

### `start_run`

```json
{ "client": "codex", "prompt": "…", "tools": "edit",
  "resumeSessionId": "…", "prepareFinalization": true,
  "playbookVersion": { "playbookId": "pb_x", "versionId": "…" } }
```

`client` and `prompt` are required; `tools` defaults to `readonly`.
`resumeSessionId` continues an earlier run's `sessionId` (Codex resumes only a
session an Agent Deck run started on the same deck, workspace, and tools).
`prepareFinalization` needs `tools: "edit"` and a clean Git worktree.
`playbookVersion` must name a version of a playbook on the session's deck.
Returns `{ runId, state }`.

### `get_run`

```json
{ "runId": "run-…", "after": "3", "limit": 200 }
```

Returns the public run status (`runId`, `deckId`, `client`, `tools`, `state`,
`sessionId`, `startedAt`, `lastEventAt`, `finalization`) plus `events` — the
next page of ordered events after `after` — and `nextCursor`. Pass
`nextCursor` back as `after`. The state is read before the events, so a
terminal state (`ended`, `error`, `died`, `canceled`) means the terminal event
is already in the log.

### `cancel_run`

```json
{ "runId": "run-…" }
```

Idempotent: canceling a live run records `canceled` and stops its process
group; repeating it, or canceling a finished run, returns the current status
unchanged.

## Scope

`get_run` and `cancel_run` reach a run only when its captured deck **and**
canonical workspace match the caller's current session; otherwise they return
`RESOURCE_OUT_OF_SCOPE`. A reconnected MCP session launched with the same deck
and workspace reaches the same runs. There is no grant, owner, or
multi-user model on this path.

## Not in these tools

Workspace discovery or creation, change manifests and finalization commits
(use the [HTTP API](./AGENT_RUN_API.md#finalization-one-reviewed-manifest--one-local-commit)),
remote runners, and provider capability probes.
