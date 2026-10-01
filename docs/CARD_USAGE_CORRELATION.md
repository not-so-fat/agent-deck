# Card usage correlation (NOT-304)

Privacy-safe `card_usage_events` stream (NOT-292) plus one opaque
run-correlation id so an external deterministic coordinator (Agent Dealer)
can match a worker's playbook/service/credential fetches to its own durable
worker session. Epic: NOT-162 (measure playbook discovery usefulness).

## Contract

- Launch-selected MCP sessions may carry `x-agent-deck-correlation-id`
  (constant `AGENT_DECK_CORRELATION_HEADER` in `@agent-deck/shared`).
- The value is **observability metadata only**: it never selects a deck,
  grants access, changes mode, or participates in authorization. It is
  distinct from the trusted `x-agent-deck-session-id` authentication header.
- Validation is strict and shared (`normalizeCorrelationId` /
  `isValidCorrelationId`): a UUID or a bounded token of ASCII letters,
  digits, `-`/`_` only, 8–128 chars. Repository names (`owner/repo`),
  issue titles, prompts, and task content can never validate — invalid
  values are dropped, never coerced or truncated.
- Session binding is **adopt-once**: the first valid value seen for an MCP
  session sticks for the session lifetime; later values (valid or not) are
  ignored. A session without the header records `correlationId: null`, and
  pre-correlation rows stay valid with null.
- Every playbook fetch, service tool-call attempt, and derived credential
  use from that connection persists the same correlation id on
  `card_usage_events.correlation_id` (nullable, indexed with
  `(correlation_id, created_at, id)`). The trusted session bearer is still
  stored only as a one-way hash.

## Read surfaces

- `GET /api/usage/events?correlationId=<id>` — exact match only; anything
  that is not a UUID/strict token is a 400, never a broad match. Stable
  chronological cursor pagination (`occurredAt ASC, id ASC`) is preserved
  within the filtered set. Accepts the existing local-analysis policy.
- MCP `get_card_usage_events({ correlation_id })` — coordinator read for a
  normal launch-selected, bound Deck session. Scoped twice: the caller
  supplies only the correlation id; the bound deck id comes from the
  server-side session binding. Events from another deck are not observable.
  No dashboard authentication. Invalid ids fail without reading anything.
- Public event shape (both surfaces) is an allowlist: `occurredAt`,
  `cardType`, `cardId`, `deckId`, `action`, `success`, `source`,
  `sessionId` (hashed), `correlationId`. No task text, repository identity,
  tool arguments/results, headers, credentials, or secrets.

## Non-goals

Dealer integration, outcome evaluation, automatic playbook proposals, and
any replacement of the trusted session/authentication identifier.
