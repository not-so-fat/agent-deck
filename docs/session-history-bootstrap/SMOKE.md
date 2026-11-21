# Session-History Bootstrap — M3 smoke checklist

> **Historical (2026-07-22)** — This record captures an earlier design, proposal, or verification run. See [the current guide](../ARCHITECTURE.md) for shipped behavior.


Human-run E2E gate for milestone M3 (§11). Not CI.

Hosts: digests may be Claude-only, Cursor-only, or mixed (`agent-deck bootstrap --host all`). Matching rule: `workspaceRoot === boundRoot` **or** `workspaceSlug === encodeCursorProjectSlug(boundRoot)` (see PRD F1C.5 / F4.2). Cursor intents must be unwrapped (no `<user_query>` / `<timestamp>` in digest text).

1. Backend + MCP running; deck bound to a workspace that appears in digests
2. `agent-deck bootstrap --workspace <that-root> [--host claude|cursor|all]`
3. Paste handoff into agent chat
4. Confirm ≥3 `create` proposals in dashboard queue
5. Spot-check ≥1 Gotcha/Technique cites a digest `feedbackMoment` that is real user text (not “Briefly inform the user…”)
6. Confirm no playbook auto-registered
