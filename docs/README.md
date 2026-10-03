# Documentation index

**Entry:** [README](../README.md) · **Shipped scope:** [MVP.md](./MVP.md) · **Direction:** [DIRECTION.md](./DIRECTION.md)

---

## Layout

| Location | Use |
|----------|-----|
| `docs/*.md` | Flat files only — one topic per file |
| `docs/decisions/` | ADRs (why X, what we deferred) |
| `docs/examples/` | Templates for registration / harness — not auto-loaded |

**Naming:** `MVP.md` (shipped) · `PRD_*` (proposed) · `*_REQUIREMENTS` / `*_STRATEGY` / `*_WORKAROUND` (domain)

**Rule:** One owner per fact. MCP tools & agent behavior → **MVP only**. Others link.

---

## Core (read these)

| Doc | Role |
|-----|------|
| [DIRECTION.md](./DIRECTION.md) | Cross-product direction (agent_deck + agent-dealer), locked decisions, roadmap |
| [MVP.md](./MVP.md) | Shipped product — bound deck, vault, playbooks, MCP tools |
| [SETUP.md](./SETUP.md) | Install, ports, data dirs, **dashboard** tour |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Components, SQLite, secret storage |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Clone, test, contribute |
| [TESTING.md](./TESTING.md) | FE / BE / MCP / CLI test map + integration scenarios |
| [LEARNING_LOOP_TEST_SCENARIOS.md](./LEARNING_LOOP_TEST_SCENARIOS.md) | Manual QA — proposal queue, stubs, self-improvement |
| [AGENT_HARNESS.md](./AGENT_HARNESS.md) | What `agent-deck setup` installs |
| [PLAYBOOKS_AND_SKILLS.md](./PLAYBOOKS_AND_SKILLS.md) | Playbooks vs Cursor skills |
| [MONOREPO_SCOPE.md](./MONOREPO_SCOPE.md) | Session binding in monorepos |
| [PUBLISHING.md](./PUBLISHING.md) | npm release, distribution |
| [CODEX_PLUGIN.md](./CODEX_PLUGIN.md) | Codex / Claude / HOL marketplace packaging |
| [CARD_USAGE_CORRELATION.md](./CARD_USAGE_CORRELATION.md) | Card-usage stream + opaque run-correlation id (coordinator matching) |

## Proposed features

| Doc | Topic |
|-----|-------|
| [PRD_EXPORT_IMPORT.md](./PRD_EXPORT_IMPORT.md) | Bundle migration |
| [PRD_DECK_DISPLAY.md](./PRD_DECK_DISPLAY.md) | Status line / deck visibility |
| [decisions/installation-no-bypass.md](./decisions/installation-no-bypass.md) | Setup so agents use MCP playbooks |

## OAuth & providers

| Doc | Role |
|-----|------|
| [OAUTH_AND_HOSTING.md](./OAUTH_AND_HOSTING.md) | Redirect URIs, local vs hosted |
| [OAUTH_REQUIREMENTS.md](./OAUTH_REQUIREMENTS.md) | Product OAuth requirements |
| [MCP_INTEGRATION_STRATEGY.md](./MCP_INTEGRATION_STRATEGY.md) | Tiers, deferred work |
| [MCP_TOOL_OPTIMIZATION.md](./MCP_TOOL_OPTIMIZATION.md) | Proposed MCP tool surface reduction (link/unlink design) |
| [SLACK_OAUTH_APP.md](./SLACK_OAUTH_APP.md) | Maintainer Slack app |
| [SLACK_READ_WORKAROUND.md](./SLACK_READ_WORKAROUND.md) | Slack read without official MCP |
| [GOOGLE_DRIVE_WORKAROUND.md](./GOOGLE_DRIVE_WORKAROUND.md) | Local Google Drive MCP |
| [decisions/slack-oauth-stytch-deferred.md](./decisions/slack-oauth-stytch-deferred.md) | Stytch broker ADR |

## Examples

| Path | Purpose |
|------|---------|
| [examples/playbooks/](./examples/playbooks/) | Sample playbook bodies |
| [examples/agent-harness/](./examples/agent-harness/) | Harness templates for `setup` |
| [examples/grok-agent.mcp.json](./examples/grok-agent.mcp.json) | Grok/xAI remote MCP: URL + per-agent `x-agent-deck-deck-id` ([SETUP](./SETUP.md#grok-agents--per-agent-default-deck-not-298)) |

---

## Maintenance

1. **Shipped behavior changes** → [MVP.md](./MVP.md) (+ [SETUP.md](./SETUP.md) / [README](../README.md) if user-visible)
2. **New feature** → `PRD_*` until merged into MVP
3. **Non-obvious decision** → `docs/decisions/`
4. **No new top-level file** without removing or merging an old one

Removed 2026-06-30 (content absorbed above): `INTEGRATION.md`, `USER_GUIDE.md`, `FRONTEND_INTEGRATION_PLAN.md`.
