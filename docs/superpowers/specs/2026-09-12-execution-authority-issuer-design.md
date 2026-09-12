---
status: accepted
linear: NOT-86
parent_contract: docs/superpowers/specs/2026-09-12-trusted-unattended-execution-contract-design.md
deferred: NOT-89, NOT-90, NOT-87
---

# Execution authority issuer (Agent Deck) — NOT-86

**Accepted approach:** Promote the NOT-85 in-memory ledger behind a dedicated `ExecutionAuthorityStore` (SQLite), expose contract HTTP APIs, authenticate MCP with short-lived execution authority as a **separate principal** from path-bound workspace grants, and ship CLI enroll/status/revoke. Process-local one-time secret delivery for smoke/Dealer; OS launcher → [NOT-89](https://linear.app/not-so-fat/issue/NOT-89); dashboard UX → [NOT-90](https://linear.app/not-so-fat/issue/NOT-90).

## Scope (cut B)

| In | Out |
| --- | --- |
| Durable enrollments, authorities (hash-only secrets), audit | OS launcher / keychain ([NOT-89](https://linear.app/not-so-fat/issue/NOT-89)) |
| HTTP: enroll/revoke/get, mint/inspect/revoke, audit, safe deck metadata | Dashboard enroll UI ([NOT-90](https://linear.app/not-so-fat/issue/NOT-90)) |
| MCP init + tools authenticated by authority id+secret; immutable tool snapshot | Dealer park/queue ([NOT-87](https://linear.app/not-so-fat/issue/NOT-87)) |
| CLI `coordinator enroll\|status\|revoke` | Replacing interactive grants |
| Integration tests: restart, remint, expire, revoke, out-of-scope, `INTERACTION_REQUIRED` | Multi-user / remote coordinators |

## Architecture

```
CLI (operator) ──trusted writer──► POST /enrollments  (returns enrollmentSecret once)
Coordinator    ──enr_…:enrollmentSecret──► POST /authorities (mint)
Worker MCP     ──authz_…:authoritySecret──► MCP tools (snapshot enforced)
```

- **Store:** `packages/backend/src/execution-authority/` — ledger logic + SQLite persistence; same DB lifecycle as trusted sessions when possible, separate module/tables.
- **Enrollment secret:** one-time `enrollmentSecret` (`enrs_…`) on enroll; hash at rest; Bearer `enr_…:secret` for coordinator mint/metadata/audit. Never re-issued; lose it → revoke + re-enroll.
- **Mint:** Deck authors `allowedServices` / `allowedTools` from current deck policy; optional `toolScopeHint` only narrows.
- **Authority secret:** returned once on first mint; stored as hash; remint returns `secretIssued: false`. Delivery = process-local (env / test harness); not worktree files. OS launcher → [NOT-89](https://linear.app/not-so-fat/issue/NOT-89).
- **MCP:** authority principal never gets agent-admin, dashboard, trusted-writer, or direct playbook mutation. Control-plane ops return `INTERACTION_REQUIRED` immediately.
- **Interactive grants:** unchanged.

## API

Per parent contract §11 (`/api/execution-authority/...`).

## Verification

- Unit: durable store round-trip + ledger scenarios (existing tests adapted).
- Integration: enroll → mint → one allowed MCP tool → deny OOS → expire/revoke → audit; restart inspect without secret in Dealer state.
- `npm run typecheck` + package tests + smoke as required by repo rules.
