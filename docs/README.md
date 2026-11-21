# Agent Deck documentation

Start with the [project README](../README.md) for a quick install or the
[architecture overview](./ARCHITECTURE.md) for the current design. The guides
below describe Agent Deck 2.6 unless a section names another version.

| I want to… | Read |
|---|---|
| Install, connect a client, or fix a connection | [Setup](./SETUP.md), [Client compatibility](./SETUP.md#client-compatibility), [Agent harness](./AGENT_HARNESS.md), [Friend path](./FRIEND_PATH.md) |
| Understand which deck a session uses | [Binding and monorepos](./MONOREPO_SCOPE.md), [Folder pins](./MONOREPO_SCOPE.md#folder-pins), [MCP session lifecycle](./MCP_SESSION_LIFECYCLE.md) |
| Teach or revise a procedure | [Playbooks and skills](./PLAYBOOKS_AND_SKILLS.md), [Playbook skill](../skills/agent-deck-playbooks/SKILL.md), [Examples](./examples/playbooks/) |
| Follow the end-to-end workflows | [User flows](./USER_FLOWS.md) |
| Connect a service or configure OAuth | [OAuth and hosting](./OAUTH_AND_HOSTING.md), [Slack app setup](./SLACK_OAUTH_APP.md), [Deployment](./DEPLOYMENT.md) |
| Inspect or sync portable deck files | [Store format](./STORE_FORMAT.md) |
| Delegate as an agent | [Run skill](../skills/agent-deck-run/SKILL.md), [MCP run tools](./MCP_RUN_TOOLS.md) |
| Operate runs from the host | [Per-client delegation reference](./DELEGATION.md), [Agent run HTTP API](./AGENT_RUN_API.md), [Card usage correlation](./CARD_USAGE_CORRELATION.md) |
| Build an evaluation from feedback | [Evaluation API](./EVALUATION_SCENARIOS_API.md), [Experiment examples](./examples/experiments/) |
| Develop or test Agent Deck | [Development](./DEVELOPMENT.md), [Testing](./TESTING.md) |
| Host or release Agent Deck | [Deployment](./DEPLOYMENT.md), [Publishing](./PUBLISHING.md), [Security](../SECURITY.md) |

## Design history and migration

- [MCP launcher migration](./MCP_LAUNCH_MIGRATION.md) covers older host entries.
- [MVP spec](./MVP.md), [product direction](./DIRECTION.md),
  [connection designs](./design/), [decision records](./decisions/), and
  [dated implementation specs, plans, and smoke notes](./superpowers/) record
  past decisions or proposals. Use the architecture and task guides above for
  shipped behavior.
- The PRDs and QA reports remain at their original paths so issue links and
  evidence still resolve.
