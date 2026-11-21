# Agent Deck — Development Guide

**Doc role:** Contributor workflow  
**Install & env:** [SETUP.md](./SETUP.md) · **Product scope:** [Architecture](./ARCHITECTURE.md) · **Design:** [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Quick start

```bash
git clone https://github.com/not-so-fat/agent_deck.git
cd agent_deck
npm install
npm run build
npm run dev:all
```

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:3000 |
| API | http://localhost:8000 |
| MCP | http://127.0.0.1:3001/mcp |

Data dir: `AGENT_DECK_DEV=1` → `~/.agent-deck/dev/` (see [SETUP.md](./SETUP.md)).

---

## Daily workflow

```bash
npm run dev:all          # all services (scripts/dev-all.sh)
npm run backend:dev      # API only
npm run frontend:dev     # Vite only
npm run mcp              # MCP only
npm test                 # all packages (rebuilds native modules)
npm run smoke:dev        # backend health + key routes
npm run build:release    # pre-publish build
```

**Branch flow:** feature branch → change → `npm test` → PR.

**Monorepo layout:** [ARCHITECTURE.md](./ARCHITECTURE.md#components). Turbo orchestrates `packages/shared`, `packages/backend`, `packages/cli`, `apps/agent-deck`.

---

## Testing

```bash
npm test                           # full suite
npm run test --workspace packages/backend
npm run smoke:dev                  # lightweight launch smoke
```

- Framework: **Vitest** (FE: Vitest + React Testing Library + jsdom — no separate E2E runner)
- Map: [TESTING.md](./TESTING.md) (FE / BE / MCP / CLI scenarios)
- Native module: `better-sqlite3` — if Node major changes, `npm install` / `scripts/rebuild-native.mjs`
- After backend/MCP changes: run `npm run dev:all` or `smoke:dev` per [verify-service-launch](../.cursor/rules/verify-service-launch.mdc)

---

## Where to change things

| Change | Start here |
|--------|------------|
| MCP tools / bind | `packages/backend/src/mcp-server.ts` |
| REST routes | `packages/backend/src/routes/` |
| Vault / credentials | `packages/backend/src/vault/` |
| Shared types | `packages/shared/src/schemas/` |
| Dashboard UI | `apps/agent-deck/src/` ([frontend README](../apps/agent-deck/README.md)) |
| CLI / harness | `packages/cli/src/` |
| Agent harness template | `packages/cli/src/agent-harness.ts` |

When behavior changes, update the **owning doc** ([Architecture](./ARCHITECTURE.md) for product, [SETUP.md](./SETUP.md) for install) in the same PR.

---

## Agents & playbooks (contributors)

When working in this repo with Agent Deck MCP:

1. Call `get_session_context` before working in the repository and print its receipt.
2. Match the task to the bound deck’s triggers and fetch each match with `get_playbook`.
3. Product truth: [Architecture](./ARCHITECTURE.md); feature proposals and past designs are indexed in [Documentation](./README.md#design-history-and-migration)

See [decisions/installation-no-bypass.md](./decisions/installation-no-bypass.md).

---

## Contributing

- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`
- Keep diffs focused; match surrounding code style
- Do not commit secrets, `.env`, or `~/.agent-deck/` data
- Release process: [PUBLISHING.md](./PUBLISHING.md)

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `NODE_MODULE_VERSION` / sqlite | `npm rebuild better-sqlite3` or re-`npm install` |
| Port in use (CLI) | `agent-deck stop` or change ports in [SETUP.md](./SETUP.md) |
| Dev vs prod data mixed | Confirm `AGENT_DECK_DEV=1` for `dev:all` |

More: [SETUP.md](./SETUP.md#common-issues).

---

## Related

- [docs/README.md](./README.md) — documentation index
- [PLAYBOOKS_AND_SKILLS.md](./PLAYBOOKS_AND_SKILLS.md)
- [MONOREPO_SCOPE.md](./MONOREPO_SCOPE.md)
