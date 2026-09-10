# ADR — Cursor MCP config resolution (Agent Deck contract)

**Status:** Accepted  
**Date:** 2026-09-09  
**Linear:** NOT-54 (decision), NOT-52 (diagnostics consumer)  
**Related:** [PRD_TRUSTED_AGENT_SESSIONS.md](../PRD_TRUSTED_AGENT_SESSIONS.md), shipped 1.7.3 workspace pin

## Context

Agent Deck authenticates MCP with a **workspace grant** (`agent-deck use` → `.agent-deck/use.json` + launcher Bearer). Cursor loads MCP from two files and may start a user-level stdio launcher with a cwd that is **not** the bound workspace. Without an explicit contract, agents hit `GRANT_REQUIRED`, bare-URL `401`, or Cursor’s `mcp_auth` dead end.

This ADR records an evidence-backed contract before Agent Deck claims further global/project ownership. It does **not** redesign grant authentication.

## Evidence (2026-09-09)

| Probe | Result |
|-------|--------|
| Cursor docs ([MCP](https://cursor.com/docs/mcp), [help](https://cursor.com/help/customization/mcp)) | Global `~/.cursor/mcp.json` + project `.cursor/mcp.json` are **merged**; **same name → project wins**. |
| Interpolation | `${workspaceFolder}` = folder that contains the `.cursor/mcp.json` being resolved; also `${env:NAME}`, `${userHome}`. |
| Cursor desktop | `3.19.19` (this machine). |
| Cursor Agent CLI | `2026.07.09-a3815c0`; `agent mcp list` from `agent_deck` root → `agent-deck: not loaded (needs approval)`. |
| IDE Agent chat namespace | User-level entry surfaces as `user-agent-deck` (stdio launcher). |
| Multi-root / non-first project | Cursor forum: project MCP from second+ roots often **does not load**; workaround is **user-level** config ([forum thread](https://forum.cursor.com/t/cursor-doesnt-see-workspace-project-level-defined-mcp-servers/167777)). |
| Launcher without pin | `mcp-launch` with only host/port env reads grant via `AGENT_DECK_WORKSPACE` or **cwd**; wrong cwd → `GRANT_REQUIRED`. |
| Legacy bare HTTP | `url`-only entry → Cursor HTTP path / OAuth UI (`mcp_auth`); **not** Agent Deck grant flow. |

Evidence logs (local, not committed): `.temporal/evidence/`.

## Decisions

### D1. Surfaces Agent Deck supports

| Surface | MCP config Agent Deck targets | Notes |
|---------|-------------------------------|--------|
| Cursor IDE Agent chat | **User-level** `~/.cursor/mcp.json` `agent-deck` | Primary dogfood path; maps to `user-agent-deck`. |
| Cursor Agent Window | Same user-level entry when linked through Customize / marketplace | Treat as same contract as IDE chat until Cursor documents a distinct file. |
| Cursor CLI (`agent`) | Same merge rules; project can override | Approve/enable via `agent mcp enable` when “needs approval”. |

Deck **display** (statusline / menubar) remains out of scope for IDE chat — see user-surface-feasibility rules.

### D2. Precedence

1. If project `.cursor/mcp.json` defines `agent-deck`, Cursor’s documented **project-over-global** rule applies on single-root opens.
2. Agent Deck’s **repair writer** (`agent-deck use --client cursor`) still maintains the **user-level** launcher with `AGENT_DECK_WORKSPACE` because IDE Agent chat reliably loads that entry and multi-root project MCP is unreliable.
3. When both exist and differ, diagnostics report both and state expected host precedence; they do **not** silently delete either file.

### D3. How a global launcher resolves the active workspace

1. **Canonical:** `env.AGENT_DECK_WORKSPACE` set by explicit `agent-deck use` (last explicit use wins).
2. **Fallback:** `process.cwd()` inside `mcp-launch` only when the pin is absent (legacy / broken configs).
3. **Not supported as primary:** inferring workspace from Cursor’s internal “active folder” without a pin — hosts do not expose a stable API for that in Agent Deck’s launcher.

Project entries may also set `AGENT_DECK_WORKSPACE` (or `${workspaceFolder}`) so project-over-global wins cleanly on single-root opens.

### D4. Fail closed

| Situation | Behavior |
|-----------|----------|
| Custom user-level wrapper (not `agent-deck` + `mcp-launch`) | Never overwrite; diagnose + instruct |
| Bare `url` HTTP entry | Diagnose only on `status` / `use --refresh`; explain `mcp_auth` is not the grant path; repair only on explicit `use` |
| Missing pin | Diagnose; require explicit `use` |
| Multi-root / ambiguous workspace without pin | Fail closed with `GRANT_REQUIRED` / diagnostic — do not guess a repo |
| Secrets in diagnostics | Never print grant secrets or Bearer tokens |

### D5. Supported versions / known host bugs

- **Supported:** Cursor desktop and Agent CLI that honor documented `mcp.json` merge + stdio `command`/`args`/`env` (verified against desktop **3.19.x** and Agent CLI **2026.07.x** on this matrix).
- **Known host bug:** project-level MCP may not appear for non-first folders in multi-root workspaces — prefer user-level pin for Agent Deck until Cursor fixes that.
- **Out of scope here:** redesigning grant auth, Cloud Agent MCP dashboards, enterprise allowlists.

## Consequences

- **NOT-52** implements a read-only inspector aligned with this contract.
- Explicit `agent-deck use` remains the only config writer for Cursor Agent Deck entries (aside from intentional `setup` preserving pins).
- Docs / CHANGELOG / harness copy must say: Cursor `mcp_auth` ≠ Agent Deck workspace grant.

## Alternatives rejected

- **Project-only ownership:** fails IDE Agent chat + multi-root evidence.
- **Rely on launcher cwd alone:** unstable when Cursor starts user MCP outside the repo.
- **Auth redesign in this ticket:** deferred by NOT-54 scope.
