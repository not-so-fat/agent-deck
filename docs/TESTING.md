# Testing map (FE / BE / MCP / CLI)

**Status:** Living map — fill **Integration scenarios** with product owner input  
**Related:** [DEVELOPMENT.md](./DEVELOPMENT.md), [MCP_TOOL_OPTIMIZATION.md](./MCP_TOOL_OPTIMIZATION.md), playbook [user-path-integration-smoke.md](./examples/playbooks/user-path-integration-smoke.md)

How we test Agent Deck today, what is missing after the 1.3.0 MCP tool surface change, and how we should grow tests without over-building.

---

## Layers (what each proves)

```
Unit (fast, no ports)
  shared schemas, pure helpers, DB managers, tool profile math

Component / route (in-process)
  React hooks, Fastify routes with temp DB, CLI setup writers

Protocol / HTTP (real ports, stub peers)
  MCP streamable HTTP: initialize → tools/list → tools/call
  Backend health + scoped routes

Release / user path (packaged artifact)
  npm pack + setup + statusline stdout contract
```

| Layer | Runner | When it runs |
|-------|--------|--------------|
| Unit + component | `npm test` (Vitest via Turbo) | Every PR / local |
| Launch smoke | `npm run smoke:dev` | After BE/MCP changes (manual / agent rule) |
| Release smoke | `npm run release:smoke` (inside `build:release`) | Before publish |

---

## As-built inventory

### Shared (`packages/shared`)

| Area | Files (examples) | Coverage |
|------|------------------|----------|
| Schemas / validation | `schemas/*.test.ts`, `utils/validation.test.ts` | Strong |
| Playbook deps, credentials, OAuth session | `utils/playbook-dependencies.test.ts`, etc. | Strong |

### Backend (`packages/backend`)

| Area | Files (examples) | Coverage |
|------|------------------|----------|
| SQLite / decks / credentials | `models/database*.test.ts` | Strong |
| Vault / OAuth | `vault/*.test.ts` | Strong |
| Playbooks | `playbooks/playbook-manager.test.ts` | Strong |
| Service manager / MCP client | `services/*.test.ts` | Medium (mocked peers) |
| Scope / live display / badges | `scope/*.test.ts`, `routes/scope.bindings.test.ts` | Strong |
| **MCP tools (logic)** | `mcp-tools/profile.test.ts`, `deck-card-ops.test.ts` | **New — unit only** |
| **MCP protocol (HTTP)** | `mcp-server.http.test.ts` | **Partial** — session, health, `tools/list` names, bind badge |
| CLI admin (delete) | `cli-runtime.test.ts` | New — unit against temp DB |

**MCP HTTP tests today assert:**

- Multi-session initialize
- GET `/mcp` SSE for Claude
- Reject calls without session
- Default profile tool names (`manage_deck_card`, `create_deck`; no `list_playbooks` / `delete_*`)
- `bind_workspace` → live-display badge (stub backend)
- Golden agent path S2–S8 (`golden-path.http.test.ts`) and authenticated concurrent/idempotent bind (`session-local.http.test.ts`)
- OS-assigned MCP ports under parallel start (`test-harness.port.test.ts` — NOT-47)

**MCP HTTP tests do not yet assert:**

- `register_*` collection create flows against a full Fastify API (link/unlink covered via `manage_deck_card`)
- Profile matrix (`runtime` / `legacy`) end-to-end over HTTP (unit coverage in `profile.test.ts`)
- Error shapes such as `NOT_BOUND` on every tool (partial coverage elsewhere)
- Proxy `call_service_tool` against a real upstream MCP peer (stubbed echo only)

### CLI (`packages/cli`)

| Area | Files | Coverage |
|------|-------|----------|
| Setup / harness / statusline / menubar | `*.test.ts` | Strong for install contracts |
| Release user path | `release-integration.test.ts` + `scripts/release-smoke.sh` | Strong for statusline |
| Collection admin (`service|playbook|deck delete`) | — | **Missing** (logic in backend `cli-runtime.test.ts` only) |
| **Supervisor stop/start diagnostics (NOT-135)** | `shutdown-reason.test.ts`, `start-preflight.test.ts`, `stop-origin.integration.test.ts`, `start-failure.integration.test.ts`, `misc/not135-smoke.sh` | **Auto** — the `*.integration.test.ts` files spawn the built CLI, a real supervisor and a real backend (shared rig: `cli-integration-harness.ts`), so they need `npm run build` first (Turbo does this; a bare `vitest` does not) |

### Frontend (`apps/agent-deck`)

| Area | Files | Coverage |
|------|-------|----------|
| Hooks (WebSocket, drag-drop) | `test/hooks/*.test.tsx` | Medium |
| Deck fan layout math | `components/deck-fan.test.ts` | Strong for layout |
| Live bindings display helpers | `lib/live-bindings.test.ts` | Strong for formatting |
| Pages / modals | — | Thin (no full-page render suite) |
| **Deck link/unlink (S11)** | `test/hooks/useDragAndDrop.deck-link.test.tsx` | **Auto** — Vitest + Testing Library + jsdom |

**Framework:** Vitest + React Testing Library + jsdom (already in `apps/agent-deck`). No Playwright — same runner as BE/CLI, included in `npm test` / Turbo CI.

---

## Store isolation (never touch the real `~/.agent-deck`)

Every package's `vitest.config.ts` calls `useIsolatedAgentDeckHome()`
(`scripts/vitest/test-home.mjs`), which points `AGENT_DECK_HOME` at a fresh
`$TMPDIR/agent-deck-test-<pkg>-<pid>` for the run; `scripts/vitest/global-setup.mjs`
creates it and removes it afterwards. Tests that mint their own temp home keep
working — they just override an already-safe default.

`resolveAgentDeckHome()` backs this with a guard: under a test runner (`VITEST`,
`NODE_ENV=test`) it **throws** rather than resolve to `~/.agent-deck` or
`~/.agent-deck/dev`, so a test that loses its isolation fails loudly instead of
writing stray decks and services into the developer's (often git-synced) store —
strays that then fail every `reindex` on duplicate display names (NOT-122).

Every package except `@agent-deck/shared` loads that guard from
`packages/shared/dist`, not from source, so a build predating the guard ran without it —
and the only tests that failed were the guard's own, while writes went to the real store
(NOT-138). `scripts/vitest/shared-build-guard.mjs`, called from the global setup, now
refuses to start a run unless the build a package will actually load is no older than
`packages/shared/src` **and** still throws for the real store. Both failures name the
rebuild; neither lets a suite be collected.

| Need | Do |
|------|-----|
| A test needs its own store | `fs.mkdtemp()` + set `AGENT_DECK_HOME`, restore after |
| Assert default path resolution | `AGENT_DECK_ALLOW_REAL_HOME_IN_TESTS=1` — read-only assertions, never a write |
| See what a run wrote | `AGENT_DECK_KEEP_TEST_HOME=1 npm test` — teardown prints and keeps the temp store |
| Tests refuse to start on a stale build | `npm run build` (Turbo does this before `npm test`; running `vitest` inside a package does not) |
| Knowingly test against an older build | `AGENT_DECK_SKIP_SHARED_BUILD_CHECK=1` — skips the mtime check only; the guard probe still runs |

---

## MCP testing — best practice (what works here)

Hosts (Cursor / Claude) are **not** in CI. Treat MCP as a **protocol server** we own:

| Practice | How |
|----------|-----|
| **1. Unit the handlers** | Pure functions (`executeManageDeckCard`, profile lists) — no ports |
| **2. Contract-test the wire** | Real `AgentDeckMCPServer` via `startMcpServer()` — binds **OS-assigned** `port: 0` (not a random 36k pool; parallel Vitest workers collided there — NOT-47) |
| **3. Stub the backend** | Tiny `http.createServer` (already in `mcp-server.http.test.ts`) — assert paths/bodies, not full SQLite unless needed; unhandled routes must fail the suite |
| **4. Snapshot the catalog** | `tools/list` names must match profile (guards accidental tool sprawl / renames) |
| **5. One golden agent path** | Bind → get_bound_deck → (optional manage_deck_card) → get_playbook — against stub or temp DB |
| **5b. Authenticated concurrent path** | `session-local.http.test.ts` — grant/admin bypasses off, real HTTP policy, overlapping tool calls, same-deck bind idempotency (NOT-84 / NOT-47) |
| **6. Do not wait on host `list_changed`** | Dynamic tools are host-blocked; do not invent flaky host tests |

**Anti-patterns:** only unit-testing registration without `tools/list`; only manual Cursor clicks; testing OAuth browser flows in MCP suite.

---

## Gaps after 1.3.0 (priority)

| Priority | Gap | Suggested home |
|----------|-----|----------------|
| Done | Golden MCP path: bind + `get_bound_deck` + `manage_deck_card` link/unlink | `golden-path.http.test.ts` |
| Done | Catalog snapshot for `standard` over HTTP | `golden-path.http.test.ts` (+ `profile.test.ts` unit) |
| P1 | CLI `service|playbook|deck delete` command wiring | `packages/cli` thin tests or extend `cli-runtime` |
| P1 | Harness template never mentions removed tools | `agent-harness.test.ts` (partial — checks `get_bound_deck`) |
| P2 | FE: deck editor link/unlink still works with API (not MCP) | Component or route tests; optional later Playwright |
| P2 | Release smoke: harness file contains `get_bound_deck` after setup | `release-smoke.sh` |

---

## Integration scenarios (fill with product owner)

Use this table to decide what we automate next. Mark **Auto** (CI), **Smoke** (release script), or **Manual**.

| ID | Scenario | Actor | Surface | Expected | Auto / Smoke / Manual |
|----|----------|-------|---------|----------|------------------------|
| S1 | Fresh install → setup cursor → harness names new tools | User | CLI | `get_bound_deck` in rule file; no `list_playbooks` | **Smoke** (`release-smoke.sh`) + **Auto** (`agent-harness.test.ts`) |
| S2 | Agent bind workspace + deck | Agent | MCP | `display_summary` + live-display | **Auto** (`golden-path.http.test.ts`) |
| S3 | Capability rescue | Agent | MCP | link service; `get_bound_deck`; `call_service_tool` | **Auto** |
| S4 | Playbook discover + follow | Agent | MCP | triggers on `get_bound_deck`; `get_playbook` body | **Auto** |
| S5 | Playbook self-improve (proposal queue) | Agent | MCP + dashboard | `propose_playbook_patch` → review → accept; genesis + update cases | **Manual** — [LEARNING_LOOP_TEST_SCENARIOS.md](./LEARNING_LOOP_TEST_SCENARIOS.md) |
| S6 | Link existing card to deck | Agent | MCP | `manage_deck_card` link | **Auto** |
| S7 | Unlink card | Agent | MCP | unlink; still in `list_collection` | **Auto** |
| S8 | Create deck then bind | Agent | MCP | `create_deck` + bind known deck | **Auto** |
| S9 | Delete service blocked by playbook dep | User | CLI | delete fails with message | **Auto** (`cli-runtime.test.ts`) |
| S10 | Delete playbook | User | CLI | delete succeeds | **Auto** (`cli-runtime.test.ts`) |
| S11 | Dashboard drag card onto deck | User | FE + API | link/unlink service, credential, playbook via REST | **Auto** (`useDragAndDrop.deck-link.test.tsx`) |
| S12 | Old playbook still says `list_playbooks` | Agent | MCP | tool missing — migration doc / legacy profile | Manual / CHANGELOG |
| S13 | Stale host tool cache after upgrade | User | Host | restart Cursor/Claude required | Manual / CHANGELOG |
| S14 | Statusline bound line (badge + deck name) | Host | CLI | `runStatusline` prints `displayLine` from `/api/scope/display` | **Auto** (`display-surfaces.http.test.ts`) |
| S15 | Statusline offline when API down | Host | CLI | `◆ Agent Deck offline` | **Auto** |
| S16 | Menubar live sessions | Host | CLI | `runMenubar` renders `/api/scope/bindings` | **Auto** |
| S17 | Menubar offline | Host | CLI | `◆ off` title, no badge | **Auto** |
| S18 | Menubar plugin script | User | CLI | install writes executable `agent-deck.3s.sh` calling `menubar` | **Smoke** + **Auto** (`menubar-setup.test.ts`) |

### Test files (1.3.0)

| File | Scenarios |
|------|-----------|
| `packages/backend/src/mcp-tools/test-harness.ts` | Shared MCP HTTP helpers (`port: 0`, strict console capture) |
| `packages/backend/src/mcp-tools/test-harness.port.test.ts` | Parallel OS-assigned bind (NOT-47) |
| `packages/backend/src/mcp-tools/golden-path.http.test.ts` | S2–S8 + catalog snapshot |
| `packages/backend/src/mcp-tools/session-local.http.test.ts` | Authenticated concurrent / idempotent bind (NOT-84) |
| `packages/backend/src/mcp-tools/profile.test.ts` | Profile tool lists |
| `packages/backend/src/mcp-tools/deck-card-ops.test.ts` | Link/unlink/reorder unit |
| `packages/backend/src/cli-runtime.test.ts` | S9–S10 |
| `packages/cli/src/agent-harness.test.ts` | S1 template names |
| `packages/cli/src/collection-admin.test.ts` | CLI arg wiring |
| `apps/agent-deck/src/test/hooks/useDragAndDrop.deck-link.test.tsx` | S11 FE link/unlink |
| `packages/cli/src/display-surfaces.http.test.ts` | Bound statusline + menubar vs HTTP stub |
| `packages/cli/src/statusline*.test.ts`, `menubar*.test.ts` | Unit render, setup, host stdin contract |
| `scripts/release-smoke.sh` | S1 harness + statusline stdout + menubar plugin script |

---

## Commands cheat sheet

```bash
npm test                                    # all packages
npm test --workspace packages/backend       # includes MCP HTTP + mcp-tools
npm test --workspace packages/cli
npm test --workspace apps/agent-deck
npm run smoke:dev                           # live ports health
npm run release:smoke                       # pack + setup user path
```
