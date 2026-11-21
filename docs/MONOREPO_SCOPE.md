# Monorepo scope and session binding

A single workspace can host several concurrent MCP sessions, each bound to
its own deck. Agent Deck resolves a local session's starting deck from an
explicit launch deck first, a recognized folder pin second, and the user
default last. A folder pin is optional. To set the user default, use
`agent-deck default <deck>`. A configured and enabled project MCP entry can
supply workspace context for an existing `.agent-deck/use.json` pin.

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
