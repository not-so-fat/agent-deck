# Feedback signals table redesign — Implementation Plan

> **Historical (2026-07-22)** — This record captures an earlier design, proposal, or verification run. See [the current guide](../../ARCHITECTURE.md) for shipped behavior.


> **For agentic workers:** Implement tasks in order. Each task ends with tests green for that slice.

**Goal:** Own `/feedback-signals` data table; statuses `open`/`actioned`/`discarded`; link-on-propose / actioned-on-accept; Copy always includes ids.

**Spec:** `docs/superpowers/specs/2026-07-22-feedback-signals-table-redesign.md` · **PRD:** `docs/PRD_FEEDBACK_ACCUMULATION.md`

## File map

| File | Responsibility |
|------|----------------|
| `packages/shared/src/schemas/feedback-signal.ts` | Status enum + count field rename |
| `packages/backend/src/models/database.ts` | Migration, list/count filters, reopen→open |
| `packages/backend/src/playbooks/patch-manager.ts` | Link-only on propose; actioned on accept |
| `packages/backend/src/routes/feedback-signals.ts` | `excludeInProposal`, count `open` |
| Tests: `patch-manager.test.ts`, `feedback-signals.test.ts` | Lifecycle + API |
| `apps/agent-deck/src/pages/feedback-signals.tsx` | New table page |
| `apps/agent-deck/src/App.tsx` (or router) | Route |
| `apps/agent-deck/src/pages/home.tsx` | Badge → available open + link |
| `apps/agent-deck/src/pages/playbook-patches.tsx` | Remove backlog panel |
| `apps/agent-deck/src/lib/feedback-signals.ts` | Client API + copy prompt |
| `packages/cli/src/agent-harness.ts` | Paste recipe path |
| `packages/backend/src/mcp-tools/register.ts` | Wording |

## Tasks

1. Shared + DB: `unreviewed`→`open`; migrate rows; `count` → `{ open }`; `excludeInProposal` list/count helpers
2. PatchManager lifecycle + unit tests
3. Routes/tests for filters + count
4. Dashboard page + strip patches backlog + home/detail badge
5. Harness/MCP copy; rebuild shared; run backend+cli tests

---

*Plan kept short — design doc owns product detail.*
