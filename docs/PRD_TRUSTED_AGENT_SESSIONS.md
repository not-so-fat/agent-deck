---
status: shipped
linear: NOT-45
related: NOT-44
playbooks: pb_ai_codegen_prd, pb_product_principle
shipped: 1.7.0
---

# Trusted agent sessions & ephemeral admin mode — AI Codegen PRD

Every MCP session receives the deck previously authorized for its workspace. Normal agents can use that deck and preserve the feedback-to-playbook suggestion loop; temporary admin mode adds narrowly scoped deck administration without becoming persistent authority.

**Shipped in 1.7.0** (NOT-45 + NOT-44 together; see [CHANGELOG](../CHANGELOG.md#170--2026-08-31)).

## 1. Problem and outcome

The current agent path relies too much on caller-supplied role and deck context, and route-by-route opt-in makes omissions dangerous. It also lacks a durable workspace-to-deck grant and a safe way for a user to administer decks conversationally.

NOT-45 adds three distinct concepts:

- a persistent workspace grant that binds one canonical workspace to one deck;
- a runtime MCP session that starts in normal mode and expires after inactivity;
- an ephemeral `agent-admin` elevation for deck administration only.

The existing learning loop is a critical product feature, not admin work: normal agents can read bound playbooks and submit create, update, or retire suggestions with `propose_playbook_patch`; review in the dashboard remains the authority that applies them.

This work is complete when a restarted agent automatically receives the workspace's previously bound deck in normal mode, forged headers cannot expand authority, one approved admin session can create or switch and then edit its now-bound deck, abandoned authority expires, legacy workspaces migrate only after explicit confirmation, and NOT-44 denies all cross-deck service access.

## 2. Normative product contract

### C1. Canonical workspace identity

The trusted CLI derives a canonical path by resolving symlinks, normalizing separators and trailing separators, applying Unicode NFC, and applying documented platform rules including Windows path behavior. It registers an immutable opaque `workspaceKey`; the backend authorizes by that key, not by a path supplied by an MCP caller. Aliases of one workspace resolve consistently, and a grant for workspace A can never target workspace B.

### C2. Persistent workspace grant

Each `workspaceKey` has at most one active grant, bound to exactly one deck and containing no admin authority. A grant can be created or rotated only by:

- an explicit trusted `agent-deck use <deck>` command;
- an authenticated dashboard action; or
- the trusted daemon executing a deck change approved for an elevated session.

The grant has no time expiry in v1; deletion or rotation revokes it. The backend stores only a hash or signed representation, never the plaintext grant.

Raw grant material may exist only in an ignored, user-readable-only private file such as `.agent-deck/use.json` with mode `0600`, or in an OS secret store. Tracked project configuration, including `.mcp.json`, `.cursor/mcp.json`, Claude configuration, test fixtures, logs, and diffs, must never contain it. Project MCP configuration uses a non-secret local launcher or reference; the launcher reads the private grant at runtime.

### C3. Runtime MCP session

An authenticated connection creates this runtime principal:

```json
{
  "sessionId": "ses_...",
  "mcpSessionId": "transport_...",
  "workspaceKey": "wsp_...",
  "workspaceGrantId": "wgr_...",
  "deckId": "deck_...",
  "mode": "normal",
  "lastSeenAt": "...",
  "expiresAt": "...",
  "adminExpiresAt": null
}
```

Every session starts in `normal`. Authenticated MCP activity renews a 24-hour inactivity lease. MCP transport close, explicit runtime-session close, grant revocation, server restart, or 24 hours without activity removes the session. A later session on the same workspace starts in `normal` and inherits the grant's deck.

The backend establishes this principal before tool routing. Caller-supplied role, deck, workspace, or admin headers are ignored for authorization.

Here, “session” means the MCP transport session, not a chat window. If a host reuses one MCP transport across chat restarts, the runtime session continues until transport close, explicit runtime-session close, revocation, restart, or lease expiry. This behavior must be documented and tested per supported host.

### C4. Ephemeral `agent-admin`

Elevation is session-specific:

1. The agent requests elevation and receives a single-use challenge valid for five minutes.
2. The menubar opens the authenticated dashboard approval page.
3. The user approves the exact MCP session.
4. The backend changes only that session to `agent-admin`.

Admin authority has a 30-minute inactivity lease renewed only by authenticated MCP activity. It ends on lease expiry, explicit `exit_admin_mode`, MCP transport or runtime-session close, grant revocation, or server restart. `exit_admin_mode` downgrades the existing session to `normal`; it does not close that session. Admin state is visibly indicated in the agent binding response, dashboard, and menubar. It is never written into the persistent workspace grant.

The single elevation approval covers all C5 actions for that session until elevation ends; create, switch, bind, and edit do not require separate approvals.

### C5. Admin scope

An elevated session may:

- list safe metadata for all decks and cards, including how many workspaces use each deck;
- create a deck and bind its own workspace to it;
- change its own workspace's persistent deck binding; and
- add, remove, or reorder existing cards only in the currently bound deck.

When the bound deck is shared, a composition change intentionally affects every workspace using that deck. The agent must surface the workspace usage count and shared impact before mutation, but no additional approval is required. It may not change another workspace's grant, binding, or runtime session; edit an unbound deck; call services outside the bound deck; read full out-of-deck records; mutate the collection; directly mutate playbooks; change tool settings or OAuth; read secrets; or approve its own elevation.

### C6. Playbook learning remains available to normal agents

Normal and elevated agents may read playbooks on the bound deck and call `propose_playbook_patch` to suggest creating, updating, or retiring playbooks based on user feedback. The dashboard applies reviewed suggestions. Direct playbook registration, update, deletion, or dependency mutation remains dashboard-only.

### C7. Store-independent grant issuance and rotation

Actors are explicit:

- the trusted grant writer is the CLI, authenticated dashboard backend, or daemon executing an approved admin action;
- the registry tracks pending, active, and revoked grants;
- an agent or MCP caller never receives a replacement raw grant or an activation credential.

Rotation uses this protocol:

1. The registry creates pending grant G2 while G1 stays active.
2. Only the trusted grant writer receives G2 and a single-use activation credential; agent-facing responses are redacted.
3. The writer durably installs and read-verifies G2 in the selected private store before activation.
4. The writer activates G2 and the backend atomically makes G2 active and revokes G1. For an elevated-agent rotation, it rebinds the approving session while preserving its current admin lease and revokes every peer session using G1. For a CLI or dashboard rotation with no approving MCP session, it revokes every live session using G1; the next connection starts in `normal` on G2.
5. The writer verifies the active binding and cleans obsolete local material.

Initial issuance uses the same pending-install-activate order without G1: the registry creates a pending grant, the trusted writer durably installs and read-verifies it, and only then activates it. Until activation the workspace remains unbound and returns `GRANT_REQUIRED`. Installation or activation failure revokes the pending grant and rolls the private store back to no grant; successful activation leaves the already-durable grant active. There is no approving or peer runtime session to rebind or revoke.

Every supported private store must provide equivalent staging, rollback, and crash recovery for first issuance and rotation:

- before activation, G1 remains usable;
- after activation, G2 is already durable;
- activation failure retains G1 and revokes G2; and
- crash tests cover both ignored-file and OS-secret-store implementations.

For first issuance, the equivalent invariant is: no grant is usable before activation, the new grant is durable before activation, and any failure restores the no-grant state. CLI- and dashboard-initiated first use must both satisfy this invariant.

File-specific mechanics such as temporary and backup files belong in the technical design, not this product contract.

### C8. Deck changes are persistent

There is no temporary deck switch. An approved admin deck change rotates the persistent workspace grant using C7 and revokes peer sessions with `SESSION_REVOKED`. The approving runtime session remains in `agent-admin` on the new deck until the C4 lease or exit conditions end elevation, so it can finish deck composition work. A future runtime session still starts in `normal`.

## 3. User flows

### A. Restart and automatic binding

The user starts a supported agent in a previously authorized workspace. The launcher reads the private grant, the backend creates a normal runtime session under C3, and the agent receives the bound deck summary. No deck selection or admin approval is required.

### B. Conversational deck administration

The user asks the agent to create or change a deck. The normal call returns `ADMIN_REQUIRED`; the agent requests C4 elevation and the menubar opens approval. After that one approval, the agent may create or switch, bind the workspace, surface any shared-deck impact, and edit the now-bound deck. If the binding changes, C7 and C8 apply; the same session may finish configuring the new deck before elevation ends under C4.

### C. Concurrent agents during a deck change

Two normal sessions share one workspace grant. One is elevated and changes the deck. The approving flow rotates the grant and retains its admin lease; the other session receives `SESSION_REVOKED`. Its next connection uses the new grant and starts normal on the new deck.

### D. Learning from feedback without admin mode

The user corrects normal-agent behavior derived from a playbook. The agent reads the bound playbook and submits a create, update, or retire proposal. No elevation is requested. The dashboard shows the proposal for review and is the only surface that can apply it.

### E. Abandoned sessions

A host is killed without a disconnect. MCP activity stops, admin mode downgrades after 30 minutes, and the runtime session is removed after 24 hours. Later calls receive the appropriate stable session error and must reconnect.

## 4. Authorization matrix

| Capability | Normal agent | Agent-admin | Dashboard |
| --- | --- | --- | --- |
| Read binding, bound deck summaries/services/playbooks | Yes | Yes | Yes |
| Propose playbook create/update/retire | Yes | Yes | Review/apply |
| List safe metadata across decks/cards | No | Yes | Yes |
| Create/bind deck; change own binding; edit currently bound deck membership/order | No | Yes | Yes |
| Direct playbook or collection mutation | No | No | Yes |
| Call a service outside the bound deck | No | No | Yes |
| Change tool settings/OAuth or read secrets | No | No | Yes |
| Approve elevation | No | No | Yes |

Every HTTP and MCP operation declares exactly one centralized policy: `requireAgentResource`, `requireDeckAdmin`, `requireDashboard`, or an explicit `allowPublic`. The guard derives authority from the authenticated runtime or dashboard principal before the handler runs; caller-supplied role, deck, workspace, admin, or dashboard headers are never principals. An undeclared operation is denied before its handler runs. Public operations cannot access principal-scoped resources.

## 5. MCP and error contracts

Required behavior:

- binding and grant inspection returns redacted identity and expiry information;
- deck listing returns only the bound deck to normal sessions and safe metadata to admin sessions;
- binding the current deck is idempotent;
- binding a different deck requires admin, is limited to the session's own workspace, and uses C7;
- create/switch/manage-deck actions require admin;
- manage-deck actions target only the currently bound deck and surface shared-workspace impact without a second approval;
- collection listing and mutation are denied to normal agents; admin receives only safe metadata;
- service listing and invocation remain limited to the bound deck in both modes;
- playbook proposal calls remain available under C6; and
- direct collection, playbook, OAuth, tool-setting, and secret operations remain dashboard-only.

Stable machine-readable errors:

| Code | HTTP | Meaning |
| --- | ---: | --- |
| `GRANT_REQUIRED` | 401 | No valid workspace grant |
| `SESSION_INVALID` | 401 | Runtime session absent or expired |
| `SESSION_REVOKED` | 401 | Grant rotation or explicit revocation ended the session |
| `WORKSPACE_SCOPE_MISMATCH` | 403 | Request targets a different workspace; elevation cannot override it |
| `RESOURCE_OUT_OF_SCOPE` | 403 | Resource is outside the bound deck |
| `ADMIN_REQUIRED` | 403 | Deck-admin elevation is required |
| `DASHBOARD_REQUIRED` | 403 | Operation is never available to an agent |
| `ADMIN_CHALLENGE_EXPIRED` | 410 | Approval challenge expired or was already consumed |

The MCP adapter preserves these codes instead of collapsing them into generic tool failures.

## 6. Dashboard bootstrap

The dashboard admin secret remains outside the workspace in a user-only store. A local launcher exchanges it for a short-lived nonce, then the dashboard establishes an `HttpOnly`, `SameSite` authenticated cookie. Dashboard HTTP handlers use the same mandatory policy registry as MCP operations; dashboard routes resolve the cookie to a dashboard principal, while any intentionally public bootstrap or health route explicitly declares `allowPublic` and cannot access principal-scoped resources. Direct loopback access or a caller-supplied header never confers agent-admin or dashboard authority. The menubar may open the approval URL but cannot approve it.

## 7. Migration and setup

Legacy manifests and MCP configuration are hints, never authority. `agent-deck use --refresh` diagnoses state and prints the explicit `agent-deck use <deck>` command; it does not mint a first grant.

| Legacy state | Required behavior |
| --- | --- |
| Valid manifest and matching host config | Require explicit `use`, then install the private grant, non-secret launcher/reference, stubs, and reload guidance |
| Valid manifest but one or more supported host configs are missing or partial | Treat the manifest only as a hint, require explicit `use`, preserve matching host configuration, install the selected missing pieces, leave unrelated host configuration untouched, and report reload guidance per changed host |
| Manifest missing but one host config names a deck | Show the hint and require explicit `use` |
| Corrupt metadata | Preserve it for diagnosis and require explicit selection |
| Stale deck ID with one exact-name match | Offer that match but require explicit confirmation |
| Ambiguous matches | List safe candidates in the trusted CLI and require a choice |
| Host configs disagree | Refuse automatic conversion and require an explicit choice |
| `agent-deck use <deck> --no-mcp` | Create the grant, manifest, and stubs; warn that no host transport is configured |

All grant installation and later changes use C7. Setup reports each changed configuration file and the host reload or restart required.

The harness starts with binding inspection. On `GRANT_REQUIRED`, it tells the user to run the explicit `use` command and never chooses a deck itself. It shows the bound summary once and requests admin only after a user asks for an admin-scoped action. Setup, harness, migration, and troubleshooting docs must reflect the same model.

## 8. Verification and release

Target verification matrix (design spec; 1.7.0 shipped with partial automated coverage — see as-built table):

Automated and manual coverage should include:

- canonical path aliases, platform behavior, and cross-workspace denial;
- grant entropy, hashing, redaction, tracked-config scanning, file mode, and OS-secret-store behavior;
- supported-host transport reuse, transport/session close, `exit_admin_mode` downgrade without session close, hard kill, 30-minute admin expiry, and 24-hour session cleanup;
- every authorization-matrix cell across HTTP and MCP; route-registry enumeration proving every operation declares exactly one policy, including explicit public exceptions; denial of undeclared operations before handler execution; and forged-header/direct-HTTP attempts against agent-admin and dashboard-only actions;
- C7 fault injection across all actors and stores, including CLI- and dashboard-initiated first issuance plus rotation crashes before and after activation;
- elevated-agent rotation retaining only the approving session, CLI/dashboard rotation revoking all old-grant sessions, and normal peer reconnect on the new deck;
- every migration row, including partially configured supported hosts, and required reload behavior for each changed host; and
- a real flow: `use` → restart agent → automatic normal binding → playbook proposal → one admin approval → create or switch and bind → surface shared impact → edit the bound deck → peer revocation → restart normal on the new deck.

NOT-44 verification remains separate and mandatory: direct HTTP and MCP calls for a service outside the bound deck return `RESOURCE_OUT_OF_SCOPE`, while authenticated dashboard behavior remains unchanged.

**Release (1.7.0):** NOT-45 and NOT-44 shipped together after partial automated coverage (see as-built row), `npm run release:smoke`, and integration tests on main.

### As-built (1.7.0)

| PRD area | Status |
| --- | --- |
| C1–C4 grants, runtime sessions, admin elevation | Shipped — MCP reads live mode from backend; `/admin/approve` dashboard page |
| C5 admin scope (list decks + workspace counts) | Shipped for HTTP + MCP |
| C6 playbook proposals | Shipped (agent `propose_playbook_patch`; direct mutation dashboard-only) |
| C7 pending → install → activate | Shipped for CLI `use` |
| C8 persistent deck change + peer revocation | Shipped via `bind-workspace` grant rotation |
| Central policy registry + route enumeration | Shipped — `HTTP_ROUTE_POLICIES` + `onRequest` hook; enumeration test on boot |
| §8 verification matrix (partial automated) | Partial — `auth-matrix.test.ts`, route-policy enumeration, containment tests, and related unit tests cover forged headers, elevation e2e, C8 peer revoke, and NOT-44 scope; C7 fault injection across all stores, full host-transport lifecycle, and canonical-path alias rows remain manual / follow-up |
| Menubar deep link to approval | Shipped — `GET /api/trusted-session/admin/challenges` + menubar `href=` rows |

## 9. Threats and non-goals

Design threats this feature mitigates (full automated coverage per §8 matrix not yet complete — see as-built gaps):
- forged authorization headers, copied grants used from another workspace, raw grants committed to source control, reused or self-approved admin challenges, leaked replacement grants, server restart, crashed hosts, concurrent deck changes, and newly added routes that omit policy.

Non-goals for v1:

- temporary deck switching;
- persistent admin grants;
- multiple simultaneous deck grants per workspace;
- agent access to OAuth, secrets, tool settings, collection mutation, or direct playbook mutation; and
- replacing dashboard review of playbook suggestions.

## 10. Implementation map (as-built)

Primary touchpoints in the 1.7.0 codebase:

- SQLite schema + migrations — trusted session / grant tables
- `packages/backend/src/trusted-session/` — grants, runtime sessions, elevation
- `packages/backend/src/lib/http-route-policies.ts` — centralized policy registry + Fastify hook
- MCP transport session establishment — grant Bearer auth, session header
- CLI `use` / `use --refresh` — grant writer + launcher config (`packages/cli/`)
- Dashboard `/admin/approve` + menubar challenge links
- Harness + docs — `CLAUDE.md`, setup/migration copy, `CHANGELOG.md`

For migration/rollback notes and route-to-matrix mapping, see PR #30 and release smoke (`scripts/release-smoke.sh`).
