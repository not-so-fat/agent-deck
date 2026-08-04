# Playbook Patch Supersede Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents replace an open playbook proposal with a better one via `supersedes`, without stacking duplicate review work.

**Architecture:** Extend propose schema + patch status with `superseded` / `supersededBy`; PatchManager transfers linked signals; `get_playbook` returns compact `openPatches`; harness + dashboard surface the lineage.

**Tech Stack:** TypeScript, Zod, SQLite (better-sqlite3), Vitest, Fastify, MCP register, React dashboard.

**Spec:** `docs/superpowers/specs/2026-08-04-playbook-patch-supersede-design.md`

## Global Constraints

- No backend LLM; agent judges “same issue”
- Human reject/stale still unlink signals; supersede re-links to successor
- No new feedback list MCP tools
- Genesis supersede out of scope
- Same `supersedes` field for all producers (IDE harness is primary)
- History: add `superseded` filter alongside rejected/accepted (same resolved family)

## File map

| File | Role |
|------|------|
| `packages/shared/src/schemas/playbook-patch.ts` | status enum, `supersedes` on propose, `supersededBy` on patch type, result `superseded` |
| `packages/backend/src/models/database.ts` | column `superseded_by`, map/update helpers, list proposed by playbook, re-link signals |
| `packages/backend/src/playbooks/patch-manager.ts` | supersede on propose |
| `packages/backend/src/playbooks/patch-manager.test.ts` | SC-1..3 tests |
| `packages/backend/src/routes/playbooks.ts` (or equiv) | attach `openPatches` on GET |
| `packages/backend/src/mcp-tools/register.ts` | pass `supersedes` |
| `packages/cli/src/agent-harness.ts` | harness Update-case guidance |
| `apps/agent-deck/src/pages/playbook-patches.tsx` | status filter + badge + superseded_by display |

---

## Task 1: Shared schema

- [x] Add `superseded` to `PlaybookPatchStatusSchema`
- [x] Add optional `supersedes` to `ProposePlaybookPatchSchema` (`pp_*` ids)
- [x] Add `supersededBy: string | null` to `PlaybookPatch`
- [x] Add `superseded?: string[]` to `ProposePatchResult`
- [x] Export any new open-patch summary type if needed

## Task 2: DB + PatchManager (TDD)

- [x] Failing tests: supersede same lesson; leave independent; signal re-link; reject still unlinks; bad id / wrong playbook → error
- [x] `addColumnIfMissing('playbook_patches', 'superseded_by', 'TEXT')`
- [x] `markPlaybookPatchSuperseded(id, successorId)` + `listProposedPatchesForPlaybook`
- [x] `relinkSignalsForPatch(fromPatchId, toPatchId)`
- [x] In `propose`, after creating new patch, process `supersedes`

## Task 3: get_playbook openPatches (TDD)

- [x] GET `/api/playbooks/:id` includes `openPatches` compact array
- [x] MCP `get_playbook` returns it via existing API passthrough

## Task 4: MCP + harness + dashboard

- [x] MCP `propose_playbook_patch` accepts/forwards `supersedes`
- [x] Harness: check `openPatches`, pass `supersedes` when same lesson
- [x] Dashboard: Superseded filter, badge, show `supersededBy` link text

## Task 5: Verify

- [x] Backend patch-manager + stub-sync + playbook-patches + CLI harness tests
- [x] proposed list excludes superseded (status filter)
