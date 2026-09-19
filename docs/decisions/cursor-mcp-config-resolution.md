# ADR — Cursor MCP config resolution (Agent Deck contract)

**Status:** Accepted (updated NOT-50)  
**Date:** 2026-09-09  
**Linear:** NOT-54 (decision), NOT-52 (diagnostics consumer), NOT-50 (no-deck explain session)  
**Related:** [PRD_TRUSTED_AGENT_SESSIONS.md](../PRD_TRUSTED_AGENT_SESSIONS.md), shipped folder assignment (`agent-deck use` → `.agent-deck/use.json` v3)

## Context

Agent Deck scopes MCP to the **deck the user assigned** for a folder (`agent-deck use` → `.agent-deck/use.json` + `mcp-launch` with `x-agent-deck-deck-id`). Cursor loads MCP from two files and may start a user-level stdio launcher with a cwd that is **not** the bound workspace. Without an explicit contract, agents hit `GRANT_REQUIRED`, bare-URL connections with no assignment, or Cursor’s `mcp_auth` dead end.

If Agent Deck tools are missing in Cursor, don't use `mcp_auth` — run `agent-deck use <deck> --client cursor` in the project folder, then reload Cursor MCP.

This ADR records an evidence-backed contract before Agent Deck claims further global/project ownership. It does **not** add secrets, tokens, or approval steps for deck selection.

## Evidence (2026-09-09)

| Probe | Result |
|-------|--------|
| Cursor docs ([MCP](https://cursor.com/docs/mcp), [help](https://cursor.com/help/customization/mcp)) | Global `~/.cursor/mcp.json` + project `.cursor/mcp.json` are **merged**; **same name → project wins**. |
| Interpolation | `${workspaceFolder}` = folder that contains the `.cursor/mcp.json` being resolved; also `${env:NAME}`, `${userHome}`. |
| Cursor desktop | `3.19.19` (this machine). |
| Cursor Agent CLI | `2026.07.09-a3815c0`; `agent mcp list` from `agent_deck` root → `agent-deck: not loaded (needs approval)`. |
| IDE Agent chat namespace | User-level entry surfaces as `user-agent-deck` (stdio launcher). |
| Multi-root / non-first project | Cursor forum: project MCP from second+ roots often **does not load**; workaround is **user-level** config ([forum thread](https://forum.cursor.com/t/cursor-doesnt-see-workspace-project-level-defined-mcp-servers/167777)). |
| Launcher without pin | `mcp-launch` with only host/port env reads assignment via `AGENT_DECK_WORKSPACE` or **cwd**; wrong cwd → unassigned session / `GRANT_REQUIRED` recovery text. |
| Legacy bare HTTP | `url`-only entry → Cursor HTTP path / OAuth UI (`mcp_auth`) when the server returned 401; with NOT-50 the MCP server answers with an unassigned session instead. Still prefer upgrading to `mcp-launch` via `use --client cursor`. |

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

### D4. Fail closed (assignment model)

| Situation | Behavior |
|-----------|----------|
| Custom user-level wrapper (not `agent-deck` + `mcp-launch`) | Never overwrite; diagnose + instruct |
| Bare `url` HTTP entry | Diagnose only on `status` / `use --refresh`; explain `mcp_auth` is not the assignment path; repair only on explicit `use` (upgrade to `mcp-launch`) |
| Missing pin | Diagnose; require explicit `use` |
| Multi-root / ambiguous workspace without pin | Fail closed with unassigned session / `GRANT_REQUIRED` recovery text / diagnostic — do not guess a repo |
| Secrets in diagnostics | Never print secrets or Bearer tokens |

### D5. Supported versions / known host bugs

- **Supported:** Cursor desktop and Agent CLI that honor documented `mcp.json` merge + stdio `command`/`args`/`env` (verified against desktop **3.19.x** and Agent CLI **2026.07.x** on this matrix).
- **Known host bug:** project-level MCP may not appear for non-first folders in multi-root workspaces — prefer user-level pin for Agent Deck until Cursor fixes that.
- **Out of scope here:** OAuth for Agent Deck MCP, Cloud Agent MCP dashboards, enterprise allowlists.

## Consequences

- **NOT-52** implements a read-only inspector aligned with this contract (`assignment-missing`, not a secret-based flow).
- **NOT-50** answers no-deck HTTP connections with an unassigned MCP session instead of 401, so Cursor does not trap users in `mcp_auth`.
- Explicit `agent-deck use` remains the only config writer for Cursor Agent Deck entries (aside from intentional `setup` preserving pins).
- Docs / CHANGELOG / harness copy must say: Cursor `mcp_auth` ≠ Agent Deck folder assignment.
- **NOT-154 (as-built):** Host agent sandboxes that cannot write `~/.agent-deck` still get a clear home-store error (not bare SQLite readonly). When `.agent-deck/use.json` already matches the requested deck, `agent-deck use` falls back to repairing the **project** MCP pin after a home-store write failure (no successful `~/.agent-deck` write required). `status` / `doctor` recoveries distinguish missing assignment (unsandboxed) from missing workspace pin (sandbox-safe when assignment exists).

## Alternatives rejected

- **Project-only ownership:** fails IDE Agent chat + multi-root evidence.
- **Rely on launcher cwd alone:** unstable when Cursor starts user MCP outside the repo.
- **Reintroducing workspace secrets / OAuth for deck selection:** rejected; access-control goal is “user assigns the deck; only the user changes it.”
- **Moving the Agent Deck store into the project workspace:** rejected (NOT-154 non-goal); keep home store, teach sandbox-safe repair for workspace-writable files only.
