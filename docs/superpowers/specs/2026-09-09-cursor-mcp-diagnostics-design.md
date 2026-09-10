# Cursor MCP diagnostics (NOT-54 + NOT-52) — Design

**Date:** 2026-09-09  
**Tickets:** NOT-54, NOT-52  
**ADR:** [cursor-mcp-config-resolution.md](../../decisions/cursor-mcp-config-resolution.md)

## Outcome

Ship a product release that (1) publishes the Cursor MCP resolution contract and (2) adds a read-only, machine-testable inspector consumed by `agent-deck status` and `agent-deck use --refresh`, without writing MCP config.

## Scope

- In: ADR, `inspectCursorMcpConfig`, human formatter, wire status/refresh, unit tests, CHANGELOG, PRD pointer.
- Out: auth redesign, changing `use` repair writer behavior beyond consuming shared classification helpers, IDE UI.

## Types (sketch)

- Per-file report: path, source (`global`|`project`), shape (`missing`|`legacy-bare-url`|`mcp-launch`|`custom`), transport, endpoint summary (typed; surfaced in `stale-endpoint` issues), workspace pin, issue codes.
- Grant summary for cwd (or pinned root): present boolean, deck id/name, and grant id on the type (formatter prints present + deck name/id only) — no secrets.
- Issue codes include `mcp_auth_dead_end` for bare-URL → Cursor OAuth/auth UI path.

## Invariants

- Inspector and diagnostic commands make **zero** filesystem writes.
- Fixer remains `agent-deck use` only.
