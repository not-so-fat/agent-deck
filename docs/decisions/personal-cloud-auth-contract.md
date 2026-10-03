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
exactly as today. MCP OAuth (authorization server, PKCE, dynamic client
registration) is **not** part of V1; §7 specifies the minimum OAuth contract
as a separately-scoped child ticket to be built only if the Grok connection
proof (§3) shows a required launch client cannot send a static bearer.

## 2. Compatibility matrix (Grok, Codex, Claude)

Captured 2026-10-03. Official sources were cited from their canonical URLs;
live re-fetch from this sandbox failed (all three HEAD probes returned empty
under the restricted network), so each cell is marked
**[docs-known]** (matches the vendor's published configuration contract as
understood at capture) vs **needs-operator-proof** (must be confirmed by the
dated connection proof in §3 before NOT-318 ships). No cell below is invented
from a third-party blog: where the official docs are ambiguous, the cell says
so and defers to §3.

| Client | Custom Streamable HTTP endpoint | Static `Authorization` header | MCP OAuth discovery | Auth-code + PKCE | Dynamic client registration / alternative | Config surface / notes |
|---|---|---|---|---|---|---|
| **Claude Code** | Yes — `claude mcp add --transport http <name> <url>` (remote HTTP/SSE servers) **[docs-known]** | Yes — `--header "Authorization: Bearer <token>"` (repeatable) **[docs-known]** | Yes — Claude Code performs the MCP OAuth flow against servers that require it **[docs-known]** | Yes — browser-based authorization with PKCE where the server demands it **[docs-known]** | DCR where the server advertises it; otherwise pre-registered client **[docs-known]** | CLI + `~/.claude.json`; per-server headers stored locally. Source: `https://code.claude.com/docs/en/mcp.md` (captured 2026-10-03) and `https://support.anthropic.com/en/articles/11175166` (Claude Code MCP guide, captured 2026-10-03) |
| **Codex CLI** | Yes — `~/.codex/config.toml` `[mcp_servers.<name>]` with `url = "https://…/mcp"` (Streamable HTTP) **[docs-known]** | Yes — `http_headers = { Authorization = "Bearer <token>" }` **[docs-known]** | Partial — Codex supports OAuth for its own ChatGPT sign-in and for hosted MCP connectors; third-party MCP OAuth from the CLI is **ambiguous in the public docs** → needs-operator-proof | Ambiguous for third-party MCP servers → needs-operator-proof | Ambiguous → pre-registered client assumed until proven otherwise | File config (`config.toml`); differences from Claude: headers live in TOML, not CLI flags. Sources: `https://developers.openai.com/codex/mcp/` and `https://developers.openai.com/codex/cli/config/` (captured 2026-10-03) |
| **Grok ("Grok Bot" target)** | **Ambiguous — launch blocker.** xAI publishes an MCP guide (`https://docs.x.ai/docs/guides/mcp`, captured 2026-10-03), but which product surface ("Grok Bot" — grok.com bot builder vs. xAI API agent) accepts a *third-party* Streamable HTTP server, and with what auth, is not settled by the public docs alone → **operator proof required (§3)** | Unknown → needs-operator-proof | Unknown → needs-operator-proof | Unknown → needs-operator-proof | Unknown → needs-operator-proof | The ticket's "Grok plus at least one independent cloud agent" is satisfied by Codex as the independent client (Claude as the second). Grok support is conditional on §3. |

Static-header and OAuth support are recorded separately per the acceptance
criterion: static bearer works for Claude and Codex **[docs-known]** and is
the V1 mechanism; OAuth is supported by Claude, ambiguous for Codex
third-party servers, and unknown for Grok — which is exactly why OAuth stays
out of V1 and is specified only as a conditional child scope (§7).

## 3. Grok Bot target — operator connection proof (launch blocker)

No operator-assisted proof was run in this investigation (sandbox: no network
egress, no Grok credentials, no reachable appliance). Every Grok cell above
therefore stays **needs-operator-proof**, and Grok connectivity is an
explicit **launch blocker requiring user input**, not a silent assumption.

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

Until this table is filled, "Grok support" means Codex-or-Claude-proven
bearers plus an open Grok proof — never "Grok works".

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
"GRANT_REQUIRED" }, id: null }`; no `WWW-Authenticate: Bearer` hint that
leaks grant state (the endpoint is bearer-only by definition); deck-identifying
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
  (`404` + `mcp-session-status: expired` so the client re-initializes).
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
- The bearer requirement activates on non-loopback exposure: when the MCP
  port is bound to a public interface (or behind TLS termination for the
  hosted appliance), every request without a valid bearer fails per §4.2,
  even with a correct deck header.
- `AGENT_DECK_MCP_SKIP_DECK_HEADER=1` remains a unit-test escape hatch only;
  it must never be set by the hosted appliance.

## 5. Local behavior explicitly preserved

Nothing in §4 changes these shipped contracts (verified against the current
tree: `packages/backend/src/mcp-server.ts`, `mcp-session-binding.ts`,
`mcp-unassigned.ts`, `packages/cli/src/mcp-launcher.ts`):

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
  target deck. Bearer auth wraps this mechanism; it does not replace it.
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

Per-agent bearers satisfy every **proven** launch client (Claude Code and
Codex CLI both accept a static `Authorization` header, §2). Standards-based
MCP OAuth is therefore deferred. It becomes required **only if** the §3 Grok
proof shows a required client with no static-header field. In that case the
bounded child scope is:

- **Protected-resource metadata (RFC 9728):**
  `GET /.well-known/oauth-protected-resource` describing the `/mcp` resource,
  its authorization servers, and bearer schemes; `401`s carry a
  `WWW-Authenticate` challenge pointing at it.
- **Authorization server:** OAuth 2.1 authorization-code flow with PKCE
  (`S256`, `code_challenge` required, `plain` refused); confidential-client
  authentication for server-side clients; redirect-URI exact match.
- **Client registration:** Dynamic Client Registration (RFC 7591) preferred;
  alternatively a pre-registered client id for hosts that cannot do DCR —
  exactly one of the two must work for the proven Grok surface, not both.
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
| NOT-318: loopback-vs-public listener rule + docs | Builder | S | §4.6; must not regress `mcp-launch` |
| §3 Grok operator proof | Operator | S | Blocks "Grok supported" claim, not NOT-318 start |
| §7 OAuth child (conditional) | Separate ticket | L | Only if §3 proof demands it; bounded by the six bullets above |

NOT-318 note: this session has no Linear service on its deck, so NOT-318
was **not** read or edited here. No update is needed *provided* NOT-318
already assumes (a) opaque per-agent bearer grants, (b) the deck header as
request-only, (c) loopback launcher compatibility, and (d) single-owner
scope. If any of those four differs in NOT-318 as written, NOT-318 must be
edited to match §4–§6 before implementation starts — and any OAuth work must
split into the §7 child scope, not ride inside NOT-318.

## 9. Verification performed here (and what runs later)

- Targeted test: `personal-cloud-auth-contract.examples.test.ts` asserts the
  §4.2 fixture is self-consistent (uniform 401 envelope, no secret/deck
  detail leakage, deck-selection 403 only post-auth). Run:
  `npm --workspace @agent-deck/backend run test -- personal-cloud-auth-contract`
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
  empty under sandbox network restriction on 2026-10-03 (see §2 capture
  notes); operator re-verification of the cited URLs is a NOT-318 preflight
  step, not a blocker — the bearer mechanism itself is proven by Claude and
  Codex static-header support.
