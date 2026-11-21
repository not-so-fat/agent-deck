# Agent Deck architecture

Agent Deck gives coding agents a shared collection of procedures, tools, and
credentials. A deck selects the cards and operating instructions for a context.
The dashboard is the owner's control surface. Agents work through one MCP
connection, scoped to the deck bound to their session.

## Components

| Component | Role |
|---|---|
| [Dashboard](../apps/agent-deck/) | React UI for the collection, deck editing, OAuth, and human review of requests and playbook changes |
| [Backend](../packages/backend/) | Fastify HTTP API, WebSocket updates, store, vault, service clients, and host-local run execution |
| [MCP server](../packages/backend/src/mcp-server.ts) | Streamable HTTP transport, session binding, scoped tools, downstream tool calls, and delegation |
| [CLI](../packages/cli/) | Managed install and upgrade, daemon and dashboard commands, host configuration, credential execution, and operator run commands |
| [Shared](../packages/shared/) | TypeScript schemas and utilities used across the packages |

Local managed installs serve the dashboard and API on loopback port 1111 and MCP
on port 1110 by default. For development ports and hosted operation, see
[Setup](./SETUP.md#ports) and [Deployment](./DEPLOYMENT.md).

## Decks and cards

The collection holds reusable service, credential, and playbook cards. A deck
references selected cards and stores its own operating instructions. The
[file-backed store](./STORE_FORMAT.md) holds portable definitions. SQLite serves
as the searchable projection and also holds runtime data. The store can be
synced in a user-owned repository and reindexed on another machine.

- **Service cards** describe upstream connections. A remote MCP server uses a
  URL. A local MCP server runs as a stdio child on the Agent Deck host. Agents use
  the bound deck's service and tool list and invoke tools through
  `call_service_tool`. The daemon connects to the upstream service and applies
  its configured authentication and tool policy.
- **Credential cards** describe credentials and environment-variable names. The
  agent sees metadata. The CLI can inject the secret into a child process with
  `agent-deck exec --connections … -- <command>`.
- **Playbook cards** hold trigger phrases and a procedure body. The client
  discovers summaries at runtime, matches triggers, and fetches matching
  bodies with `get_playbook`. Binding and switching generate no playbook stubs.
  Corrections can become a patch proposal or a feedback signal. The owner
  reviews proposals in the dashboard. See [Playbooks and skills](./PLAYBOOKS_AND_SKILLS.md)
  and the [playbook skill](../skills/agent-deck-playbooks/SKILL.md).

## Secret storage

API keys, OAuth client secrets, and OAuth tokens live in the
[vault](../packages/backend/src/vault/secret-store.ts). Local macOS installs
default to Keychain. Hosted mode uses an encrypted file store with a separately
managed vault key. The file-backed store carries credential metadata and service
definitions. See [OAuth and hosting](./OAUTH_AND_HOSTING.md) for redirects and
[Deployment](./DEPLOYMENT.md) for the hosted configuration.

## Host connection and session binding

Install with Node.js 22 or later and run
`agent-deck setup --client <codex|claude|cursor|muse>`. These four hosts use a
global headerless streamable HTTP MCP entry. Host setup also installs client
guidance as applicable. Claude Desktop uses the stdio bridge. See
[Setup](./SETUP.md) and the [agent harness](./AGENT_HARNESS.md).

For local sessions the initial deck is resolved in this order: explicit launch
deck, recognized folder pin, user default. A folder pin is optional. A local
session with no usable deck can explain how to get assigned. Remote MCP sessions
can use a deck-scoped bearer grant. See [Monorepo scope](./MONOREPO_SCOPE.md).

The harness calls `get_session_context` on the first turn and prints its
`display_summary` verbatim. The result includes current operating instructions,
services, credential metadata, and playbook triggers. `switch_deck` requires
human approval. Depending on the host, approval happens in the client or in the
dashboard. Read `get_session_context` again after a confirmed switch to load the
new instructions and receipt. See [Session lifecycle](./MCP_SESSION_LIFECYCLE.md)
for transport expiry and live display.

The [tool registry](../packages/backend/src/mcp-tools/register.ts) defines the
agent surface. Routine work stays within the bound deck. Deck administration
can require a separate, human-approved, time-limited elevation. The
[backend delegates reasoning to external agents](./decisions/no-backend-llm-boundary.md).

## Runs and delegation

A controller uses [`start_run`, `get_run`, and `cancel_run`](./MCP_RUN_TOOLS.md)
to delegate to a signed-in coding client on the Agent Deck host. The run
captures the live deck and uses the trusted workspace designated at launch.
`get_run` returns status and pages ordered events. To continue an eligible
session, supply its `sessionId` as `resumeSessionId` on a new start. The
[run skill](../skills/agent-deck-run/SKILL.md) defines the agent workflow.
Operators have a [host CLI reference](./DELEGATION.md) and an
[authenticated same-host HTTP API](./AGENT_RUN_API.md).

## Distribution

[Publishing](./PUBLISHING.md) covers `release:prepare` (version and release PR),
`release:finish` (merge and tag), and the [tag-triggered workflow](../.github/workflows/release.yml)
that builds and publishes shared → backend → CLI via npm trusted publishing
with provenance and creates the GitHub Release.
