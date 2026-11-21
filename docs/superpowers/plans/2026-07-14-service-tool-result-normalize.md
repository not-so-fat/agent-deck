# Service Tool Result Normalize — Implementation Plan

> **Historical (2026-07-14)** — This record captures an earlier design, proposal, or verification run. See [the current guide](../../ARCHITECTURE.md) for shipped behavior.


> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** Surface in-band MCP tool errors as `success: false` (with Slack Connect hint) and spill binary/oversized tool results to `~/.agent-deck/tool-results/`.

**Architecture:** Pure `normalizeServiceToolResult` after `mcpClient.callTool` in `ServiceManager.callServiceTool`. Optional `hint` on error details. Compact `toolResult` JSON.

**Tech Stack:** TypeScript, Vitest, Node `fs`/`path`, existing `@agent-deck/shared` schemas.

**Spec:** [2026-07-14-service-tool-result-normalize-design.md](../specs/2026-07-14-service-tool-result-normalize-design.md)

---

### Task 1: Schema — optional `hint`

**Files:**
- Modify: `packages/shared/src/schemas/service.ts`
- Modify: `packages/shared/src/types/service.ts`
- Modify: `packages/backend/src/lib/mcp-connection-error.ts`

- [x] Add `hint: z.string().optional()` to `ServiceToolErrorDetailsSchema`
- [x] Add `hint?: string` to the TypeScript interface(s)

### Task 2: Normalizer + unit tests (TDD)

**Files:**
- Create: `packages/backend/src/lib/normalize-service-tool-result.ts`
- Create: `packages/backend/src/lib/normalize-service-tool-result.test.ts`

- [x] Write failing tests for: passthrough, Slack `file_not_found` hint, non-Slack no hint, base64/oversize spill
- [x] Implement `normalizeServiceToolResult({ result, service, toolName, spillDir? })`
- [x] Run vitest for the new file until green

### Task 3: Wire `callServiceTool`

**Files:**
- Modify: `packages/backend/src/services/service-manager.ts`
- Modify: `packages/backend/src/services/service-manager.test.ts`

- [x] After successful `mcpClient.callTool`, return `normalizeServiceToolResult(...)`
- [x] Add test: mocked `isError` Slack result → `success: false` + hint
- [x] Confirm transport `catch` path unchanged

### Task 4: Compact `toolResult`

**Files:**
- Modify: `packages/backend/src/mcp-server.ts`

- [x] Change `JSON.stringify(data, null, 2)` → `JSON.stringify(data)`

### Task 5: Verify

- [x] Run backend unit tests for touched files (26 passed)
- [x] Type-check backend; boot + `/health` (dev)
