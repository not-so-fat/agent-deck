# Cursor MCP diagnostics Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** Ship NOT-54 ADR + NOT-52 read-only Cursor MCP inspector wired into `status` / `use --refresh`.

**Architecture:** Read-only `inspectCursorMcpConfig` in CLI; formatter for humans; `ensureGlobalCursorMcpLaunch` stays the write path for explicit `use` only. ADR documents host contract.

**Tech Stack:** TypeScript, vitest, existing `packages/cli` mcp-config helpers.

## Global Constraints

- Diagnostic paths never write MCP config.
- Never print grant secrets.
- Align messaging with ADR fail-closed rules.

---

### Task 1: Inspector module + tests

**Files:**
- Create: `packages/cli/src/cursor-mcp-inspect.ts`
- Create: `packages/cli/src/cursor-mcp-inspect.test.ts`
- Use: `mcp-config.ts` path/shape helpers

- [x] Write failing tests for missing, valid launch+pin, bare URL (+ mcp_auth_dead_end), stale endpoint, custom, project+global precedence, grant present/absent
- [x] Implement `inspectCursorMcpConfig` + `formatCursorMcpInspection`
- [x] Run `npx vitest run packages/cli/src/cursor-mcp-inspect.test.ts`

### Task 2: Wire status + use --refresh

**Files:**
- Modify: `packages/cli/src/status.ts`
- Modify: `packages/cli/src/use.ts`
- Modify: `packages/cli/src/use.test.ts` if refresh assertions change

- [x] Replace diagnostic `ensureGlobalCursorMcpLaunch()` calls with inspector output
- [x] Keep refresh diagnosis-only exit path
- [x] Run related CLI tests

### Task 3: Docs + CHANGELOG

**Files:**
- Already: `docs/decisions/cursor-mcp-config-resolution.md`
- Modify: `CHANGELOG.md`, `docs/PRD_TRUSTED_AGENT_SESSIONS.md`

- [x] Unreleased bullets for NOT-54 + NOT-52
- [x] PRD pointer to ADR

### Task 4: Verify

- [x] `npx vitest run packages/cli/src/cursor-mcp-inspect.test.ts packages/cli/src/mcp-config.test.ts packages/cli/src/use.test.ts`
- [x] Manual: `agent-deck status` prints inspection without rewriting `~/.cursor/mcp.json` mtime
