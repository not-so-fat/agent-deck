---
status: accepted
linear: NOT-85
implements_via: NOT-86, NOT-87
related: NOT-84, NOT-77, NOT-79, docs/PRD_TRUSTED_AGENT_SESSIONS.md
---

# Trusted unattended execution contract (Agent Dealer ↔ Agent Deck)

**Accepted architecture (NOT-85).** This section is authoritative over older drafts and over leftover comments in foundation PRs. Interactive path-bound workspace grants ([PRD_TRUSTED_AGENT_SESSIONS](../../PRD_TRUSTED_AGENT_SESSIONS.md)) remain unchanged; this contract adds a **separate** unattended principal.

## 1. Concrete use case

An operator configures an Agent Dealer profile once. A later unattended run starts in an isolated generated worktree, reads its selected Agent Deck playbook, invokes only authorized tools, records evidence, and finishes or parks without holding a worker open for human approval.

## 2. Ownership table

| Owner | Owns | Does not own |
| --- | --- | --- |
| **Agent Deck** | Deck contents, credentials, authorization policy, coordinator enrollment, execution-authority issuance/revocation, audit of allowed Deck operations | Run lifecycle, human-action queue, worker capacity |
| **Agent Dealer** | Profile configuration, run/attempt lifecycle, worktree creation, worker capacity, human-action queue, retry/resume, audit of workflow progress | Whether a call is authorized; authority secrets |
| **Worker** | Private reasoning and execution within delegated capability | Minting/revoking authority; control-plane approval |
| **Downstream services** | Tool effects and provider-specific failures | Dealer/Deck lifecycle |
| **Operator** | Setup-time enrollment, deck/profile selection, approval of control-plane changes | In-flight MCP call completion |

Neither product may infer authoritative authorization from UI state, legacy client headers (`x-agent-deck-client`), worktree path copying, or the other product’s workflow status.

## 3. Authoritative records

| Record | Authoritative system | Purpose |
| --- | --- | --- |
| Coordinator enrollment | Deck | Local Dealer coordinator is allowed to discover metadata and mint authority |
| Execution authority | Deck | What a specific run attempt may access (deck + tool snapshot + TTL) |
| Workspace grant + runtime MCP session | Deck | Interactive path only (unchanged) |
| Run / attempt | Dealer | Contract-facing states: `queued`, `acquiring_authority`, `active`, `parked_interaction`, `completed`, `cancelled`, `failed` |
| Human action | Dealer | Open / approve / reject / expire (correlated to `parked_interaction`; not itself a run state) |
| Correlation / audit events | Both (join keys) | Connect Dealer run/attempt to Deck issue/use/expiry/revoke without sharing secrets or private reasoning |

Audit events may connect the records; neither replaces the other.

## 4. Compatibility with interactive grants

- Path-bound workspace grants, runtime sessions, and `agent-admin` elevation stay exactly as in PRD_TRUSTED_AGENT_SESSIONS.
- Unattended execution **must not** copy `.agent-deck/use.json`, grant secrets, dashboard cookies, trusted-writer material, or agent-admin capability into generated worktrees, prompts, artifacts, or Dealer storage.
- `GRANT_REQUIRED` remains the interactive-path signal (fix: `agent-deck use <deck>`). Unattended callers that lack execution authority receive authority-typed errors (`AUTHORITY_EXPIRED` / `AUTHORITY_REVOKED` / enrollment errors), not a prompt to install a workspace grant into a worktree.

## 5. Data model (minimum)

### 5.1 Coordinator enrollment

```ts
{
  enrollmentId: string;       // enr_...
  coordinatorId: string;      // stable local Dealer instance id
  status: "active" | "revoked";
  allowedDeckIds: string[];   // decks this coordinator may mint for
  createdAt: string;          // ISO-8601
  revokedAt: string | null;
}
```

Enrollment is created by an explicit operator action (CLI/dashboard). Revocation is immediate: subsequent mints under that enrollment fail with `ENROLLMENT_REVOKED`, and every still-`live` authority minted under it is cascade-revoked so further authorized calls fail with `AUTHORITY_REVOKED`.

### 5.2 Execution authority

```ts
{
  authorityId: string;        // authz_...
  enrollmentId: string;
  runId: string;              // Dealer-owned
  attemptId: string;          // Dealer-owned
  deckId: string;
  audience: "dealer-worker";  // extensible string enum; v1 = worker only
  allowedServices: string[];  // Deck-authored snapshot at mint
  allowedTools: Array<{ serviceId: string; toolName: string }>; // Deck-authored snapshot at mint
  issuedAt: string;
  expiresAt: string;
  status: "live" | "expired" | "revoked";
  idempotencyKey: string;     // Dealer-supplied; scoped to enrollment
}
```

**Tool snapshot authorship:** At mint, **Deck** materializes the authoritative `allowedServices` / `allowedTools` from the selected deck’s current policy (bound services and enabled tools). The coordinator may pass an optional `toolScopeHint` that **only narrows** (intersection); Deck never expands beyond policy. The in-memory skeleton accepts a pre-materialized list as a stand-in for that Deck-authored snapshot.

**Secret handling:** mint returns a one-time `authoritySecret` (or equivalent launcher handle). Deck stores only a hash/representation. Dealer stores `authorityId`, status, and correlation metadata — never the secret. Delivery to the worker uses an OS secret boundary / launcher (chosen in NOT-86); not repo files, not prompts.

**Profile binding:** allowed deck(s) are constrained at enrollment; mint further pins one `deckId` plus that immutable Deck-authored service/tool snapshot for the attempt.

### 5.3 Correlation / audit (shared fields, no secrets)

```ts
{
  eventId: string;
  at: string;
  kind:
    | "enrollment_created"
    | "enrollment_revoked"
    | "authority_minted"
    | "authority_inspected"
    | "authority_revoked"
    | "authority_expired"
    | "call_allowed"
    | "call_denied";
  correlation: {
    enrollmentId?: string;
    authorityId?: string;
    runId?: string;
    attemptId?: string;
    deckId?: string;
    requestId?: string; // set on INTERACTION_REQUIRED; Dealer human-action dedupe key
  };
  detail?: Record<string, unknown>; // no credentials, no grant secrets, no private reasoning
}
```

## 6. State transitions

### 6.1 Deck — enrollment

`absent → active → revoked` (terminal). No reactivation; re-enroll creates a new `enrollmentId`.

### 6.2 Deck — execution authority

```
mint (idempotent) → live
live → expired | revoked
expired | revoked → terminal (inspect ok; authorize fail)
```

Duplicate mint with the same `(enrollmentId, idempotencyKey)` returns the same live authority (or a deterministic terminal response if already expired/revoked). A new attempt always uses a new idempotency key and receives a new authority.

### 6.3 Dealer — run/attempt (contract-facing)

```
queued → acquiring_authority → active
acquiring_authority | active → parked_interaction
parked_interaction → queued (new attempt after approval/config)
active → completed
any non-terminal → cancelled | failed
```

Terminal attempt outcomes: `completed` (success), `cancelled`, `failed`.

`INTERACTION_REQUIRED` maps to `parked_interaction`: release worker capacity, create/dedupe one human action, never leave an MCP call open.

Approval/rejection/expiry of the human action never completes an unknown in-flight Deck call. Resume = new `attemptId` + new mint (back to `queued`). Successful finish of an active attempt → `completed` and authority ends (revoke or let TTL expire; no further calls).

## 7. Typed outcomes / error schema

| Code | Who emits | Meaning | Caller next action |
| --- | --- | --- | --- |
| `GRANT_REQUIRED` | Deck (interactive) | No valid workspace grant | Operator runs `agent-deck use` — not for unattended worktrees |
| `AUTHORITY_EXPIRED` | Deck | TTL elapsed | Dealer: new attempt + mint, or fail |
| `AUTHORITY_REVOKED` | Deck | Explicit revoke, or cascade from enrollment revoke | Dealer: treat attempt failed; do not retry same authority |
| `AUTHORITY_UNKNOWN` | Deck | Authority id does not exist | Client bug / stale id — do not treat as credential theft |
| `AUTHORITY_SECRET_INVALID` | Deck | Secret hash mismatch | Alert as possible theft; do not retry same secret |
| `AUDIENCE_MISMATCH` | Deck | Caller audience ≠ authority audience | Fail closed; stolen or mis-delivered authority |
| `RESOURCE_OUT_OF_SCOPE` | Deck | Off-deck / disabled tool / deleted deck | Use `reason` to choose fail vs park for reconfiguration |
| `INTERACTION_REQUIRED` | Deck | Control-plane decision needed | Dealer: enter `parked_interaction` immediately; use `correlation.requestId` for human-action dedupe |
| `ENROLLMENT_REVOKED` | Deck | Coordinator enrollment not active | Operator re-enrolls |
| `COORDINATOR_NOT_ENROLLED` | Deck | Unknown coordinator | Operator enrolls |
| `IDEMPOTENCY_KEY_CONFLICT` | Deck | Same mint key with different params | Fix coordinator; do not reuse key across attempts |
| `INVALID_MINT_REQUEST` | Deck | e.g. non-positive `ttlMs` | Fix mint inputs |
| Success / retryable infra | Downstream or transport | Normal or transient failure | Dealer retry policy; do not auto-replay ambiguous tool effects |

`RESOURCE_OUT_OF_SCOPE` carries optional `reason`: `deck_not_permitted` (mint) or `tool_not_in_snapshot` (call).

Machine-readable shape (MCP/HTTP):

```ts
{
  ok: false;
  error_code: string;
  message: string;
  reason?: string;
  correlation?: { runId?: string; attemptId?: string; authorityId?: string; requestId?: string };
}
```

Idempotent remint of a live authority returns the same authority with `secretIssued: false` and `authoritySecret: null` — it never re-issues the secret. Callers that lost the first secret must wait for TTL/revoke and mint a new attempt.

Authorized calls must assert `audience`; mismatch → `AUDIENCE_MISMATCH`.
## 8. Idempotency rules

| Operation | Key | Behavior |
| --- | --- | --- |
| Mint | `(enrollmentId, idempotencyKey)` | Same live authority (`secretIssued: false`) or deterministic terminal; different params → `IDEMPOTENCY_KEY_CONFLICT` |
| Revoke authority | `authorityId` | Idempotent: already-revoked → success no-op |
| Revoke enrollment | `enrollmentId` | Idempotent |
| `INTERACTION_REQUIRED` → human action | Deck `requestId` / correlation | Dealer creates at most one open human action per id |
| Downstream tool call | Tool-specific | Replay only if the tool contract proves idempotency; otherwise `parked_interaction` or `failed` |

Duplicate tool effects and leaked authority are prevented by: immutable snapshot, TTL, hash-only storage, revoke-before-remint on cancel/retry, and never writing secrets into Dealer DB/worktrees.

Permanently occupied workers are prevented by: typed `INTERACTION_REQUIRED` returns immediately; Dealer must release capacity on `parked_interaction` / `completed` / `failed` / `cancelled`; Deck never holds a request open awaiting human approval.

## 9. Failure and recovery matrix

| Failure | Owner | Next legal action |
| --- | --- | --- |
| Coordinator restarts before mint | Dealer | Re-read durable queue; mint when ready |
| Coordinator restarts after mint | Dealer + Deck | Dealer reconciles from durable attempt state; Deck `inspect` by `authorityId` (secret remains in OS/launcher, not Dealer DB) |
| Worker dies mid-call | Dealer | Mark attempt failed/retryable; authority ends via TTL or explicit revoke before remint |
| Mint retried (same key) | Deck | Return same authority / terminal |
| Tool call retried | Dealer | Only if tool idempotent; else new attempt policy |
| Worktree path changes | Deck | Path is not an authority input; audience + authority secret gate access. Workspace grants must not be copied into the worktree |
| Selected deck changes/deleted | Deck | Fail closed: `RESOURCE_OUT_OF_SCOPE` / revoke live authorities for that deck |
| Authority expires | Deck | `AUTHORITY_EXPIRED` |
| Authority revoked | Deck | `AUTHORITY_REVOKED` |
| Ambiguous downstream result | Downstream + Dealer | No automatic replay; record evidence; operator/policy decides |
| Approval rejected/expires | Dealer | Attempt stays `parked_interaction` or becomes `failed`; no mint |
| Approval after cancel | Dealer | Record; do not restart run |
| Deck temporarily unavailable | Dealer | Bounded retry/backoff then `parked_interaction` or `failed`; never occupy worker forever |
| Dealer temporarily unavailable | Operator / Deck | Live authorities expire by TTL; enrollment remains until revoked |

## 10. Threat model (v1)

| Threat | Mitigation |
| --- | --- |
| Spoofed `x-agent-deck-client: dealer` | Unattended path ignores legacy client headers; requires enrollment + execution authority |
| Worktree copies `.agent-deck/use.json` | Contract forbids inheritance; launcher injects short-lived secret only |
| Authority secret in Dealer DB / logs / prompts | Store id/status only; hash at rest on Deck; redact audits |
| Stolen live authority | Short TTL; audience binding enforced on every call; revoke; least-privilege tool snapshot |
| Cross-deck tool use | Snapshot enforced every call → `RESOURCE_OUT_OF_SCOPE` |
| Agent-admin via unattended path | Authority never includes admin/dashboard/trusted-writer/direct playbook mutation |
| Sync approval inside MCP | Forbidden; `INTERACTION_REQUIRED` only |
| Confused deputy after park | New attempt + new authority; never resume unknown in-flight call |

## 11. API / MCP skeleton

Stable names for NOT-86/87. Exact transport (HTTP vs MCP tools) may vary; shapes must not.

### Enrollment (operator / trusted writer)

- `POST /api/execution-authority/enrollments` — create enrollment for `coordinatorId` + `allowedDeckIds`
- `POST /api/execution-authority/enrollments/:id/revoke`
- `GET /api/execution-authority/enrollments/:id`

### Metadata discovery (enrolled coordinator)

- `GET /api/execution-authority/decks` — safe deck metadata for `allowedDeckIds` only (no credentials, no unrestricted mutation)

### Authority (coordinator)

- `POST /api/execution-authority/authorities` — mint (`runId`, `attemptId`, `deckId`, `audience`, `idempotencyKey`, optional `toolScopeHint` narrowing only); response includes Deck-authored `allowedServices` / `allowedTools`
- `GET /api/execution-authority/authorities/:id` — inspect (no secret)
- `POST /api/execution-authority/authorities/:id/revoke`

### Authorized use (worker)

- MCP initialize + tools authenticated with execution authority (NOT-86)
- Every call checks live status, TTL, audience, deck, and tool snapshot

### Audit

- `GET /api/execution-authority/audit?runId=&attemptId=&authorityId=&enrollmentId=&requestId=` — correlation query without secrets

## 12. Second-workflow requirement

The same enrollment + mint + typed-outcome + park model must support a materially different Dealer workflow (e.g. Message send vs Dev-review) without changing the authorization model. Workflow-specific state stays on the Dealer side; Deck only sees run/attempt ids, deck snapshot, and tool allowlist.

## 13. Inspectable skeleton (this ticket)

In-repo proof (no production HTTP issuer):

- Types: `packages/backend/src/execution-authority/types.ts`
- In-memory ledger: `packages/backend/src/execution-authority/ledger.ts`
- End-to-end test: `packages/backend/src/execution-authority/ledger.test.ts`

Scenario covered: enroll → mint → one allowed call → deny out-of-scope → expire/revoke → audit correlation.

Production issuer: **NOT-86**. Dealer adoption + park: **NOT-87**.

## 14. Non-goals

OAuth redesign, remote multi-tenant coordinators, a general workflow protocol, sharing private agent reasoning, implementing every downstream provider, or replacing interactive workspace grants.

## 15. One-sentence architecture

Agent Deck owns delegated capability and treats its authorization ledger as authoritative; Agent Dealer owns durable run state and advances attempts through `queued`, `acquiring_authority`, `active`, `parked_interaction`, `completed`, `cancelled`, and `failed`; they integrate through replaceable enrollment, execution-authority, typed-outcome, and audit interfaces.
