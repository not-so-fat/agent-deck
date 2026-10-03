# Product Direction — agent_deck + agent-dealer

**Date:** 2026-07-05 · **Status:** Accepted · **Scope:** cross-product (this repo + [agent-dealer](https://github.com/not-so-fat/agent-dealer))

This doc is the single owner of *direction*: what the two products are, which decisions are locked, and what order to build in. Repo-level docs ([MVP.md](./MVP.md), agent-dealer's `docs/`) own behavior details; when they conflict with older PRDs, as-built docs win. Supersedes the direction fragments scattered across PRDs, OAuth docs, and ADRs (see appendix).

---

## 1. Thesis

One user, working with agents on everything, where every run makes the next run better.

- **agent_deck** owns **what the agent knows**: decks of MCP servers, Keychain-backed keys, and playbooks — context and capability scoped per job, under the user's control. It is the knowledge layer; it never executes.
- **agent-dealer** owns **what runs**: the queue of small/mid daily tasks, human plan approval, agent execution (Claude/Cursor CLI), review, and the audit record. It is the execution layer; it never stores knowledge or secrets — it passes `deckId`/`playbookId` through.

The seam between them is the **learning loop**: dealer runs consume playbooks via deck MCP, and feed lessons back via `update_playbook`. That loop — not the queue, not the proxy — is the reason these are two halves of one product.

**One tagline** (replaces the three in circulation — README "self-improving skills", server.json "MCP proxy", package.json "browser for agents"):

> *Agent Deck: switch what your agent knows — decks of tools, keys, and self-improving playbooks. Agent Dealer: run your day through it.*

## 2. Decisions (locked)

### D1 — The word is "playbooks", everywhere

**Why:** README markets "self-improving skills" while [PLAYBOOKS_AND_SKILLS.md](./PLAYBOOKS_AND_SKILLS.md) exists specifically to say playbooks ≠ Cursor/Claude skills. A first-time user reads both and is confused within 10 minutes. "Skill" is also a loaded, host-specific term (Claude skills, Cursor skills) we don't control.
**Action:** README, server.json, package.json descriptions say *playbooks* ("self-improving playbooks" is fine). "Skills" appears only in PLAYBOOKS_AND_SKILLS.md as the thing we're contrasted against.

### D2 — Local-first, single-user; personal hosting allowed, shared hosting deferred

**Why:** The hosted/managed-OAuth path was already killed by the accepted ADR ([decisions/slack-oauth-stytch-deferred.md](./decisions/slack-oauth-stytch-deferred.md)), but [OAUTH_AND_HOSTING.md](./OAUTH_AND_HOSTING.md) still frames hosting as the product's future. Multi-tenancy (auth, key isolation, remote MCP) is an enormous design surface with zero users demanding it. "Under my control" is the product's literal promise — local keeps it true. Since then, NOT-56 froze the personal-cloud V1 auth contract ([decisions/personal-cloud-auth-contract.md](./decisions/personal-cloud-auth-contract.md)): a **personal hosted appliance** (single owner, self-operated, per-agent bearer grants) is now supported work. What stays deferred is **managed multi-user SaaS** — no public signup, invitations, billing, quotas, or cross-user deck sharing.
**Action:** Friend onboarding = their own copy: `npm i -g` + `agent-deck setup` on their machine (or their own isolated appliance deployment), their own Keychain/vault, their own decks (export/import shares deck layouts, never secrets). Future shared hosting — if ever pursued — must cross replaceable identity/grant/store/vault boundaries and still requires a separate tenancy migration; see the personal-cloud ADR §6.

### D3 — The learning loop is the integration seam, and it's next after stability

**Why:** "Agents get smarter with usage" is the core wish, and the chosen mechanisms are playbook refinement + accumulated context. Today the loop only exists for *interactive* sessions (CLAUDE.md harness rule: fix output + `update_playbook`). Dealer runs — the volume driver — read playbooks but never write back (PRD US-11 unbuilt). Without write-back, scaling task volume through dealer scales *usage* but not *learning*.
**Action:** Dealer adds a post-run **reflect step**: after human review (approve or retry-with-feedback), the agent is prompted to propose an `update_playbook` diff, generalized per the existing harness rules. The diff is surfaced in the review drawer so drift stays auditable. Human feedback on retry is the highest-value signal — capture it first.

### D4 — Memory cards (facts) come later, as a small agent_deck module

**Why:** Playbooks are *procedures*; there's no home for *facts* (project context, preferences, environment quirks) in either product. That's the second half of "smarter with usage". But it's a new module — don't build it before the playbook loop proves the write-back pattern works.
**Scope when it comes:** deck-scoped markdown memory cards, same card model as playbooks (`get_memory`/`update_memory` or fold into the playbook card type with a `kind` field — decide then). Deliberately no embeddings, no auto-recall ranking in v1.

### D5 — Approval gates stay deferred until dogfooding demands them

**Why:** Gates are dealer's PRD §7 "moat" and entirely unbuilt. But the current flow already has two human gates (plan approval, review) and the runner already caps turns/cost per phase. Building tool-level interception before knowing which actions actually feel risky in daily use is speculative work displacing the learning loop.
**Action:** Keep the two existing gates. Log friction: if a real run makes you wish you'd been asked first, that incident specs the gate feature.

## 3. Keep / Fix / Cut

### agent_deck

| | Item | Note |
|---|------|------|
| **Keep** | Deck-scoped MCP proxy, session binding, Keychain vault, playbook cards + dependency graph | The core loop is coherent and shipped |
| **Keep** | Security boundary (`x-agent-deck-client`, secrets never on MCP) | Strongest design in either repo — don't weaken it for convenience |
| **Keep** | MCP tool-surface discipline (profiles, ~16 tools) | |
| **Fix** | **Connection / stability / latency** (felt in daily use) | First roadmap item — see Phase 0. Suspects: MCP session lifecycle across host restarts (in-memory bindings), the double hop (MCP server → REST → downstream), downstream stdio server spawn cost |
| **Fix** | Naming (D1), hosted-framing in OAuth docs (D2) | |
| **Fix** | Stale docs: [decisions/installation-no-bypass.md](./decisions/installation-no-bypass.md) premised on removed `deck.yaml`; "tokens in SQLite plaintext" line in [MCP_INTEGRATION_STRATEGY.md](./MCP_INTEGRATION_STRATEGY.md); root `DOCUMENTATION_PLAN.md` tombstone | See appendix |
| **Cut** | `packages/mcp-app/` | Empty `src/`, one stale 782 KB built artifact. Delete; resurrect from git if ever needed |

### agent-dealer

| | Item | Note |
|---|------|------|
| **Keep** | The vertical slice: intake → auto plan draft → approve → execute → review → done, Linear write-back, SSE dashboard, dev/prod split | Real and working after 2 days — this is the right skeleton |
| **Keep** | Arm's-length deck integration (HTTP list + MCP at run time, no shared code, no secrets) | Correct boundary |
| **Fix** | **PRD_V0 drift** — auto-enqueue (US-1), Monaco editor, palette all contradicted by as-built docs | Annotate stale sections with pointers to LINEAR_INTEGRATION / DATA_MODEL / cursor rules; don't rewrite the whole PRD |
| **Fix** | Deck MCP config is assumed, not provisioned — runs silently degrade if the user never ran `claude mcp add` | Dealer's agent-health preflight should verify (and offer to write) the agent_deck MCP registration; Cursor runner gets no MCP at all today — either wire it or mark Cursor "no-deck runtime" honestly |
| **Fix** | Build the reflect step (D3) | Phase 1 |
| **Defer** | Approval gates (D5), stall detection, `--resume` continuity, second tracker (Lific), event-sourcing ambition | `artifacts` as the audit record is fine for one user |

## 4. Roadmap

Phases are sequential focuses, not gates — dogfooding never stops.

### Phase 0 — Stability + dogfood (now)

The blocker for everything else: you can't judge coverage or refine playbooks through a connection you don't trust.

- **Diagnose the felt instability.** Reproduce and measure before fixing: MCP session behavior across `agent-deck` restarts and host restarts, tool-call latency through the proxy vs direct, stdio child-server lifecycle. Timebox; produce a findings note (or fixes, if small).
- **Dogfood for real:** 3–5 genuine daily tasks/week through dealer (code *and* non-code — use manual intake where Linear doesn't fit).
- **Friction log habit:** one line per papercut (a playbook card or plain file — but it must be written down, it becomes the spec for Phases 1–3).
- Exit signal: a week of daily use where agent_deck never made you think about agent_deck.

### Phase 1 — Learning loop

- Dealer post-run reflect step → `update_playbook` proposal, per D3.
- Playbook diff visible in the review drawer.
- Exit signal: a playbook that is measurably better because dealer runs improved it — the MVP.md "self-improvement" success criterion, finally exercised at volume.

### Phase 2 — Coverage

Driven by the Phase 0–1 friction log, not by the PRD's category enums.

- Expand dealer intake beyond Linear for whatever the log says you actually do daily (likely: manual/research/email-shaped tasks first).
- Pick **1–2 providers** the log demands and make them "just work" in agent_deck (Linear/Notion already do; Slack/Google are the known-hard ones with workaround docs).
- Delete or implement the dead `communication`/`email` category enums as part of whichever lands.

### Phase 3 — Friend onboarding

Only after the loop and daily use are real for you.

- D1 naming + README cleanup done; one clear tagline.
- Install path smoke-tested on a clean machine (`setup` → bind → first playbook run).
- Happy-path provider set documented honestly: "Linear/Notion work out of the box; anything else is a project."
- Friend runs their own local copy (D2); share deck layouts via export/import.

## Appendix — Doc hygiene

Per the docs [Maintenance rule](./README.md#maintenance) ("no new top-level file without removing one"): this file's slot is paid for by deleting root `DOCUMENTATION_PLAN.md`.

| Doc | Issue | Action |
|-----|-------|--------|
| `DOCUMENTATION_PLAN.md` (root) | Tombstone superseded by docs/README.md | **Delete** |
| [decisions/installation-no-bypass.md](./decisions/installation-no-bypass.md) | "Proposed", premised on removed `deck.yaml` | Annotate: superseded by session binding (MVP as-built notes) |
| [OAUTH_AND_HOSTING.md](./OAUTH_AND_HOSTING.md) / [OAUTH_REQUIREMENTS.md](./OAUTH_REQUIREMENTS.md) | Present hosting as the product path | Annotate header: local-only per D2 + Stytch ADR; hosted sections are archive |
| [MCP_INTEGRATION_STRATEGY.md](./MCP_INTEGRATION_STRATEGY.md) | Stale "tokens in SQLite plaintext" line | Fix line (tokens are in Keychain) |
| `packages/mcp-app/` | Ghost package, empty src | Delete (Cut list) |
| agent-dealer `docs/PRD_V0.md` | US-1 auto-enqueue, Monaco, palette contradicted by as-built | Annotate stale sections; LINEAR_INTEGRATION / DATA_MODEL / cursor rules win |
| agent-dealer `docs/INTEGRATION_POC_FINDINGS.md` | "Feedback injection not wired" now false | Fix line |
| Obsidian "Agent Deck v2" note | Grand vision lives outside the repo | Leave; this doc is the in-repo direction owner — pull items from v2 only via the friction log |
