# Execution authority issuer (NOT-86) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Durable Deck-side enrollment + short-lived execution authority with HTTP + MCP + CLI (cut B).

**Architecture:** Keep `ExecutionAuthorityLedger` as the logic engine; add snapshot export/import + SQLite `ExecutionAuthorityStore`; HTTP `/api/execution-authority/*`; MCP authority principal parallel to grants; CLI `coordinator`.

**Tech stack:** Fastify, better-sqlite3, vitest, existing trusted-session hash helpers.

## File map

| File | Role |
| --- | --- |
| `execution-authority/types.ts` | Enroll secret on result; mint HTTP input with toolScopeHint |
| `execution-authority/ledger.ts` | + enrollment secret hash; export/import state |
| `execution-authority/store.ts` | SQLite durable wrapper |
| `routes/execution-authority.ts` | HTTP API |
| `trusted-session/route-policy-registry.ts` | Route policies |
| `trusted-session/auth.ts` | Optional coordinator/authority principal (mint routes) |
| `mcp-server.ts` / `mcp-session-binding.ts` / `mcp-tools/*` | Authority MCP path |
| `packages/cli/src/coordinator.ts` | enroll/status/revoke |
| `server/index.ts` | Decorate + register |

## Tasks

1. Ledger: enrollment secrets + state snapshot
2. SQLite store + durability test
3. HTTP routes + policies + mint snapshot authorship
4. MCP authority auth + tool enforcement
5. CLI coordinator
6. Integration tests + typecheck
