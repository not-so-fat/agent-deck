# `mcp-launch` retirement for Codex and Claude Code (NOT-566)

Codex and Claude Code connect to Agent Deck over **pure MCP** (plain HTTP
entries in host config — no CLI lookup, no stdio bridge). The
`agent-deck mcp-launch` launcher is retired for those two hosts and
**retained** for the hosts that still need stdio.

Update (NOT-567): Cursor connects over pure MCP too — the per-folder
`.cursor/mcp.json` HTTP entry (`use`) plus the global headerless HTTP
fallback (`setup`), with the plugin declaring no MCP server. Cursor
entries migrate when `setup`/`use` re-runs; `agent-deck upgrade` does not
rewrite them.

## Who uses what

| Host | Connection | `mcp-launch` still used? |
|------|------------|--------------------------|
| Codex | Per-folder `.codex/config.toml` HTTP entry (`use`) + global headerless HTTP fallback (`setup`) | No — legacy entries keep working until rewritten |
| Claude Code | Per-folder `.mcp.json` HTTP entry (`use`) + global headerless HTTP fallback (`setup`) | No — legacy entries keep working until rewritten |
| Cursor | Per-folder `.cursor/mcp.json` HTTP entry (`use`) + global headerless HTTP fallback (`setup`) | No — legacy entries keep working until `setup`/`use` re-runs |
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
unrelated servers, custom wrappers, and Muse/Desktop entries are
left untouched, as are Cursor entries (those migrate via `setup`/`use`
re-runs) and files that fail to parse. The rewrite is
idempotent — running `agent-deck upgrade` again changes nothing.

`<folder>/.mcp.json` is shared between Claude Code and Muse, so the
rewrite discriminates there: only a launcher entry with a Claude marker
(`type: 'stdio'` or an `AGENT_DECK_WORKSPACE` pin — every launcher
entry `use`/`setup --client claude` ever wrote carries at least one) is
converted to the HTTP shape. A current Muse launcher entry carries
neither marker and is left byte-identical, so Muse keeps working across
upgrades with no re-run needed. A folder that serves both hosts keeps
the shared launcher entry, which still connects for Claude Code too.

Project entries are rewritten for the folder `agent-deck upgrade` runs
in; run it (or `agent-deck use <deck>`) in each project folder to
migrate that folder.

Manual equivalent (same result, per host):

- `agent-deck use <deck>` in the folder rewrites the per-folder entries.
- `agent-deck setup --client codex` / `--client claude` rewrites the
  global fallbacks.
- `agent-deck setup --client cursor` rewrites the Cursor global fallback
  (Cursor migrates through `setup`/`use`, never `upgrade`).
- `agent-deck upgrade --check` never rewrites anything.

## Verifying

- `agent-deck debug-mcp` accepts pure-HTTP Claude entries; a remaining
  launcher entry is reported as a legacy note (still healthy).
- `agent-deck doctor` reports the Codex plugin manifest as manifest-only
  and the connection separately; legacy `mcp-launch` plugin installs keep
  verifying as compatible.

Background: [launcher-free host connection](./design/launcher-free-host-connection.md).
