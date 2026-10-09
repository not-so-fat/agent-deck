# MCP session lifecycle (NOT-191)

How Agent Deck tracks an MCP session from handshake to teardown, and which
timer owns each half. Two clocks, two jobs — never mix them:

- **Live-display lease (30 min)** — owns *visibility*: `/api/scope/bindings`,
  the menubar count, and the status line. Lives in the backend
  `LiveDisplayRegistry` (NOT-309).
- **Transport idle TTL (24 h)** — owns *retention* of the in-memory MCP
  transport session. Lives in `AgentDeckMCPServer`.

## Steady state

A heartbeat-capable bridge (`x-agent-deck-bridge-liveness: 1` on every
request) sends an internal MCP `ping` every 5 minutes (jittered, backed off
on failure). The ping consumes its reply inside the bridge — the host never
sees it — and the server counts it as client activity, refreshing both the
transport TTL and the display lease. Legacy clients send no marker and keep
the server-owned 5-minute keep-alive touch instead; those touches never
extend the transport TTL.

## Clean shutdown

1. Host closes stdin → the bridge drains in-flight host requests (bounded).
2. On a full drain it sends one bounded best-effort HTTP `DELETE` with the
   session id, then aborts the SSE stream. A failed delete never hangs or
   fails the shutdown; a timed-out drain sends no delete at all.
3. The server `DELETE` runs the unified cleanup: transport/server entry,
   trusted runtime session (revoking nothing reusable — the grant row stays
   valid), session binding + grant association, badge, live-touch timestamp,
   transport activity, and live-display registration.

A `DELETE` that arrives while a host request is in flight is deferred (HTTP
200, close pending) and runs when the last request lands or the next sweep
finds the session idle. A session is never expired or deleted under running
work.

## Abandoned sessions

Crash, force-quit, or lost process: no more client traffic. The display
entry goes stale within the 30-minute lease and disappears from bindings and
the status line; the transport is swept at most 24 hours after its last
activity (60-second sweep cadence). Expiry answers the spec 404, so a later
pulse or host request re-initializes through the existing session-expired
recovery path on the same effective deck.

## Shutdown and mass expiry

Sweep and server shutdown share one unregister semaphore (8 concurrent
live-display unregisters). Batch failures collapse into a single
`attempted/succeeded/failed` summary line — never one stack trace per
session. `stop()` runs the same unified cleanup per session before
releasing the MCP port.
