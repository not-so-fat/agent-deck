## Agent Deck security hardening and CI

> **Historical (2026-07-06)** — This record captures an earlier design, proposal, or verification run. See [the current guide](../../ARCHITECTURE.md) for shipped behavior.


### Scope

- Tighten network exposure for the MCP proxy and REST backend.
- Align CORS policy with the dashboard origin instead of any-site access.
- Normalize license metadata and LICENSE packaging across workspaces.
- Add a minimal CI workflow to run tests and type-check on pushes/PRs.
- Address small housekeeping items (`.mcp.json` handling, root `author`).

### MCP proxy binding

- Add an explicit `host` parameter to `AgentDeckMCPServer` and store it on the instance.
- Change the Express `listen` call to `app.listen(port, host)` so the MCP HTTP listener does not bind all interfaces by default.
- Thread a new `AGENT_DECK_MCP_HOST` env var through `mcp-index.ts`, defaulting to `127.0.0.1` to keep the MCP proxy loopback-only out of the box.
- Keep existing port and backend URL behavior; only the host binding changes unless the user opts into a broader host explicitly.

### Backend host and CORS

- Change the REST backend default `HOST` from `0.0.0.0` to `127.0.0.1` in `packages/backend/src/index.ts`, while still allowing explicit overrides via `HOST` for advanced deployments.
- Replace `origin: true` in the Fastify CORS configuration with a restricted origin list:
  - Accept a new env var (e.g. `AGENT_DECK_DASHBOARD_ORIGIN`) when set.
  - Fall back to a small set of known-safe loopback origins for dashboard and dev (`http://127.0.0.1:1111`, `http://localhost:1111`, and the dev UI port).
- Keep `credentials: true` so existing OAuth and cookie flows continue to work, but drop generic any-site access.

### License metadata and packaging

- Standardize on **MIT** as the project license:
  - Change the root `package.json` license field from `ISC` to `MIT`.
  - Change `@agent-deck/cli` license from `ISC` to `MIT`.
  - Add `"license": "MIT"` to `@agent-deck/backend` and `@agent-deck/shared`.
- Ensure every published package includes the MIT LICENSE file:
  - Add `"LICENSE"` to the `"files"` arrays for `@agent-deck/backend`, `@agent-deck/shared`, and `@agent-deck/cli`.
  - Leave the single canonical `LICENSE` at the repo root and reuse it in the package tarballs via the `files` configuration.
- Update the README badge and link text to reflect MIT instead of ISC.

### CI workflow

- Add a `.github/workflows/ci.yml` GitHub Actions workflow that runs on pushes and pull requests to the main branch.
- CI job steps:
  - `actions/checkout` to fetch the repo.
  - `actions/setup-node` (Node 22.x as a middle-of-matrix default) with npm caching.
  - `npm install` at the monorepo root.
  - `npm run test:ci` to execute the existing golden-path test suite (including native rebuild).
  - `npm run type-check` for TypeScript safety.
- Keep the workflow intentionally small and fast; no publish or release steps run from CI.

### Housekeeping

- Commit the project-level `.mcp.json` that points at `http://127.0.0.1:1110/mcp` so contributors get a working default MCP configuration; treat it as non-secret metadata.
- Leave `.claude/settings.local.json` untracked as a user-local file.
- Set the root `package.json` `author` field to a concrete value (`"@not-so-fat"`), matching the LICENSE copyright.

