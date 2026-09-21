# Agent Deck — Technical Architecture

**Doc role:** Technical design (components, data, secrets)  
**Product behavior & MCP tools:** [MVP.md](./MVP.md) — source of truth for bound deck, agent API, terminology  
**Last aligned:** 2026-06-30

---

## Overview

Agent Deck is a local TypeScript monorepo: React dashboard, Fastify API, MCP proxy, SQLite + OS secret store. Agents connect to **one MCP endpoint**; the **bound deck** (workspace manifest or session bind) determines which MCP tools are visible.

---

## Why TypeScript end-to-end

- Shared types/schemas in `packages/shared` (Zod)
- Single runtime (Node) for API, MCP, CLI
- Vitest across packages

---

## System diagram

**Dev repo** (`npm run dev:all`): dashboard :3000, API :8000, MCP :3001, data `~/.agent-deck/dev/`  
**CLI / npx** (`agent-deck start`): dashboard + API :1111, MCP :1110, data `~/.agent-deck/`

See [SETUP.md](./SETUP.md#ports) for overrides.

```
┌─────────────┐     ┌─────────────┐
│  Dashboard  │     │ MCP server  │
│  (React)    │     │ (MCP SDK)   │
└──────┬──────┘     └──────┬──────┘
       │    REST + WS      │
       └─────────┬─────────┘
                 ▼
          ┌─────────────┐
          │ Backend API │
          │  (Fastify)  │
          └──────┬──────┘
                 ▼
          ┌─────────────┐     ┌──────────────┐
          │   SQLite    │     │ Keychain /   │
          │ agent_deck  │     │ dev secrets  │
          └─────────────┘     └──────────────┘
```

---

## Components

| Package / app | Path | Role |
|---------------|------|------|
| **Shared** | `packages/shared/` | Types, Zod schemas, shared utils |
| **Backend** | `packages/backend/` | Fastify API, SQLite, OAuth, vault, MCP server |
| **CLI** | `packages/cli/` | `start`, `setup`, `credential`, `exec`, harness installer |
| **Dashboard** | `apps/agent-deck/` | Collection, deck editor, OAuth UI, WebSocket updates |

MCP entry: `packages/backend/src/mcp-server.ts` · MCP process: `mcp-index.ts`

---

## Data model (SQLite)

Metadata in `agent_deck.db`; **secrets not in SQLite** (see [Secret storage](#secret-storage)).

| Table | Purpose |
|-------|---------|
| `services` | MCP / A2A / local-mcp cards, OAuth metadata |
| `decks` | Deck records (`is_active` legacy only) |
| `deck_services` | MCP cards on a deck + order |
| `credentials` | API key metadata |
| `deck_credentials` | Key cards on a deck |
| `playbooks` | Playbook card bodies + deps |
| `deck_playbooks` | Playbook cards on a deck |
| `exec_runs` | CLI exec audit |

Canonical types: `packages/shared/src/schemas/`. Credential yaml mirror: `~/.agent-deck/credentials/*.yaml`.

**Agent scoping:** bound deck via workspace — [MVP.md](./MVP.md) Module 1. Legacy `GET /api/decks/active` exists; agents use bound-deck paths only.

---

## Secret storage

Implementation: `packages/backend/src/vault/`.

| Class | Keychain / file account | SQLite retains |
|-------|-------------------------|----------------|
| API keys | `cred_{id}` | label, scheme, `env_name`, tags |
| OAuth client secret | `oauth-client-secret:{serviceId}` | client id, URLs, scope |
| OAuth tokens | `oauth-tokens:{serviceId}` | expiry, `oauth_has_token` |

**Flow:** `OAuthManager` writes tokens after exchange/refresh. `MCPClientManager` resolves tokens when opening a connection. API returns `oauthHasToken`, never bearer strings.

**Migration:** legacy plaintext in `services.oauth_*` migrates to Keychain on first read; duplicate `Authorization` in `headers` stripped.

**Performance:** Keychain ops are sub-ms to a few ms — negligible vs MCP network latency.

**Threat model:** protects casual DB copy; not a substitute for full-disk encryption or compromised user session.

---

## Local MCP servers

- Type `local-mcp`: stdio child process, started on demand
- Config import: `POST /api/local-mcp/import` (JSON / Cursor-style manifest)
- Routed through same MCP proxy as remote services once on the bound deck

---

## MCP & REST surfaces

**Do not duplicate here.** Full tool list, REST agent vs dashboard headers, and scoping rules:

→ **[MVP.md](./MVP.md)** (Modules 1–3, agent MCP tools, credential access)

High level:

- Agents: `bind_workspace` → tools on **bound deck** only
- Dashboard: `x-agent-deck-client: dashboard` for vault CRUD and OAuth browser flows
- Deprecated MCP aliases: `*_active_deck_*` → use `*_bound_deck_*`

### Session lifetime across restarts (NOT-101)

Transport sessions live in memory, so an upgrade, a crash, or `agent-deck stop && start`
invalidates every one of them. We do **not** persist sessions — we make the loss
recoverable:

1. The server answers an unknown `Mcp-Session-Id` with **404** and
   `mcp-session-status: expired`, the signal the streamable-HTTP spec tells clients
   to re-initialize on. An `initialize` carrying a stale id is accepted and issued a
   fresh session.
2. `agent-deck mcp-launch` runs a first-party stdio↔HTTP bridge
   (`packages/cli/src/mcp-bridge.ts`) that caches the client handshake, replays it on
   404, and retries the failed call. The stdio client above it never sees the gap.
   `AGENT_DECK_MCP_BRIDGE=supergateway` restores the old external bridge, which does
   **not** implement the reconnect half and stays wedged until its host restarts.
3. MCP `/health` exposes `instanceId`, `startedAt`, `liveSessions`, and a
   `staleSessions` tally so `agent-deck status` can say "clients are stranded on a
   pre-restart session" instead of a bare "running". Sessions this process issued
   and then closed are left out of it, so an ordinary end-of-session straggler never
   reads as a client left behind by a restart. The tally is cumulative for the life
   of the process, so it is split: a bridge names the session it lost on the
   replayed handshake (`x-agent-deck-recovered-session`), and once that handshake
   establishes a replacement session the lost one moves from `unresolvedSessions`
   to `recoveredSessions`. A handshake rejected on the way (launch-deck auth, a
   transport that fails to initialize) leaves it unresolved, because the client is.
   Recovery is not undone by a straggler: a request that was already on the wire
   when the restart hit arrives on the old id after its client reconnected, and the
   bridge answers it from the replacement session rather than handshaking again, so
   counting that id as stranded again would never be cleared. Only
   `unresolvedSessions` — supergateway and other clients that never re-initialize —
   earns a warning.

The bridge dispatches client messages concurrently; only the handshake and an
in-flight recovery gate them, so one hung tool call cannot starve the cancellation
that would end it. Because requests are concurrent, several can come back 404 for
the same invalidation: each one recovers the session *it* was sent on, so a late
404 reuses the session an earlier recovery already established instead of
handshaking again. A response body that dies mid-read is surfaced to the client as
an interrupted request rather than retried, because the server may already have
applied it.

The bridge must send the launch headers (`x-agent-deck-deck-id`,
`x-agent-deck-workspace`) on **every** request, not just `initialize` — the server
re-validates the launch deck per call.

> **Switching contract:** agent-initiated `switch_bound_deck` switching below is **superseded by** [Session/default deck-switching redesign](./superpowers/specs/2026-09-20-session-deck-switching-redesign.md) (NOT-204). Agents may only request a switch; a human approves it as This session only or This workspace by default.

**A replayed handshake can land on a different deck.** A session deck override
(`bind_workspace`) does not survive a restart, and `switch_bound_deck` can move the
folder assignment while the bridge is connected, so the launch headers it started
with are not necessarily the binding that is current. Before it replays, the bridge
re-reads the assignment, and after the new session exists it asks
`get_session_binding` which deck that session actually acts on. A pending request is
retried only when that deck is the one it was sent for; otherwise the client is told
the deck changed and re-binds itself, because silently replaying a mutation onto
another deck is worse than the gap.

When the client had *bound a deck itself*, that refusal is latched rather than
one-shot: every deck-scoped call (`tools/call` other than the binding tools,
`resources/read`) is answered with the same error until the client is back on the
deck it chose — it binds again, it re-initializes (a fresh handshake binds from the
launch headers and is a clean slate), or a later reconnect lands on that deck
anyway. A client that simply retried the failed call would otherwise have it
applied to the new deck without ever being told. The binding tools are never held
back, so they are also what discovers a *second* restart while the latch is up.
A client that never bound anything is not latched: it takes whatever deck the
folder assignment names now, which is the reconnect working as intended.

A binding answer only describes the session that produced it. A `bind_workspace`
whose reply crosses the restart — the server bound the deck, then the process went
away — says nothing about the replacement session, so the bridge tags every request
with the session generation it went out on and ignores binding results from an older
one. The client is told its binding was lost instead of being handed a success for a
deck it is not on, and the latch goes up so the call it sends next is held rather
than applied to the deck the reconnect landed on.

---

## Key patterns

- **Validation:** Zod at API boundary (`packages/shared` schemas)
- **API shape:** `{ success, data?, error? }`
- **Real-time:** WebSocket ` /api/ws/events` for dashboard
- **Session bind:** in-memory per MCP session — `McpSessionBindingStore`
- **No backend LLM calls:** reasoning stays in external agents (Claude Code, Cursor, Codex, agent-dealer) — see [decisions/no-backend-llm-boundary.md](./decisions/no-backend-llm-boundary.md)

---

## Related docs

- [MVP.md](./MVP.md) — shipped product scope
- [SETUP.md](./SETUP.md) — install, ports, dashboard tour
- [DEVELOPMENT.md](./DEVELOPMENT.md) — contributor workflow
- [AGENT_HARNESS.md](./AGENT_HARNESS.md) — Cursor / Claude rules from `setup`
