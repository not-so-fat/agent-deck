# Playbooks vs Cursor Skills

**Audience:** Product, implementers, and agents extending Agent Deck  
**Status:** Current design guidance
**Related:** [architecture](./ARCHITECTURE.md#decks-and-cards), [examples/playbooks/](./examples/playbooks/)

Agent Deck **playbooks** and Cursor **skills** overlap in surface area (both can hold markdown instructions) but solve different problems. This doc explains when to use each and how they fit together so we do not duplicate content blindly or collapse two systems into one by accident.

---

## One-line distinction

| | **Cursor Skill** | **Agent Deck Playbook** |
|---|------------------|-------------------------|
| **Question it answers** | *How should the agent behave in this repo?* | *What procedure should run on this deck, with which connections?* |
| **Primary home** | Repo file (e.g. `.cursor/skills/…/SKILL.md`) | File-backed card in My Collection (`pb_*`) |
| **Discovery** | Cursor skill system (when relevant) | MCP on bound deck (`get_bound_deck` playbook summaries, `get_playbook`) + **[agent harness](./AGENT_HARNESS.md)** (CLAUDE.md / Cursor rules) |
| **Scoped to a deck** | No | Yes — card linked via dashboard |
| **Tied to creds / MCPs** | No dependency graph | Yes — `dependsOnCredentialIds`, `dependsOnServiceIds`, auto-detect |

**Use skills for host or repository guidance.** Use playbooks for procedures shared through a deck.

---

## Cursor Skills

Skills are Cursor-native guidance files the agent reads when a task matches the skill’s domain.

**Use a skill for:**

- Repo conventions and coding standards
- Domain knowledge that applies broadly (“how hiring triage works in this codebase”)
- Tool-usage patterns that are not specific to one deck’s connection set
- Content you want **git-reviewed** as the source of truth in the repo

**Skills are weak at:**

- Expressing “this runbook requires `cred_ashby` and the Linear MCP on **this** deck”
- Blocking removal of an API key when a procedure still references it
- Central collection + drag-onto-deck scoping across workspaces
- Agent-updatable procedures via Agent Deck MCP (`register_playbook`, `update_playbook`)

---

## Agent Deck Playbooks

Playbooks are **first-class cards** in My Collection — same lifecycle as MCP and API key cards. They store a markdown body plus metadata: triggers, optional `exec` / `skill` hints, and dependencies on other cards.

**Use a playbook for:**

- Short, **triggerable** procedures (“check inbox”, “review applicants”)
- Runbooks tied to **specific credentials and MCPs** on a deck
- Procedures agents should **fetch or update via MCP** after a run
- Optional **`exec`** line pointing at `agent-deck exec --connections …`
- **Dependency enforcement** — delete/link warnings when cards reference each other

**Playbooks are weak at:**

- Replacing rich, always-on agent behavior (skills do that better)
- Being as frictionless as “add a markdown file in the repo” for solo, single-repo workflows
- Avoiding duplication if the same long guide also lives in a skill

**Agent tools (bound deck):**

| Tool | Purpose |
|------|---------|
| `get_bound_deck` | Playbook summaries on the deck (id, title, triggers) plus services/credentials |
| `get_playbook` | Full body + resolved dependencies |
| `register_playbook` | Create card; auto-detect deps; add to bound deck by default |
| `update_playbook` | Update card on bound deck; re-detect deps |
| `manage_deck_card` | Link/unlink an existing playbook (or other card) on the bound deck |

Delete playbooks via CLI (`agent-deck playbook delete`) or dashboard — not MCP.

**Dashboard:** Register playbook form also auto-detects dependencies on save. Prefer MCP tools from the agent when iterating after a run.

**Discoverability:** Cursor auto-surfaces skills; playbooks need a nudge. `agent-deck setup` installs a compact [agent harness](./AGENT_HARNESS.md) rule so the agent calls `get_bound_deck` / `get_playbook` and avoids mirroring into `.cursor/skills/`.

---

## How they work together

The hiring example is the intended split:

```yaml
# Playbook metadata (stored on the card, not in repo frontmatter)
triggers: [check inbox, review applicants]
connections: cred_ashby, cred_openai, cred_slack   # → dependsOnCredentialIds
exec: agent-deck exec --connections cred_ashby,cred_openai,cred_slack -- uv run hiring inbox --dry-run
skill: .claude/skills/hiring/SKILL.md             # pointer, not replacement
```

```markdown
# Hiring inbox  (playbook body — short runbook)

1. Run the hiring CLI via Agent Deck exec (connections above).
2. Walk results worst-tier first; user confirms each write.
3. Do not skip `--dry-run` until user says otherwise.

Domain calibration lives in repo `roles/` — not duplicated here.
```

| Layer | Holds |
|-------|--------|
| **Skill** | Deep domain behavior, calibration, edge cases |
| **Playbook** | Triggers, connection set, exec command, short steps |
| **Repo (`roles/`, etc.)** | User-owned domain logic the skill references |

The optional **`skill`** field on a playbook is a **hint** (“for full context, read this skill”). Agent Deck does not load or execute skills; Cursor does.

---

## Decision guide

```
Need deck-scoped procedure with cred/MCP dependencies?
  └─ Yes → Playbook (and optionally point at a skill for depth)
  └─ No  → Skill only (or plain repo docs)

Need dependency warnings when removing API keys / MCPs?
  └─ Yes → Playbook (or explicit deps on playbook card)

Need git-reviewed long-form agent guidance?
  └─ Yes → Skill (keep playbook body short)

Need agent to update procedure via Agent Deck MCP after a run?
  └─ Yes → Playbook

Solo dev, one repo, no deck graph concerns?
  └─ Skills alone may be enough — playbooks add value when vault + scoping matter
```

---

## Comparison table

| Need | Skill | Playbook |
|------|:-----:|:--------:|
| Repo git history as source of truth | ✓ | |
| Cursor auto-discovery | ✓ | |
| Bound to workspace deck | | ✓ |
| Linked to `cred_*` / MCP cards | | ✓ |
| Auto-detect dependencies from content | | ✓ |
| Block delete when something depends on a key | | ✓ |
| `register_playbook` / `update_playbook` from agent | | ✓ |
| Always-on / broad behavioral guidance | ✓ | |
| Trigger phrases (“check inbox”) | optional | ✓ |
| `agent-deck exec` wiring | | ✓ (optional field) |

---

## Anti-patterns

1. **Duplicating the same long guide** in both `SKILL.md` and playbook body — keep the playbook short; link the skill.
2. **Putting vault/deck wiring only in a skill** — agents cannot resolve “which creds are on this deck” from a skill alone; use playbook deps or explicit MCP calls.
3. **Replacing skills with playbooks** — out of MVP scope; skills remain the right place for repo-native agent behavior.
4. **Filesystem playbooks in the repo** — removed from MVP. Sample markdown under `docs/examples/playbooks/` is template content for registration, not auto-discovered paths.

---

## Future directions (not implemented)

These are product options if duplication becomes painful; none are required for MVP:

- **Thin playbooks** — triggers + deps + exec only; body is one line + skill path (already recommended pattern).
- **Export / sync** — playbook body mirrors or exports to repo `SKILL.md` (single source of truth TBD).
- **Skill-only mode** — no playbook cards; vault + scope only (would drop deck-graph procedures).

When adding features, preserve the distinction: **skills = behavior in repo; playbooks = scoped runbooks on the connection graph.**

---

## Related docs

- [Architecture](./ARCHITECTURE.md) — decks and cards
- [MONOREPO_SCOPE.md](./MONOREPO_SCOPE.md) — playbooks are cards, not repo paths
- [examples/playbooks/](./examples/playbooks/) — sample content for registration
  - [user-path-integration-smoke.md](./examples/playbooks/user-path-integration-smoke.md) — **generic** pre-release user-path gate (any project)
  - [npm-release-integration-smoke.md](./examples/playbooks/npm-release-integration-smoke.md) — Agent Deck npm/`smoke:release` specifics
