# Monorepo scope and session binding

A single workspace can host several concurrent MCP sessions, each with its
own deck. A local session starts with the explicit launch deck, then a usable
folder pin, then the user default. Set the user default with
`agent-deck default <deck>`.

## Folder pins

This section is the source of truth for folder pins. Pins are a supported,
optional feature for keeping a project on a named deck across sessions. Run
`agent-deck use <deck>` from the project to write `.agent-deck/use.json` and
the project MCP entry. The global entry serves projects that use the user
default. The long-term design of folder binding is still under discussion.

- The project entry must load and identify the workspace. Cursor needs the
  project server enabled and a literal workspace header. Its inspector
  detects missing headers and stale endpoint URLs. Codex and Muse require
  workspace trust to load project config, and Muse loads `.mcp.json` only in
  a Git repository.
- A stale pin to a deleted deck can fall back to the user default. Check the
  first-turn receipt to confirm which deck the session is using.
- Old Muse project launcher entries can conflict with the global HTTP entry
  (`invalid_transport_combination`). See [launcher migration](./MCP_LAUNCH_MIGRATION.md).

See the [Cursor diagnostics tests](../packages/cli/src/cursor-mcp-inspect.test.ts),
[pin setup tests](../packages/cli/src/use.test.ts), and
[MCP binding implementation](../packages/backend/src/mcp-server.ts).

## Changing decks in a live session

The agent reads the binding with `get_session_context`. To change it, call
`switch_deck` and wait for human approval. Session-only approval affects the
current session. Where workspace-default approval is offered, the folder's
assignment is saved for later sessions. A native tool approval can commit a
session-only switch. Read `get_session_context` again after the switch.

The display workspace groups session indicators. Delegation uses the
trusted launch workspace captured at initialization. A display bind via
`bind_workspace` cannot supply or change that execution workspace.

[Agent harness](./AGENT_HARNESS.md) · [MCP run tools](./MCP_RUN_TOOLS.md) ·
[MCP implementation](../packages/backend/src/mcp-server.ts)
