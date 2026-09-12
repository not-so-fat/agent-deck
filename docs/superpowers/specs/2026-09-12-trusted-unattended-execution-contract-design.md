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
| Run / attempt / human action | Dealer | Queued, acquiring, active, parked, cancelled, terminal |
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

Enrollment is created by an explicit operator action (CLI/dashboard). Revocation is immediate and fails closed for subsequent mints and live authorities minted under that enrollment (NOT-86 may choose cascade-revoke vs expire-in-place; contract requires no new successful authorized calls after enrollment revoke).

### 5.2 Execution authority

```ts
{
  authorityId: string;        // authz_...
  enrollmentId: string;
  runId: string;              // Dealer-owned
  attemptId: string;          // Dealer-owned
  deckId: string;
  audience: "dealer-worker";  // extensible string enum; v1 = worker only
  allowedServices: string[];  // service ids snapshot at mint
  allowedTools: Array<{ serviceId: string; toolName: string }>;
  issuedAt: string;
  expiresAt: string;
  status: "live" | "expired" | "revoked";
  idempotencyKey: string;     // Dealer-supplied; scoped to enrollment
}
```

**Secret handling:** mint returns a one-time `authoritySecret` (or equivalent launcher handle). Deck stores only a hash/representation. Dealer stores `authorityId`, status, and correlation metadata — never the secret. Delivery to the worker uses an OS secret boundary / launcher (chosen in NOT-86); not repo files, not prompts.

**Profile binding:** allowed deck(s) are constrained at enrollment; mint further pins one `deckId` plus the immutable service/tool snapshot for that attempt.

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
any non-terminal → cancelled | failed
```

`INTERACTION_REQUIRED` maps to `parked_interaction`: release worker capacity, create/dedupe one human action, never leave an MCP call open.

Approval/rejection/expiry of the human action never completes an unknown in-flight Deck call. Resume = new `attemptId` + new mint.

## 7. Typed outcomes / error schema

| Code | Who emits | Meaning | Caller next action |
| --- | --- | --- | --- |
| `GRANT_REQUIRED` | Deck (interactive) | No valid workspace grant | Operator runs `agent-deck use` — not for unattended worktrees |
| `AUTHORITY_EXPIRED` | Deck | TTL elapsed | Dealer: new attempt + mint, or fail |
| `AUTHORITY_REVOKED` | Deck | Explicit revoke / enrollment revoke cascade | Dealer: treat attempt failed; do not retry same authority |
| `RESOURCE_OUT_OF_SCOPE` | Deck | Off-deck, disabled tool, or deleted/switched deck | Dealer: fail or park if operator must reconfigure |
| `INTERACTION_REQUIRED` | Deck | Control-plane decision needed | Dealer: park immediately; correlation id for human action |
| `ENROLLMENT_REVOKED` | Deck | Coordinator enrollment not active | Operator re-enrolls |
| `COORDINATOR_NOT_ENROLLED` | Deck | Unknown coordinator | Operator enrolls |
| Success / retryable infra | Downstream or transport | Normal or transient failure | Dealer retry policy; do not auto-replay ambiguous tool effects |

Machine-readable shape (MCP/HTTP):

```ts
{
  ok: false;
  error_code: string;
  message: string;
  correlation?: { runId?: string; attemptId?: string; authorityId?: string; requestId?: string };
}
```

## 8. Idempotency rules

| Operation | Key | Behavior |
| --- | --- | --- |
| Mint | `(enrollmentId, idempotencyKey)` | Same live authority or deterministic terminal |
| Revoke authority | `authorityId` | Idempotent: already-revoked → success no-op |
| Revoke enrollment | `enrollmentId` | Idempotent |
| `INTERACTION_REQUIRED` → human action | Deck `requestId` / correlation | Dealer creates at most one open human action per id |
| Downstream tool call | Tool-specific | Replay only if the tool contract proves idempotency; otherwise park/fail |

Duplicate tool effects and leaked authority are prevented by: immutable snapshot, TTL, hash-only storage, revoke-before-remint on cancel/retry, and never writing secrets into Dealer DB/worktrees.

Permanently occupied workers are prevented by: typed `INTERACTION_REQUIRED` returns immediately; Dealer must release capacity on park/fail/cancel; Deck never holds a request open awaiting human approval.

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
| Approval rejected/expires | Dealer | Attempt stays parked or fails; no mint |
| Approval after cancel | Dealer | Record; do not restart run |
| Deck temporarily unavailable | Dealer | Bounded retry/backoff then park/fail; never occupy worker forever |
| Dealer temporarily unavailable | Operator / Deck | Live authorities expire by TTL; enrollment remains until revoked |

## 10. Threat model (v1)

| Threat | Mitigation |
| --- | --- |
| Spoofed `x-agent-deck-client: dealer` | Unattended path ignores legacy client headers; requires enrollment + execution authority |
| Worktree copies `.agent-deck/use.json` | Contract forbids inheritance; launcher injects short-lived secret only |
| Authority secret in Dealer DB / logs / prompts | Store id/status only; hash at rest on Deck; redact audits |
| Stolen live authority | Short TTL; audience binding; revoke; least-privilege tool snapshot |
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

- `POST /api/execution-authority/authorities` — mint (`runId`, `attemptId`, `deckId`, `audience`, `idempotencyKey`, optional tool-scope hint)
- `GET /api/execution-authority/authorities/:id` — inspect (no secret)
- `POST /api/execution-authority/authorities/:id/revoke`

### Authorized use (worker)

- MCP initialize + tools authenticated with execution authority (NOT-86)
- Every call checks live status, TTL, deck, and tool snapshot

### Audit

- `GET /api/execution-authority/audit?runId=&attemptId=&authorityId=` — correlation query without secrets

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

Agent Deck owns delegated capability and treats its authorization ledger as authoritative; Agent Dealer owns durable run state and advances attempts through queued, active, parked, resumed, and terminal states; they integrate through replaceable enrollment, execution-authority, typed-outcome, and audit interfaces.
