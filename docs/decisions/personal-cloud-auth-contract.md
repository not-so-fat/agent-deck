# Decision: personal-cloud V1 auth contract (bearer grants, deck header as request-only)

**Status:** Accepted (investigation, NOT-56) · **Date:** 2026-10-03
**Scope:** client-facing wire contract for a single-owner hosted Agent Deck
**Implements nothing.** Production auth boundary is unchanged by this ticket.
Non-goals (NOT-318 owns them): grant persistence, MCP auth middleware,
dashboard login, vault work, deployment packaging.
**Related:** NOT-317 (parent), NOT-318 (remote grants implementation),
NOT-84 / NOT-105 / NOT-50 / NOT-101 / NOT-204 (session contracts preserved),
[PRD_TRUSTED_AGENT_SESSIONS.md](../PRD_TRUSTED_AGENT_SESSIONS.md),
[DIRECTION.md](../DIRECTION.md), [OAUTH_AND_HOSTING.md](../OAUTH_AND_HOSTING.md).

## 1. Decision (one paragraph)

V1 remote access uses **per-agent high-entropy bearer grants** sent as
`Authorization: Bearer <grant-secret>` on the existing Streamable HTTP
`/mcp` endpoint. The existing `x-agent-deck-deck-id` header **requests** a
deck but **never authorizes** one: on a public endpoint the header alone is
worthless and the request fails closed. Local
`stdio → mcp-launch → local HTTP` sessions keep working with **no bearer**,
exactly as today; the hosted appliance opts into bearer enforcement with
an explicit `AGENT_DECK_MCP_REQUIRE_BEARER=1` setting (§4.6), never
peer-address detection. MCP OAuth (authorization server, PKCE, dynamic
client registration) is **not** part of V1; §7 specifies the minimum OAuth contract
as a separately-scoped child ticket to be built only if a required launch
client is shown (by a §3-style proof) to have no static-header field.

## 2. Compatibility matrix (Grok, Codex, Claude)

**Source status (human-verified):** every row below was verified by a
human-side pass with network access on **2026-10-03** (AC1 satisfied by
that pass; no in-session re-fetch needed and none attempted). Quotes are
paraphrase-grade -- an operator may eyeball the cited pages once. Key for
the remaining open cell:

- `operator follow-up`: dated proof still wanted, but explicitly **not** a
  merge blocker (see section 3).

**Codex CLI and Claude Code are local CLIs, not cloud agents** -- so the
matrix separates CLI surfaces (V1 static bearer grants) from
cloud-connector surfaces. Independent-cloud-agent coverage comes from the
xAI API remote-MCP surface (P3) and the Claude.ai connector surface (P4).

| Client | Custom Streamable HTTP endpoint | Static `Authorization` header | MCP OAuth discovery | Auth-code + PKCE | Dynamic client registration / alternative | Config surface / notes |
|---|---|---|---|---|---|---|
| **Claude Code (CLI)** | Yes -- `claude mcp add --transport http <name> <url>` registers remote HTTP servers (captured 2026-10-03) | Yes -- `--header "Authorization: Bearer your-token"` (flags `-t`/`-H`). The docs do **not** say `--header` is repeatable, so only a single header is claimed (captured 2026-10-03) | Yes -- OAuth 2.0 supported (captured 2026-10-03) | Yes -- browser-based authorization with PKCE where the server demands it (captured 2026-10-03) | DCR is optional; otherwise `--client-id` / `--client-secret` / `--callback-port` (captured 2026-10-03) | CLI + `~/.claude.json`. Source: `https://code.claude.com/docs/en/mcp.md` (captured 2026-10-03 -- preflight P1). NOTE: `https://support.anthropic.com/en/articles/11175166` was cited in a prior round as a "Claude Code MCP guide"; it is a support article about custom connectors, not the Claude Code docs -- it is cited only for the Claude.ai row below (preflight P4) |
| **Codex CLI** | Yes -- `[mcp_servers.<name>]` with `url` (required, Streamable HTTP) (captured 2026-10-03) | Yes -- documented bearer mechanism is `bearer_token_env_var`; `http_headers` is a static map (the ADR's earlier `http_headers`-Authorization example is not the documented bearer path) (captured 2026-10-03) | Yes -- third-party MCP OAuth is supported, not ambiguous: `codex mcp login <server>` (captured 2026-10-03) | Yes -- via the OAuth login flow (captured 2026-10-03) | `codex mcp add --oauth-client-id` for hosts that need a pre-registered client; DCR otherwise (captured 2026-10-03) | File config (`config.toml`) keys `url`, `bearer_token_env_var`, `http_headers`, `auth`; differences from Claude: headers live in TOML/env, not CLI flags. Source: `https://learn.chatgpt.com/docs/extend/mcp?surface=cli` (captured 2026-10-03 -- preflight P2; the old `https://developers.openai.com/codex/mcp/` 308-redirects here). The old `.../codex/cli/config/` page redirects to `https://learn.chatgpt.com/docs/cli/config`, which 404s: cite only the mcp page |
| **Grok (xAI API remote MCP tools + "Grok Bot" target)** | xAI API: yes -- remote MCP tools over Streaming HTTP and SSE only (captured 2026-10-03). `https://docs.x.ai/docs/guides/mcp` is a **404**; the working page is `https://docs.x.ai/docs/guides/tools/remote-mcp-tools` (captured 2026-10-03) | xAI API: yes -- `authorization` parameter ("a token that will be set in the Authorization header", paraphrase grade) plus a `headers` map; i.e. the xAI API accepts a static bearer (captured 2026-10-03). No OAuth statement on the page | No OAuth statement on the working page (captured 2026-10-03) | Unknown -- no statement, not claimed | Unknown -- no statement, not claimed | Params: `server_url`, `authorization`, `headers`. Surfaces: xAI native SDK, OpenAI-compatible Responses API, Speech to Speech API. Server must be publicly reachable. The grok.com **"Grok Bot" surface remains UNVERIFIED** -- `operator follow-up` (section 3), explicitly not a merge blocker |
| **Claude.ai custom connectors (cloud surface)** | Yes -- custom connectors accept third-party server URLs; servers must be reachable over the public internet (captured 2026-10-03) | **Yes -- fixed credentials are supported**, differing from the ADR's earlier OAuth-only assumption: connectors can "add fixed credentials such as API keys that Claude sends on every request if your MCP server authenticates with an API key, bearer token, or other fixed credential instead of OAuth" (paraphrase-grade quote, captured 2026-10-03). Note: confirm the exact header-field UI at the operator proof | Yes -- OAuth connectors supported alongside fixed-credential ones (captured 2026-10-03) | Yes -- via the OAuth connector path (captured 2026-10-03) | Partner/OAuth-app registration or DCR per the connector docs (captured 2026-10-03) | Auth options: "Sign in now", "Sign in when needed", "No sign in". Source: `https://support.anthropic.com/en/articles/11175166` (301 to `https://support.claude.com/en/articles/11175166`, captured 2026-10-03 -- preflight P4) |
| **ChatGPT web connectors (independent cloud-agent reference)** | Team/Enterprise connectors accept MCP servers; exact auth fields were not part of the human pass and stay unverified here | Unverified -- out of V1 unless proven. | Expected (OAuth-native surface) -- unverified here | Expected -- unverified here | Vendor partner registration or DCR -- unverified here | No URL cited (none was consulted); operator supplies the canonical doc URL in the section 3 record if this surface becomes required. Listed so "independent cloud agent" coverage is explicit alongside P3/P4. |

Static-header and OAuth support are recorded in separate columns per the
acceptance criterion. V1 consequence: per-agent static credentials for
Claude Code (P1), Codex CLI via `bearer_token_env_var` (P2), the xAI API
remote-MCP surface (P3), and Claude.ai fixed-credential connectors (P4) are
the V1 mechanism. MCP OAuth stays out of V1 and is specified only as a
conditional child scope (section 7): cloud-connector surfaces without a
proven static-header field (ChatGPT web, the unverified grok.com bot
builder) are out of V1 until a section-3-style proof shows a static-header
field, and a required client without one triggers the section 7 OAuth
child instead of reopening the bearer-grant decision.

### 2.1 Operator preflight (docs verification -- human pass complete 2026-10-03)

Each item below was opened by the human-side pass on **2026-10-03**;
capture date per item is recorded here. No implementation starts or stops
on these.

- **P1 (verified 2026-10-03):** `https://code.claude.com/docs/en/mcp.md` --
  CONFIRMED `claude mcp add --transport http <name> <url>` and `--header
  "Authorization: Bearer your-token"` (`-t`/`-H`). Docs do NOT say
  `--header` is repeatable: only a single header is claimed. OAuth 2.0
  supported; DCR optional, else `--client-id` / `--client-secret` /
  `--callback-port`.
- **P2 (verified 2026-10-03):**
  `https://learn.chatgpt.com/docs/extend/mcp?surface=cli` (the old
  `https://developers.openai.com/codex/mcp/` 308-redirects here; cite the
  new URL) -- CONFIRMED `[mcp_servers.<name>]` keys `url` (required),
  `bearer_token_env_var`, `http_headers` (static map), `auth`.
  `bearer_token_env_var` is the documented bearer mechanism (the ADR's
  earlier `http_headers`-Authorization example is not the documented path).
  OAuth: `codex mcp login <server>` and `codex mcp add --oauth-client-id`,
  so third-party MCP OAuth is NOT ambiguous. The old
  `.../codex/cli/config/` page redirects to
  `https://learn.chatgpt.com/docs/cli/config`, which 404s: cite only the
  mcp page.
- **P3 (verified 2026-10-03; bot surface still open):**
  `https://docs.x.ai/docs/guides/mcp` is a **404**. Working page
  `https://docs.x.ai/docs/guides/tools/remote-mcp-tools`: remote MCP tools
  in the xAI native SDK, OpenAI-compatible Responses API, and Speech to
  Speech API; params `server_url`, `authorization` ("a token that will be
  set in the Authorization header", paraphrase grade), `headers`; only
  Streaming HTTP and SSE; no OAuth statement. The xAI API accepts a static
  bearer. The grok.com "Grok Bot" surface remains UNVERIFIED (operator
  proof, section 3). Server must be publicly reachable.
- **P4 (verified 2026-10-03; DIFFERS from the ADR's earlier assumption):**
  `https://support.anthropic.com/en/articles/11175166` (301 to
  `https://support.claude.com/en/articles/11175166`) -- Claude.ai custom
  connectors DO support fixed credentials ("add fixed credentials such as
  API keys that Claude sends on every request if your MCP server
  authenticates with an API key, bearer token, or other fixed credential
  instead of OAuth", paraphrase grade). Auth options: "Sign in now",
  "Sign in when needed", "No sign in". Servers must be reachable over the
  public internet. The ADR's earlier "bearer-only V1 does NOT serve this
  surface" conditional does not hold; keep a note to confirm the
  header-field UI at the operator proof.

## 3. Grok Bot target -- operator connection proof (explicit follow-up, NOT a merge blocker)

Docs side (human-verified 2026-10-03, section 2.1 P3): the xAI API
remote-MCP page confirms a static bearer (`authorization` parameter) over
Streaming HTTP/SSE, with the server publicly reachable. The grok.com
"Grok Bot" surface itself remains UNVERIFIED. A live connection proof
against that surface is an explicit operator follow-up: it is wanted for
any "Grok Bot works" claim, but it does not block NOT-318 or the V1
bearer-grant decision, which rests on the proven static-header clients
(Claude Code, Codex CLI, xAI API, Claude.ai fixed-credential connectors).

No operator-assisted proof was run in this investigation (sandbox: no
network egress, no Grok credentials, no reachable appliance). Until the
section 3.2 bot-proof row is filled, "Grok support" means the xAI API
static-bearer path (P3, docs-proven) plus an open bot-surface proof --
never "Grok Bot works". "Claude support" in V1 means Claude Code CLI (P1)
plus Claude.ai fixed-credential connectors (P4, header-field UI to confirm
at the proof).

### 3.1 Proof procedure (smallest real client connection)

1. Deploy (or expose) the appliance per NOT-318 with one test grant and one
   test deck; record the public URL form used
   (expected: `https://<owner-host>/mcp`).
2. In the candidate Grok product surface, register a custom MCP server with
   that URL and a static `Authorization: Bearer <grant-secret>` header (or
   the surface's nearest equivalent); screenshot/record the exact fields.
3. Send `initialize` and one `tools/list`; record the observed result
   (success with tool list, auth error text, or "unsupported" surface
   behavior) with timestamp.
4. If the surface has no static-header field, attempt its OAuth flow against
   the appliance and record where it fails (discovery document, callback,
   client registration) — that outcome triggers the §7 OAuth child scope.

### 3.2 Record (preflight filled by the human pass; bot proof is operator follow-up)

| Field | Value |
|---|---|
| Preflight P1 | `https://code.claude.com/docs/en/mcp.md`, captured 2026-10-03: CONFIRMED `claude mcp add --transport http <name> <url>`, single `--header "Authorization: Bearer your-token"` (`-t`/`-H`, repeatability not stated); OAuth 2.0 with optional DCR |
| Preflight P2 | `https://learn.chatgpt.com/docs/extend/mcp?surface=cli`, captured 2026-10-03: CONFIRMED `[mcp_servers.<name>]` keys `url`, `bearer_token_env_var` (documented bearer mechanism), `http_headers`, `auth`; OAuth via `codex mcp login <server>` / `--oauth-client-id` (third-party OAuth NOT ambiguous) |
| Preflight P3 | `https://docs.x.ai/docs/guides/tools/remote-mcp-tools`, captured 2026-10-03 (`https://docs.x.ai/docs/guides/mcp` is a 404): remote MCP tools with `server_url` / `authorization` (static bearer) / `headers`; Streaming HTTP and SSE only; no OAuth statement; server must be publicly reachable |
| Preflight P4 | `https://support.claude.com/en/articles/11175166` (from `https://support.anthropic.com/en/articles/11175166`, 301), captured 2026-10-03: Claude.ai connectors DO support fixed credentials (API key / bearer token); auth options "Sign in now" / "Sign in when needed" / "No sign in"; public-internet reachability required |
| Product surface (bot proof, TBD) | _e.g. grok.com bot builder custom MCP -- TBD (operator follow-up)_ |
| URL form (bot proof, TBD) | _TBD_ |
| Auth configuration (bot proof, TBD) | _TBD (static bearer / OAuth fields)_ |
| Date (UTC) (bot proof, TBD) | _TBD_ |
| Observed result (bot proof, TBD) | _TBD (tool list / error text / unsupported)_ |

Until the bot-proof rows are filled, "Grok Bot works" must never be claimed: "Grok support" in V1 means the docs-proven xAI API static-bearer path plus an open bot-surface follow-up. "Claude support" in V1 means Claude Code CLI (P1) and Claude.ai fixed-credential connectors (P4, header-field UI to confirm at the proof).

## 4. Frozen V1 wire contract

Base: the existing Streamable HTTP transport (`POST/GET/DELETE /mcp`,
`mcp-session-id` response header, JSON-RPC bodies) is unchanged. What freezes
here is authentication and deck selection on top of it.

### 4.1 Credential placement and format

- Placement: `Authorization: Bearer <grant-secret>` HTTP header, sent on
  **every** `/mcp` request (initialize and follow-ups). No query parameter,
  no cookie, no custom header — proxies and logs handle `Authorization`
  predictably and clients already support it (§2).
- Format: an opaque per-agent grant secret, `adg_<grantId>_<secret>`, where
  `<secret>` carries ≥256 bits of entropy from a CSPRNG and is shown **once**
  at issuance. The id prefix is routing-only (which grant was presented);
  it confers nothing by itself.
- Server side (NOT-318): store only a SHA-256 hash of `<secret>`, compare in
  constant time, and map the grant to `{ principal: owner, allowedDecks: […],
  defaultDeck, issuedAt, expiresAt }`. The secret never appears in logs,
  error bodies, or the dashboard after issuance.

### 4.2 Missing / invalid / expired / revoked — one behavior each, no oracle

All four credential failures return the **same** HTTP status and body shape
so a prober cannot distinguish "wrong secret" from "revoked grant":

| Case | HTTP | Body (`error.message`) | MCP session result |
|---|---|---|---|
| Missing credential (public endpoint, no `Authorization` header) | `401` | `GRANT_REQUIRED` | No session created on initialize; follow-up on an existing transport fails, **transport kept** so a correct credential on the next attempt can succeed (same keep-alive rule as `requireFollowUpDeckHeader` in `packages/backend/src/mcp-server.ts`) |
| Invalid credential (unknown id / secret mismatch) | `401` | `GRANT_REQUIRED` | Same as missing |
| Expired credential (`expiresAt` passed) | `401` | `GRANT_REQUIRED` | Same as missing |
| Revoked credential (grant revoked; see §4.5) | `401` | `GRANT_REQUIRED` | Same as missing; already-established transports fail closed on their **next** request — revocation is enforced per request, never cached past it |

Rules: `401` (never `403`) for every credential failure; identical JSON-RPC
envelope `{ jsonrpc: "2.0", error: { code: -32001, message:
"GRANT_REQUIRED" }, id: null }` plus one constant `WWW-Authenticate: Bearer`
response header (RFC 7235 / RFC 6750 challenge with no realm and no error
detail — byte-identical on every 401, so it leaks no grant state; it keeps
generic HTTP clients well-behaved and matches the §7 OAuth child, which
requires a challenge); deck-identifying
detail (`unknown deck`, `grant revoked at …`) never appears. Machine-readable
fixture: `docs/decisions/fixtures/personal-cloud-auth-contract.examples.json`.

### 4.3 Session initialization vs. follow-up requests

- `POST /mcp` carrying an MCP `initialize`: authenticate the bearer **before**
  advertising any `mcp-session-id`. Failure → §4.2 row, no session id
  minted, nothing to recover. Success → fresh MCP transport session bound to
  the grant's resolved deck (§4.4), then the normal handshake continues.
- Follow-up `POST` (notifications/tools), `GET` (SSE stream), `DELETE`
  (session close) with `mcp-session-id`: re-resolve grant → allowed-decks on
  **every** request. Unknown session id keeps the existing NOT-101 behavior
  (`404` + `mcp-session-status: expired` so the client re-initializes) —
  but **only after the bearer-grant check passes**.
- **Check order on hosted endpoints (no oracle): bearer-grant gate (see §4.2), then session
  existence, then deck scope (§4.4).** Reason: the current 404 body echoes the
  presented session id plus `instanceId`/`startedAt`
  (`packages/backend/src/mcp-server.ts`, `sendSessionExpired`), so answering
  404-before-401 would let an unauthenticated prober distinguish live from
  dead session ids and harvest instance metadata. In hosted mode an
  unauthenticated request with an unknown session id therefore gets `401
  GRANT_REQUIRED` (fixture `authOrder` case), never the 404. Local loopback
  mode keeps the current order (no bearer-grant gate configured).
- A follow-up that changes nothing (same bearer, same deck header) is a
  no-op revalidation: it must not rotate sessions, reset leases, or log
  secrets.

### 4.4 Default deck and allowed-deck selection (header requests, never authorizes)

- `x-agent-deck-deck-id` is an **optional requested deck constrained by the
  authenticated principal**. Semantics, in order:
  1. No bearer (public endpoint) + any deck header → `401 GRANT_REQUIRED`.
     The header is ignored as authentication, exactly as today it is trusted
     only because the listener is loopback-oriented.
  2. Valid bearer + no deck header → the grant's `defaultDeck`.
  3. Valid bearer + deck header naming a deck in `allowedDecks` → that deck
     for this session (session-scoped selection; does not rewrite the grant).
  4. Valid bearer + deck header naming a deck **outside** `allowedDecks` →
     `403 RESOURCE_OUT_OF_SCOPE`, transport kept. `403` here is safe: it is
     only reachable *after* successful authentication, so it oracles the
     allowlist solely to the already-authenticated owner.
- V1 is one installation and one owner: `allowedDecks` normally lists every
  deck on the appliance and `defaultDeck` is the owner's main deck. The
  allowlist exists so a compromised per-agent grant can be scoped down (and
  so a future tenancy migration has a field to partition on), not to share
  decks between people.
- **Switch requests vs. the allowlist (NOT-203/209 reconciled):** an approved
  `switch_deck` (This session only or This workspace by default, NOT-209)
  still cannot land on a deck outside the grant's `allowedDecks` — the
  switch is denied (session stays on its current deck) rather than widening
  the grant. `get_decks` enumeration stays scoped to the session's active
  deck exactly as NOT-203 ships it; the grant allowlist does not add a
  second directory. The bearer-grant gate decides which decks a session may see; the human-approved
  switch selects among them. It never widens them.

### 4.5 Revocation of existing sessions

- Revoking a grant (dashboard action, NOT-318) flips the grant record to
  revoked; every transport bound to it fails its **next** request with
  `401 GRANT_REQUIRED` per §4.2 (fail closed, no grace window).
- Closing semantics reuse the shipped lifecycle: transport close, explicit
  runtime-session close, revocation, server restart, or 24-hour inactivity
  ends the session ([PRD_TRUSTED_AGENT_SESSIONS.md](../PRD_TRUSTED_AGENT_SESSIONS.md)
  C3). Revocation additionally ends the backend runtime session immediately.
- Re-issuing a grant for the same agent produces a **new secret**; the old
  secret never reactivates. There is no "un-revoke".

### 4.6 Local-launch compatibility (unchanged)

- Loopback listeners (`127.0.0.1` / `localhost`, the `mcp-launch` bridge
  target) keep accepting the deck header with **no bearer**, exactly as
  `authenticateLaunchDeck` / `requireFollowUpDeckHeader` behave today.
  `stdio → mcp-launch → local HTTP` sessions must not require remote bearer
  grants — local-first stays zero-friction.
- The bearer-grant gate activates **only** via an explicit hosted-mode setting,
  `AGENT_DECK_MCP_REQUIRE_BEARER=1` (NOT-318 implements it): when set, every
  `/mcp` request requires a valid grant secret (see §4.2) **regardless of peer
  address**. Peer-address detection is explicitly rejected as the trigger,
  because the standard appliance setup (Caddy/nginx terminating TLS and
  forwarding to loopback) makes all internet traffic arrive over loopback:
  a "public interface" check would see only localhost and accept the deck
  header alone, preserving the current trust-the-header model on a public
  endpoint. `X-Forwarded-For` / `X-Forwarded-Proto` are never trusted for
  auth decisions (client-spoofable).
- Appliance deployment MUST set `AGENT_DECK_MCP_REQUIRE_BEARER=1`; the local
  launcher (`agent-deck mcp-launch`, `AGENT_DECK_HOST` default `127.0.0.1`)
  never sets it, so loopback sessions stay bearer-free with zero config
  change. The flag defaults to unset (local behavior today); there is no
  auto-detection.
- `AGENT_DECK_MCP_SKIP_DECK_HEADER=1` remains a unit-test escape hatch only;
  it must never be set by the hosted appliance.

## 5. Local behavior explicitly preserved

Nothing in §4 changes these shipped contracts (verified against the current
tree: `packages/backend/src/mcp-server.ts`, `mcp-session-binding.ts`,
`mcp-unassigned.ts`, `packages/cli/src/mcp-launcher.ts`,
`packages/backend/src/mcp-tools/register.ts` for `get_decks`/`switch_deck`):

- **Launcher:** `agent-deck mcp-launch` reads the folder assignment
  (`<folder>/.agent-deck/use.json` v3) and connects with
  `x-agent-deck-deck-id` + workspace headers. No bearer, no config change.
- **Unassigned sessions (NOT-50):** connections with no deck header become
  explain-only sessions (`No deck assigned…`, `GRANT_REQUIRED` guidance) —
  never HTTP 401-as-OAuth. A late deck header must not promote an
  unassigned session mid-flight. Loopback-only note: §4.4 rule 2 maps
  a valid bearer plus no deck header to `defaultDeck`, so hosted mode never
  produces unassigned sessions — NOT-50 explain-only sessions occur on
  loopback only, and NOT-318 must not apply NOT-50 to hosted mode.
- **Session switching (NOT-204):** agents request via `switch_deck`; humans
  approve as **This session only** or **This workspace by default**.
  Pending/declined requests change nothing and expose nothing from the
  target deck. Bearer auth wraps this mechanism; it does not replace it — and an approved
  switch can never land outside the grant's allowedDecks (see deck-selection
  rules). Approval scopes (session vs. workspace default) are unchanged.
- **Deck enumeration (NOT-203):** `get_decks` stays scoped to the session's
  active deck. The grant allowlist is enforced at session bind, not
  by changing enumeration; there is no cross-deck directory in V1.
- **Elevation:** ephemeral `agent-admin` (challenge → dashboard approval →
  30-minute lease) is unchanged and orthogonal: a bearer selects *which
  decks* the session may see; elevation selects *what* the session may do.
  The deck header never elevates.
- **Restart recovery (NOT-101):** unknown `mcp-session-id` → `404` so the
  client re-initializes; the re-handshake re-authenticates under §4.3.

## 6. Product boundary (personal appliance vs. shared hosting)

The following statements are normative for V1 and are mirrored in
[DIRECTION.md](../DIRECTION.md), [OAUTH_AND_HOSTING.md](../OAUTH_AND_HOSTING.md),
and [OAUTH_REQUIREMENTS.md](../OAUTH_REQUIREMENTS.md):

1. A **personal hosted appliance** (single-owner, self-operated, bearer
   grants) is **supported work** — it is no longer "archive" or deferred.
2. **Managed multi-user SaaS is not being launched**: no public signup, no
   invitations, no billing, no quotas, no cross-user deck sharing.
3. The first friend path is an **isolated deployment** (their own appliance,
   their own grants, their own decks — the D2 "friend runs their own copy"
   model extended from laptop to host), not shared tenancy.
4. Future shared hosting — if ever pursued — must cross explicit,
   replaceable boundaries (identity / grant store / deck store / vault) and
   still requires a **separate tenancy migration** (per-user principals,
   per-tenant isolation, audited cross-tenant denial). Nothing in §4 assumes
   or pre-builds it: the grant record carries a single `principal: owner`
   precisely so a migration has something to partition later.

## 7. OAuth: not V1, specified as a conditional child scope

Per-agent bearers satisfy the V1 launch clients (Claude Code accepts a
static Authorization header per P1, Codex CLI documents
`bearer_token_env_var` per P2, the xAI API accepts a static bearer per P3,
and Claude.ai connectors support fixed credentials per P4).
Standards-based MCP OAuth is therefore deferred. It becomes
required **only if** a §3-style proof for a required client (for
example the grok.com bot surface, or ChatGPT web connectors) shows that
client has no static-header field. In that case the bounded child scope is:

- **Protected-resource metadata (RFC 9728):**
  `GET /.well-known/oauth-protected-resource` describing the `/mcp` resource,
  its authorization servers, and bearer schemes; `401`s carry a
  `WWW-Authenticate` challenge pointing at it.
- **Authorization server:** OAuth 2.1 authorization-code flow with PKCE
  (`S256`, `code_challenge` required, `plain` refused); confidential-client
  authentication for server-side clients; redirect-URI exact match.
- **Client registration:** Dynamic Client Registration (RFC 7591) preferred;
  alternatively a pre-registered client id for hosts that cannot do DCR —
  exactly one of the two must work for the proven surface, not both.
- **Token lifetimes:** access tokens ≤ 1 hour; refresh tokens rotating,
  single-use, bound to the grant; grant `expiresAt` caps both.
- **Revocation:** RFC 7009 revocation endpoint; revocation takes effect on
  the next MCP request (§4.5 semantics), and revoked refresh tokens never
  mint new access tokens.
- **Out of scope for that child too:** multi-user tenancy, public signup,
  billing — one owner, same as §6.

## 8. Estimates and NOT-318 handoff

Estimates are T-shirt sizes for planning, not commitments:

| Slice | Owner | Size | Notes |
|---|---|---|---|
| NOT-318: grant issuance + storage (hash, allowlist, default deck, expiry) | Builder | M | New table + dashboard/CLI issuance showing the secret once |
| NOT-318: MCP auth gate (bearer check before `mcp-session-id`, per-request revalidation, §4.2 uniform errors) | Builder | M | Touches `mcp-server.ts` hot path; keep transport-kept semantics |
| NOT-318: revocation + session teardown | Builder | S | Flip + fail-closed-next-request (§4.5) |
| NOT-318: hosted-mode flag + bearer-first order + docs | Builder | S | `AGENT_DECK_MCP_REQUIRE_BEARER` (§4.6), bearer-before-404 (§4.3); must not regress `mcp-launch` |
| §2.1 preflight P1-P2 (Claude/Codex static header) | Operator | XS | Human-verified 2026-10-03; premise confirmed, not NOT-318 start |
| §3 Grok Bot operator proof | Operator | S | Explicit follow-up for the bot-surface claim; not a merge blocker, not NOT-318 start |
| §7 OAuth child (conditional) | Separate ticket | L | Only if §3 proof demands it; bounded by the six bullets above |

NOT-318 comparison (human-verified 2026-10-03, AC7 satisfied): NOT-318
was read from Linear and compared against assumptions (a)-(h). Matches:
(a) opaque per-agent bearer grants, (b) deck header as request-only,
(c) loopback launcher compatibility, (d) single-owner scope,
(g) approved switch_deck cannot leave allowedDecks with get_decks scoping
unchanged, (h) V1 client scope is static-header-capable clients only.
MISSING in NOT-318: (e) the `AGENT_DECK_MCP_REQUIRE_BEARER` hosted flag
(§4.6) and (f) the bearer-before-404 check order (§4.3) --
NOT-318 must add both before implementation starts. Revocation: the ADR's
next-request fail-closed rule (§4.5) satisfies the ticket's 60s
bound. The result was posted as Linear comment
456d340c-c3ff-4866-8f96-41fce6b7a6bb on NOT-318.

Coordinator steps (Linear issue `NOT-318`, per-agent remote grants):
1. confirm assumptions (a)-(d), (g), (h) still match the issue as written;
2. edit NOT-318 to add the two missing items: (e) explicit hosted-mode
   flag, never peer-address detection (§4.6); (f) bearer-before-404
   check order on hosted endpoints (§4.3);
3. if a section 3 follow-up proof has by then shown a required client with
   no static-header field, split the section 7 OAuth bullets into a bounded
   child ticket -- OAuth must not ride inside NOT-318.

## 9. Verification performed here (and what runs later)

- Targeted test: `personal-cloud-auth-contract.examples.test.ts` asserts the
  fixture is self-consistent (uniform §4.2 401 envelope plus the constant
  `WWW-Authenticate: Bearer` challenge, no secret/deck
  detail leakage, deck-selection 403 only post-auth, bearer-before-404
  `authOrder` case from §4.3). Run:
  `npm --workspace @agent-deck/backend run test -- personal-cloud-auth-contract`
- Text integrity: no scrubber placeholder tokens remain in this ADR, the
  test, or the fixture — a placeholder-token scan over all three returns 0
  matches. (The sentence is worded to avoid the literal token so the scan
  stays at zero.) The nine normative sentences a prior scrubber pass had
  replaced with a literal token now use the hyphenated `bearer-grant …`
  form (§4.3 check order, §4.4 allowlist gate, §4.6 hosted-mode trigger).
- Docs link check: every relative link in this ADR and the three updated
  product docs was resolved against the tree (see handoff; CI docs checks
  own the rest).
- Later (not this ticket): Grok Bot follow-up proof (§3.2), NOT-318 implementation,
  conditional OAuth child.

## Appendix — evidence pointers

- Current trust model: `packages/backend/src/mcp-server.ts`
  (`authenticateLaunchDeck`, `requireFollowUpDeckHeader` keep-transport rule),
  `packages/backend/src/mcp-session-binding.ts`,
  `packages/backend/src/mcp-unassigned.ts` (NOT-50),
  `packages/cli/src/mcp-launcher.ts` (assignment → deck header, no bearer).
- Session contracts: [PRD_TRUSTED_AGENT_SESSIONS.md](../PRD_TRUSTED_AGENT_SESSIONS.md)
  C3/C4/C9, [2026-09-20-session-deck-switching-redesign.md](../superpowers/specs/2026-09-20-session-deck-switching-redesign.md).
- Evidence: human-side documentation pass with network access on 2026-10-03
  (§2.1 P1-P4, AC1 satisfied; quotes are paraphrase-grade). In-session
  `curl` probes were not re-attempted per the human decision (the sandbox
  has no DNS egress; prior rounds recorded `Could not resolve host`, curl
  exit 6). The §2.1 preflight table above carries the per-URL capture record; the frozen
  mechanism is per-agent static credentials for the proven
  static-header-capable clients, and the grok.com bot-surface proof remains
  an explicit operator follow-up (§3.2), not a merge blocker.
- Design-source substitution: the ticket names
  `docs/superpowers/specs/2026-10-02-personal-cloud-agent-deck-design.md`
  (R1, section 2, section 5), but that file does not exist at this head.
  This ADR was reconciled
  against the ticket text instead (design-source file absent, verified by
  directory listing on 2026-10-03); if the spec lands, NOT-318 must reconcile
  it against sections 4-6 here and flag divergences.
