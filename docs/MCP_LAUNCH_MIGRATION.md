# `mcp-launch` retirement for Codex and Claude Code (NOT-566)

Codex and Claude Code connect to Agent Deck over **pure MCP** (plain HTTP
entries in host config — no CLI lookup, no stdio bridge). The
`agent-deck mcp-launch` launcher is retired for those two hosts and
**retained** for the hosts that still need stdio.

## Who uses what

| Host | Connection | `mcp-launch` still used? |
|------|------------|--------------------------|
| Codex | Per-folder `.codex/config.toml` HTTP entry (`use`) + global headerless HTTP fallback (`setup`) | No — legacy entries keep working until rewritten |
| Claude Code | Per-folder `.mcp.json` HTTP entry (`use`) + global headerless HTTP fallback (`setup`) | No — legacy entries keep working until rewritten |
| Cursor | `mcp-launch` entries (project + user-level pin) | **Yes** |
| Muse | `mcp-launch` entries (project + global settings) | **Yes** |
| Claude Desktop | `mcp-launch` stdio entry (its JSON config is stdio-only) | **Yes** |

The `mcp-launch` command, the stdio↔HTTP bridge, and the pin-env intake
stay supported: nothing that points at them breaks.

## Upgrade path

`agent-deck upgrade` rewrites legacy launcher entries to pure-MCP entries
automatically (best-effort, silent when there is nothing to do):

- `<folder>/.mcp.json` launcher entry → per-folder HTTP entry with the
  `x-agent-deck-workspace` header
- `<folder>/.codex/config.toml` launcher section → per-folder HTTP section
- `~/.claude.json` launcher entry → headerless global HTTP fallback
- `~/.codex/config.toml` launcher section → headerless global HTTP fallback

Only entries that point at `agent-deck mcp-launch` are rewritten;
unrelated servers, custom wrappers, and Cursor/Muse/Desktop entries are
left untouched, as are files that fail to parse. The rewrite is
idempotent — running `agent-deck upgrade` again changes nothing.

Manual equivalent (same result, per host):

- `agent-deck use <deck>` in the folder rewrites the per-folder entries.
- `agent-deck setup --client codex` / `--client claude` rewrites the
  global fallbacks.
- `agent-deck upgrade --check` never rewrites anything.

One caveat: `<folder>/.mcp.json` is shared between Claude Code and Muse.
The rewrite converts a launcher entry there to the Claude HTTP shape; if
that folder also serves Muse, re-run `agent-deck use <deck> --client muse`
afterwards to restore its launcher entry.

## Verifying

- `agent-deck debug-mcp` accepts pure-HTTP Claude entries; a remaining
  launcher entry is reported as a legacy note (still healthy).
- `agent-deck doctor` reports the Codex plugin manifest as manifest-only
  and the connection separately; legacy `mcp-launch` plugin installs keep
  verifying as compatible.

Background: [launcher-free host connection](./design/launcher-free-host-connection.md).
