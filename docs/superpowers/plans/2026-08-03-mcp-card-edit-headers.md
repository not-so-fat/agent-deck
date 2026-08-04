# MCP card edit headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users view and edit remote MCP `service.headers` on the service details card (always visible), saving via existing `PUT /api/services/:id`.

**Architecture:** Pure helpers in frontend `lib/service-headers.ts` (parse + mask). `service-details-modal.tsx` always shows Custom Headers for remote `mcp`. On header save, backend `updateService` invalidates the cached MCP client so the new token is used.

**Tech Stack:** React, Vitest, existing `apiRequest` + Fastify service routes.

## Global Constraints

- Invalid JSON / non-string map: frontend blocks submit (inline error, no PUT).
- Remote `mcp` only for this section; OAuth / local-mcp unchanged.
- No new API endpoints; no credential-vault flow in v1.
- Spec: `docs/superpowers/specs/2026-08-03-mcp-card-edit-headers-design.md`

---

## File map

| File | Responsibility |
|------|----------------|
| `apps/agent-deck/src/lib/service-headers.ts` | parseHeadersJson, maskHeaderValue, formatHeadersForEditor, hasCustomHeaders |
| `apps/agent-deck/src/lib/service-headers.test.ts` | Unit tests for parse/mask/visibility helpers |
| `apps/agent-deck/src/components/service-details-modal.tsx` | Always-visible view/edit UI + Save/Cancel |
| `packages/backend/src/services/service-manager.ts` | Invalidate MCP client when `headers` updated |

---

### Task 1: Helpers + tests

- [x] Add `service-headers.ts` with parse (null on invalid), mask (Bearer prefix preserve), format, hasCustomHeaders
- [x] Add `service-headers.test.ts` covering invalid JSON (no ok), empty `{}`, mask Authorization, hasCustomHeaders null/empty
- [x] Run `npm test` in `apps/agent-deck` for those tests

### Task 2: Details modal UI

- [x] For `apiService.type === 'mcp'`, always render Custom Headers under Endpoint
- [x] View: masked list or empty state; badge only when non-empty; Edit opens editor
- [x] Edit: JSON textarea prefilled; Save validates then PUT; Cancel discards
- [x] On success: update local service, invalidate queries

### Task 3: Invalidate MCP client on header update

- [x] In `ServiceManager.updateService`, if `headers` present in input and `type === 'mcp'`, call `mcpClient.invalidateClient(id)`
- [x] Add/adjust unit test in `service-manager.test.ts`

### Task 4: Verify

- [x] Frontend vitest green; backend service-manager test green
