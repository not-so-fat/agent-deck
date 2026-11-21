# Architecture Revisit — Triggering × Learning Loop

> **Historical (2026-07-11)** — This record captures an earlier design, proposal, or verification run. See [the current guide](../../ARCHITECTURE.md) for shipped behavior.


**Date:** 2026-07-11 · **Status:** Draft for review · **Source:** Obsidian `2026-07-11 Agent Deck — Architecture Revisit — Triggering × Learning Loop`  
**Related:** [learning-loop proposal queue](./2026-07-11-playbook-learning-loop-design.md), [security + CI](./2026-07-06-security-hardening-and-ci-design.md), [DIRECTION.md](../../DIRECTION.md)

> **One-line:** Option A (per-deck endpoint) survives the revisit and gets *stronger* on the learning loop — but it's blind on **implicit** triggering. Recommended synthesis: **A′** — deck endpoint as source of truth + compiled *thin trigger stubs* that borrow the host's native skill-discovery machinery.

---

## 1. Why revisit

The learning-loop review found triggering is half the problem: lessons written into playbooks that never fire are lessons lost twice (~2/18 playbooks ever updated despite daily corrections). Per-deck MCP (07-08 note) claimed "playbooks as prompts → native slash commands." That holds for **explicit** triggering only — not the implicit path that feeds the loop.

## 2. Two trigger modes (do not conflate)

| Mode | What happens | Who initiates | Host machinery |
|---|---|---|---|
| **Explicit** | User invokes playbook by name (`/priority-summary`) | Human | MCP prompts → slash commands (Claude Code, Cursor 1.6+) |
| **Implicit** | Agent recognizes mid-task that a playbook applies | Model | **Not MCP prompts** — hosts use **skills/rules** (description-matched, auto-surfaced) |

Today's implicit path: harness prose "check `triggers` on `get_bound_deck`" — agent must *remember* to look. That's the memory-dependent-trigger bug. **Explicit was never the problem; implicit is where corrections get lost** (sessions that should run under a playbook don't → update-loop precondition never true).

## 3. Options

### A — Per-deck endpoint, pure MCP

- Explicit: ✅ MCP prompts
- Implicit: ⚠️ prose / server `instructions` only
- Learning loop: ✅ propose queue + telemetry on live endpoint
- Blind spot: prompts are explicit-only

### B — Compiler (full body → host skill files)

- Implicit: ✅✅ native skill discovery
- Learning loop: ❌ split source of truth; patches need file re-sync; no telemetry

### A′ — Hybrid (recommended) ✅

Deck endpoint unchanged as knowledge/learning layer. `agent-deck use` writes **thin stubs** (~5 lines each): name, `description:` = playbook triggers, body = pointer to `get_playbook(pb_x)` + `propose_playbook_patch` on correction.

- Explicit: ✅ stub name + MCP prompts
- Implicit: ✅ host description matching — model doesn't remember the deck
- Learning loop: ✅ bodies always live on deck; stubs are pointers only — **accepted patches need no file sync**
- Rule revision: **never mirror bodies — always generate pointers**

### C — Status quo hardened

Prose-dependent both modes; loop keeps starving. Stopgap only.

## 4. Comparison

| | Explicit | Implicit (feeds loop) | Capture channel | Single SoT | Telemetry | Staleness |
|---|---|---|---|---|---|---|
| **A** | ✅ prompts | ⚠️ prose | ✅ | ✅ | ✅ | ✅ none |
| **B** | ✅ files | ✅✅ native | ❌ | ❌ | ❌ | ❌ silent |
| **A′** | ✅ both | ✅ stubs | ✅ | ✅ | ✅ | ⚠️ stubs only |
| **C** | ⚠️ prose | ❌ prose | ✅ | ✅ | ❌ | ✅ |

## 5. Dealer + context + switching

### 5a. Three trigger surfaces

| Surface | Who names playbook | Mechanism |
|---|---|---|
| Human (IDE) | You | Slash (stub or MCP prompt) |
| Host (IDE) | Skill matcher | Stub `description:` → fetch body |
| Dispatcher (dealer) | Plan step | `playbookId` in run prompt (works today) |

Dealer gap: tasks without `playbookId` run bare. Fix: **plan-draft trigger match** from deck trigger summaries (REST) — human-auditable before execution.

### 5b. Multi-job workspace

- Stub union is cheap (~450 tokens for 30 playbooks); **tool schema union** is the contamination risk.
- **Now:** union + measure via `playbook_events`
- **(ii) Later:** stable workspace URL `/mcp/workspace/<id>`, hot-swappable deck behind it, `tools/list_changed`
- **(iii) Endgame:** context follows playbook `dependsOnServiceIds` — trigger match switches tool exposure

### 5c. Connection model — one URL per workspace, not one per deck

"Per-deck endpoint" is **server address space**, not user connection work:

- Workspace `.mcp.json` has **exactly one** agent-deck entry, written by `agent-deck use <deck>` — connecting is a side effect of assigning.
- With 5b(ii): entry is a **stable workspace URL** (`/mcp/workspace/<id>`); re-assigning a deck is server-side only — no host config rewrite.
- N decks ≠ N connections: session sees one deck; others don't exist for that host.
- Dealer connects programmatically per run (no user act).
- Multiple entries only for deliberate interim knob (two decks toggled in one workspace).

**User mental model:** *assign a deck to a place; the place is connected.* URLs are plumbing.

## 6. Build order (with learning-loop spec)

1. **Proposal queue** ([learning-loop spec](./2026-07-11-playbook-learning-loop-design.md)) — propose-first, evidence, `playbook_events` telemetry. Required by A and A′.
2. **Security foundation** ([security spec](./2026-07-06-security-hardening-and-ci-design.md)) — loopback MCP, CI golden paths. Shipped.
3. **A′ stubs + `agent-deck use`** — implicit triggering; regenerate on use / patch-accept (trigger changes only).
4. **Per-deck or workspace endpoint** — re-exported schemas; meta-tool removal; optional stable workspace URL (5b ii).

## 7. Open questions (verify before A′ commit)

- [ ] MCP server `instructions` — injected into context per host?
- [x] Cursor stub format: `.mdc` with `description:` = triggers, `alwaysApply: false` (pointer body only)
- [x] Stub lifecycle: regenerate on `use` / `use --refresh`, clean orphans on deck switch; patch-accept returns refresh hint
- [ ] Tool-count with many re-exported schemas
- [ ] `tools/list_changed` behavior in Cursor (descriptor cache risk)

## 8. Verdict

Learning-loop decisions make Option A *more* necessary (proposal queue, item deltas, telemetry). The 07-08 note solved explicit triggering only. **A′ synthesis:** deck owns knowledge and learning; host skill discovery owns noticing; generated pointer-stubs connect them without duplicating procedure bodies.
