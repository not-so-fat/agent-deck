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
as a separately-scoped child ticket to be built only if the Grok connection
proof (§3) shows a required launch client cannot send a static bearer.

## 2. Compatibility matrix (Grok, Codex, Claude)

**Source-status key (honest labels — no cell claims a fetch that did not
happen):**

- `cited — NOT live-fetched in-session`: the canonical official URL is given
  so an operator can verify it, but this sandbox has no network egress
  (`curl` → `Could not resolve host: code.claude.com` on 2026-10-03;
  re-probed 2026-10-03, same result (curl exit 6); escalated execution is
  forbidden by launch policy), so no page was inspected and no quote is
  reproduced here.
  A prior round labeled these cells "captured 2026-10-03" without fetching
  them; that label is withdrawn.
- `operator-must-confirm`: the V1 decision depends on this cell; it must be
  confirmed by the dated proof/preflight in §3 before NOT-318 ships.

No cell below is invented from a third-party blog: where the official docs
are ambiguous or unfetched, the cell says so and defers to §3. **Codex CLI
and Claude Code are local CLIs, not cloud agents** — so the matrix separates
CLI surfaces (V1 static-bearer scope) from cloud-connector surfaces
(explicitly out of V1 until proven per §3).

**Waiver required for AC1:** inspecting every cited official URL with a
capture date is impossible from this sandbox (no DNS egress, reconfirmed
2026-10-03, curl exit 6), so a coding pass here cannot close it. Closing AC1
needs either a network-egress run that opens each §2.1 URL and records
captures, or an explicit human waiver accepting the §2.1 operator preflight
(P1–P4) as the substitute.

| Client | Custom Streamable HTTP endpoint | Static `Authorization` header | MCP OAuth discovery | Auth-code + PKCE | Dynamic client registration / alternative | Config surface / notes |
|---|---|---|---|---|---|---|
| **Claude Code (CLI)** | Yes — `claude mcp add --transport http <name> <url>` registers remote HTTP/SSE servers. `cited — NOT live-fetched in-session` | Yes — repeatable `--header "Authorization: Bearer <token>"`. `cited — NOT live-fetched in-session` · `operator-must-confirm` (V1 depends on it) | Yes — Claude Code performs the MCP OAuth flow against servers that require it. `cited — NOT live-fetched in-session` | Yes — browser-based authorization with PKCE where the server demands it. `cited — NOT live-fetched in-session` | DCR where the server advertises it; otherwise pre-registered client. `cited — NOT live-fetched in-session` | CLI + `~/.claude.json`. Source: `https://code.claude.com/docs/en/mcp.md` (to verify — preflight P1). NOTE: `https://support.anthropic.com/en/articles/11175166` was cited in a prior round as a "Claude Code MCP guide"; by its URL family it reads as a support article (custom connectors), not the Claude Code docs — it is **not** cited for Claude Code here but for the Claude.ai row below (preflight P4) |
| **Codex CLI** | Yes — `~/.codex/config.toml` `[mcp_servers.<name>]` with `url = "https://…/mcp"` (Streamable HTTP). `cited — NOT live-fetched in-session` | Yes — `http_headers = { Authorization = "Bearer <token>" }`. `cited — NOT live-fetched in-session` · `operator-must-confirm` (V1 depends on it) | Partial — Codex supports OAuth for its own ChatGPT sign-in; third-party MCP OAuth from the CLI is **ambiguous in the public docs** → `operator-must-confirm` | Ambiguous for third-party MCP servers → `operator-must-confirm` | Ambiguous → pre-registered client assumed until proven otherwise | File config (`config.toml`); differences from Claude: headers live in TOML, not CLI flags. Sources: `https://developers.openai.com/codex/mcp/` and `https://developers.openai.com/codex/cli/config/` (to verify — preflight P2) |
| **Grok (xAI API + "Grok Bot" target)** | **Ambiguous — launch blocker.** xAI publishes an MCP guide (`https://docs.x.ai/docs/guides/mcp`, to verify — preflight P3), and the xAI API surface documents remote MCP tools with an authorization parameter — but which product surface ("Grok Bot": grok.com bot builder vs. xAI API agent) accepts a *third-party* Streamable HTTP server, and with what auth, is not settled without reading the docs and running the proof → **operator proof required (§3)** | Unknown → `operator-must-confirm` | Unknown → `operator-must-confirm` | Unknown → `operator-must-confirm` | Unknown → `operator-must-confirm` | Grok support is conditional on §3. Nothing in §4 assumes it. |
| **Claude.ai / Claude Desktop remote connectors (cloud surface)** | Custom connectors exist, but whether they accept an arbitrary third-party Streamable HTTP URL is unverified here → `operator-must-confirm` | To the reviewer's knowledge these connectors are **OAuth/authless only with no static `Authorization` header field** — unverified in-session → `operator-must-confirm`. **If true, bearer-only V1 does NOT serve this surface.** | Expected (OAuth-native surface) → `operator-must-confirm` | Expected → `operator-must-confirm` | Expected DCR or pre-registered partner app → `operator-must-confirm` | Candidate source: `https://support.anthropic.com/en/articles/11175166` (to verify — preflight P4). Out of V1 scope unless a §3-style proof shows a static-header field; otherwise it falls under the §7 OAuth child. |
| **ChatGPT web connectors (independent cloud-agent reference)** | Team/Enterprise connectors accept MCP servers; exact auth fields unverified here → `operator-must-confirm` | Unverified → `operator-must-confirm`. Out of V1 unless proven. | Expected (OAuth-native surface) → `operator-must-confirm` | Expected → `operator-must-confirm` | Vendor partner registration or DCR → `operator-must-confirm` | No URL cited (none was ever consulted); operator supplies the canonical doc URL in the §3 record if this surface becomes required. Listed so "independent cloud agent" coverage is explicit. |

Static-header and OAuth support are recorded in separate columns per the
acceptance criterion. V1 consequence: per-agent static credentials for Claude Code and Codex CLI (pending preflight P1-P2) are
the V1 mechanism; OAuth is supported by Claude Code, ambiguous for Codex
third-party servers, and unknown for Grok and cloud connectors — which is exactly why OAuth stays
out of V1 and is specified only as a conditional child scope (§7), except
that the V1 client scope is now narrowed to static-header-capable clients
(Claude Code and Codex CLI pending preflight P1–P2): cloud-connector
surfaces (Claude.ai/Desktop, ChatGPT web, Grok bot builder) are **out of V1**
until a §3-style proof shows a static-header field, and a required client
without one triggers the §7 OAuth child instead of reopening the bearer-grant decision

### 2.1 Operator preflight (docs verification — NOT-318 preflight, not V1 scope)

Each item: open the URL, confirm the stated contract, record URL + capture
date in the §3 record. No implementation starts or stops on these except as
noted.

- **P1 (V1-gating):** `https://code.claude.com/docs/en/mcp.md` — confirm
  `claude mcp add --transport http` and the repeatable Authorization header
  option for remote servers.
- **P2 (V1-gating):** `https://developers.openai.com/codex/mcp/` and
  `https://developers.openai.com/codex/cli/config/` — confirm
  `[mcp_servers]` URL plus static header configuration.
- **P3 (Grok launch blocker):** `https://docs.x.ai/docs/guides/mcp` —
  record which product surface accepts third-party MCP servers and which
  authorization parameter it sends; then run the §3 proof.
- **P4 (cloud-connector scoping):**
  `https://support.anthropic.com/en/articles/11175166` — record whether
  Claude.ai custom connectors accept a static Authorization header or are
  OAuth/authless-only.

## 3. Grok Bot target — operator connection proof (launch blocker)

No operator-assisted proof was run in this investigation (sandbox: no network
egress, no Grok credentials, no reachable appliance), and the §2.1 preflight
(P1–P4) is likewise unrun. Every `operator-must-confirm` cell therefore
stays open: Grok connectivity is an explicit **launch blocker requiring user
input**, P1–P2 are **NOT-318 preflight** (they gate the "Claude/Codex accept
static bearers" premise but do not change the frozen bearer-grant contract, and P4
scopes cloud connectors out of V1. None of this is a silent assumption.

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

### 3.2 Record (to be filled by the operator; template is part of the contract)

| Field | Value |
|---|---|
| Product surface | _e.g. grok.com → Bot → Integrations → Custom MCP — TBD_ |
| URL form | _TBD_ |
| Auth configuration | _TBD (static Bearer header / OAuth fields)_ |
| Date (UTC) | _TBD_ |
| Observed result | _TBD (tool list / error text / unsupported)_ |
| Preflight P1-P4 | _per item: URL opened, capture date, confirmed sentence or discrepancy_ |

Until this table is filled, "Grok support" means static credentials for preflight-proven CLI clients plus an open Grok proof — never
"Grok works". "Claude support" in V1 means Claude Code CLI (P1), never
Claude.ai connectors (P4) unless a separate proof shows a static-header field.

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
  unassigned session mid-flight.
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

Per-agent bearers satisfy the V1 launch clients (Claude Code and
Codex CLI both accept a static Authorization header, pending preflight
P1-P2 in §2.1). Standards-based MCP OAuth is therefore deferred. It becomes
required **only if** the §3 Grok proof — or a §3-style proof for another
required client such as Claude.ai connectors (P4) — shows a required client
with no static-header field. In that case the bounded child scope is:

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
| §2.1 preflight P1-P2 (Claude/Codex static header) | Operator | XS | Gates the V1 client premise, not NOT-318 start |
| §3 Grok operator proof | Operator | S | Blocks "Grok supported" claim, not NOT-318 start |
| §7 OAuth child (conditional) | Separate ticket | L | Only if §3 proof demands it; bounded by the six bullets above |

NOT-318 comparison (attempt recorded): this session's bound deck exposes no
Linear service (only an unhealthy GitHub MCP service), and task instructions
forbid web-fetching Linear URLs, so the NOT-318 description and relations
could **not** be read here. No repo-local NOT-318 spec exists either (only
this ADR references it). The comparison MUST be completed by the
coordinator/operator before NOT-318 starts — flagged explicitly here, not
silently skipped. **Waiver:** AC7 stays open until the coordinator either
performs that comparison against NOT-318 as written (updating it or
confirming it matches) or records an explicit human waiver. No update is
needed *provided* NOT-318
already assumes (a) opaque per-agent bearer grants, (b) the deck header as
request-only, (c) loopback launcher compatibility, and (d) single-owner
scope, plus the four assumptions NEW or changed since the last round:
(e) explicit hosted-mode flag, never peer-address detection (§4.6);
(f) bearer-before-404 check order on hosted endpoints (§4.3);
(g) approved switch_deck cannot leave allowedDecks, get_decks scoping
unchanged (§4.4/§5); (h) V1 client scope is static-header-capable clients
only (§2–§3). If any listed item differs in NOT-318 as written, NOT-318 must be
edited to match §4–§6 before implementation starts — and any OAuth work must
split into the §7 child scope, not ride inside NOT-318.

## 9. Verification performed here (and what runs later)

- Targeted test: `personal-cloud-auth-contract.examples.test.ts` asserts the
  fixture is self-consistent (uniform §4.2 401 envelope plus the constant
  `WWW-Authenticate: Bearer` challenge, no secret/deck
  detail leakage, deck-selection 403 only post-auth, bearer-before-404
  `authOrder` case from §4.3). Run:
  `npm --workspace @agent-deck/backend run test -- personal-cloud-auth-contract`
- Text integrity: `grep -c REDACTED` returns 0 for this ADR, the test, and
  the fixture — the nine normative sentences a prior scrubber pass had
  replaced with a literal token now use the hyphenated `bearer-grant …`
  form (§4.3 check order, §4.4 allowlist gate, §4.6 hosted-mode trigger).
- Docs link check: every relative link in this ADR and the three updated
  product docs was resolved against the tree (see handoff; CI docs checks
  own the rest).
- Later (not this ticket): real Grok proof (§3), NOT-318 implementation,
  conditional OAuth child.

## Appendix — evidence pointers

- Current trust model: `packages/backend/src/mcp-server.ts`
  (`authenticateLaunchDeck`, `requireFollowUpDeckHeader` keep-transport rule),
  `packages/backend/src/mcp-session-binding.ts`,
  `packages/backend/src/mcp-unassigned.ts` (NOT-50),
  `packages/cli/src/mcp-launcher.ts` (assignment → deck header, no bearer).
- Session contracts: [PRD_TRUSTED_AGENT_SESSIONS.md](../PRD_TRUSTED_AGENT_SESSIONS.md)
  C3/C4/C9, [2026-09-20-session-deck-switching-redesign.md](../superpowers/specs/2026-09-20-session-deck-switching-redesign.md).
- Probe evidence: `curl -sI` against the three official doc URLs returned
  empty under sandbox network restriction on 2026-10-03, re-confirmed
  2026-10-03 (`curl: (6) Could not resolve host`, `curl -sS` exit 6;
  escalated execution forbidden by
  launch policy, so no official section-2 URL was inspected in-session.
  The source-status key and the section-2.1 preflight (P1-P4) below carry
  the operator verification path (a NOT-318 preflight step, not a V1 blocker). The frozen
  mechanism stays per-agent static credentials for static-header-capable
  clients; the Claude/Codex static-header premise is confirmed at preflight,
  not assumed from memory.
- Design-source substitution: the ticket names
  `docs/superpowers/specs/2026-10-02-personal-cloud-agent-deck-design.md`
  (R1, section 2, section 5), but that file does not exist at this head.
  This ADR was reconciled
  against the ticket text instead (design-source file absent, verified by
  directory listing on 2026-10-03); if the spec lands, NOT-318 must reconcile
  it against sections 4-6 here and flag divergences.
