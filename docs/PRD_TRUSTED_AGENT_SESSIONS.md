---
status: shipped
linear: NOT-45
related: NOT-44, NOT-105, NOT-108
playbooks: pb_ai_codegen_prd, pb_product_principle
shipped: 1.7.0
---

# Trusted agent sessions & ephemeral admin mode — AI Codegen PRD

> **Switching contract:** deck-switching behavior in this PRD (admin-elevation / C4 switch rule) is **superseded by** [Session/default deck-switching redesign](./superpowers/specs/2026-09-20-session-deck-switching-redesign.md) (NOT-204).

Every MCP session receives a bound deck selected at connect via `x-agent-deck-deck-id` (launch session). For IDE folders, that deck comes from the folder assignment file (`<folder>/.agent-deck/use.json`); for unattended workers it comes from the launch config. Normal agents can use that deck and preserve the feedback-to-playbook suggestion loop; temporary admin mode adds narrowly scoped deck administration without becoming persistent authority.

**Related (C9 / NOT-105):** Unattended Agent Dealer workers use a **launch-selected deck** (`x-agent-deck-deck-id`) — not folder assignments copied into generated worktrees, and not coordinator enrollment / execution authority (removed in NOT-107). See C9 below and [trusted unattended execution contract](./superpowers/specs/2026-09-12-trusted-unattended-execution-contract-design.md) (superseded). The interactive IDE path is the same launch session model; the folder’s assignment file is how the launcher chooses the deck header.

## 1. Problem and outcome

The agent path must not rely on caller-supplied role or deck context, and route-by-route opt-in makes omissions dangerous. It needs a durable folder-to-deck assignment and a safe way for a user to administer decks conversationally.

Three concepts:

- a folder assignment file that binds one project folder to one deck (no secret; backend stores no workspace→deck mapping);
- a runtime MCP session that starts in normal mode and expires after inactivity;
- an ephemeral `agent-admin` elevation for deck administration only.

The existing learning loop is a critical product feature, not admin work: normal agents can read bound playbooks and submit create, update, or retire suggestions with `propose_playbook_patch`; review in the dashboard remains the authority that applies them.

This work is complete when a restarted agent in a folder automatically receives that folder’s assigned deck in normal mode, forged headers cannot expand authority, one approved admin session can create or switch and then edit its now-bound deck (when an assignment file exists), abandoned authority expires, legacy workspaces migrate only after explicit confirmation, and NOT-44 denies all cross-deck service access.

## 2. Normative product contract

### C1. Folder identity for assignment

The trusted CLI resolves the folder path (symlinks, separators, Unicode NFC, documented platform rules including Windows). That resolved folder is where `<folder>/.agent-deck/use.json` lives. The backend does **not** store a workspace→deck mapping or authorize by an opaque workspace key supplied by an MCP caller. Deck authority for a connection is the launch-selected deck (C9), not a path claim from the agent.

### C2. Folder assignment file

Each project folder may have at most one assignment file:

`<folder>/.agent-deck/use.json` **version 3:**

```json
{
  "version": 3,
  "deckId": "…",
  "deckName": "…",
  "mcpUrl": "…" 
}
```

`mcpUrl` is optional. **No secret.** This file **is** the folder’s assignment; the backend stores no workspace→deck mapping.

The assignment is created or rewritten only by:

- an explicit trusted `agent-deck use <deck>` command;
- an authenticated dashboard action; or
- an elevated MCP session rewriting the file after an approved deck switch (C4).

Tracked project configuration (`.mcp.json`, `.cursor/mcp.json`, Claude configuration, test fixtures, logs, diffs) must never carry secrets. Project MCP configuration uses a non-secret local launcher or reference; the launcher reads the assignment at runtime and connects with launch headers (C9).

Legacy v2-shaped `use.json` (and macOS Keychain entries from 1.8.1 and earlier) may be read once and migrated to v3; they are not issued or accepted as credentials after 1.8.2.

### C3. Runtime MCP session

An authenticated connection creates this runtime principal:

```json
{
  "sessionId": "ses_...",
  "mcpSessionId": "transport_...",
  "deckId": "deck_...",
  "mode": "normal",
  "lastSeenAt": "...",
  "expiresAt": "...",
  "adminExpiresAt": null
}
```

Every MCP session is a launch session: `deckId` is fixed at connect from `x-agent-deck-deck-id`.

Every session starts in `normal`. Authenticated MCP activity renews a 24-hour inactivity lease. MCP transport close, explicit runtime-session close, session revocation, server restart, or 24 hours without activity removes the session. A later connection for the same folder reads the current assignment file (if any) and starts in `normal` on that deck.

The backend establishes this principal before tool routing. After the principal exists, caller-supplied role, workspace, admin, or dashboard headers are never principals and cannot expand authority. Establishing a launch principal (C9) uses `x-agent-deck-deck-id` only when no dashboard bearer is present; a bearer that authenticates is the admin secret (dashboard principal).

Here, “session” means the MCP transport session, not a chat window. If a host reuses one MCP transport across chat restarts, the runtime session continues until transport close, explicit runtime-session close, revocation, restart, or lease expiry. This behavior must be documented and tested per supported host.

**As-built (NOT-84 / NOT-105 / NOT-108):** One Agent Deck MCP process may host many transport sessions. Request scope is immutable per transport: each `McpServer` closes over its MCP transport session id (`mcpSessionId`); backend calls look up that transport’s binding and send the **runtime** session id in `x-agent-deck-session-id` (C3 `sessionId`, including on `fetchDeck` and live-display touch/unregister). There is no process-global `activeSessionId`. Same-deck `bind_workspace` is idempotent in normal mode. A different-deck bind is allowed only under the C4 switch rule (elevated + assignment file); otherwise `DECK_FIXED` or `ADMIN_REQUIRED`. Sessions **with** an assignment file run stub sync on same-deck bind; sessions **without** one (e.g. Dealer worktrees) skip stub sync. Live-display unregister on transport close uses a short abort timeout so local session maps always clear even if the backend hangs.

### C4. Ephemeral `agent-admin`

Elevation is session-specific:

1. The agent requests elevation and receives a single-use challenge valid for five minutes.
2. The menubar opens the authenticated dashboard approval page.
3. The user approves the exact MCP session.
4. The backend changes only that session to `agent-admin`.

Admin authority has a 30-minute inactivity lease renewed only by authenticated MCP activity. It ends on lease expiry, explicit `exit_admin_mode`, MCP transport or runtime-session close, session revocation, or server restart. `exit_admin_mode` downgrades the existing session to `normal`; it does not close that session. Admin state is visibly indicated in the agent binding response, dashboard, and menubar. It is never written into the folder assignment file.

The single elevation approval covers all C5 actions for that session until elevation ends; create, switch, bind, and edit do not require separate approvals.

> **Switching contract:** agent-initiated switching via admin elevation below is **superseded by** [Session/default deck-switching redesign](./superpowers/specs/2026-09-20-session-deck-switching-redesign.md) (NOT-204). Agents may only request a switch via `switch_deck`; a human approves it as This session only or This workspace by default.

**Switch rule (NOT-108, retired by NOT-214):** An agent may change the folder’s deck (`bind_workspace` / `switch_bound_deck` to another deck) only when **both** hold:

1. The session is elevated (`agent-admin`); and
2. The session’s workspace folder has a `.agent-deck/use.json`.

Otherwise the call returns `DECK_FIXED` (no assignment file — e.g. a Dealer worktree) or `ADMIN_REQUIRED` (file present, not elevated). On success the MCP server rewrites `use.json`, syncs stubs, and the backend moves **that** session to the new deck. **Other open sessions in the same folder switch on their next reconnect** (they are not force-revoked solely because the assignment changed).

### C5. Admin scope

An elevated session may:

- list safe metadata for all decks and cards, including how many workspaces use each deck;
- create a deck and bind its own workspace to it;
- change its own folder’s assignment (when an assignment file exists — C4 switch rule); and
- add, remove, or reorder existing cards only in the currently bound deck.

When the bound deck is shared, a composition change intentionally affects every workspace using that deck. The agent must surface the workspace usage count and shared impact before mutation, but no additional approval is required. It may not change another folder’s assignment, binding, or runtime session; edit an unbound deck; call services outside the bound deck; read full out-of-deck records; mutate the collection; directly mutate playbooks; change tool settings or OAuth; read secrets; or approve its own elevation.

### C6. Playbook learning remains available to normal agents

Normal and elevated agents may read playbooks on the bound deck and call `propose_playbook_patch` to suggest creating, updating, or retiring playbooks based on user feedback. The dashboard applies reviewed suggestions. Direct playbook registration, update, deletion, or dependency mutation remains dashboard-only.

### C7. Assignment write

Changing a folder’s deck is an **assignment rewrite**:

- Trusted writers are the CLI (`agent-deck use <deck>`), the authenticated dashboard, or an elevated MCP session under the C4 switch rule.
- The writer updates `<folder>/.agent-deck/use.json` (v3). No secret is minted; the backend stores no workspace→deck ledger.
- An agent or MCP caller never receives a replacement credential.
- Peer sessions are **not** revoked solely because the assignment file changed; they pick up the new deck on their next reconnect (C4).

### C8. Deck changes are persistent

There is no temporary deck switch. An approved admin deck change rewrites the folder assignment (C7). The approving runtime session remains in `agent-admin` on the new deck until the C4 lease or exit conditions end elevation, so it can finish deck composition work. A future runtime session still starts in `normal` on whatever the assignment file currently names. `SESSION_REVOKED` means the runtime session was explicitly revoked or ended by session lifecycle — not an assignment rewrite.

### C9. Launch-selected deck (NOT-105 / NOT-108)

Whoever launches an MCP connection sets its deck via `x-agent-deck-deck-id`. Trust that launch config for the *deck*; never trust the caller for *admin* (elevation + dashboard approval stay as in C4).

**Credential precedence** on every MCP request: deck header → otherwise `GRANT_REQUIRED` (401).

IDE `agent-deck mcp-launch` reads the folder assignment and connects with `x-agent-deck-deck-id` (+ workspace header). Unattended workers pass the deck header from their launch config without an assignment file.

Deck scoping, `propose_playbook_patch`, and elevation work unchanged. `bind_workspace` with the same deck succeeds; a different deck follows the C4 switch rule (`DECK_FIXED` / `ADMIN_REQUIRED` / rewrite assignment when elevated).

## 3. User flows

### A. Restart and automatic binding

The user starts a supported agent in a folder that already has `.agent-deck/use.json`. The launcher reads the assignment, connects with the deck header under C9, the backend creates a normal runtime session under C3, and the agent receives the bound deck summary. No deck selection or admin approval is required.

### B. Conversational deck administration

The user asks the agent to create or change a deck. The normal call returns `ADMIN_REQUIRED`; the agent requests C4 elevation and the menubar opens approval. After that one approval, the agent may create or switch (when an assignment file exists), bind the workspace, surface any shared-deck impact, and edit the now-bound deck. If the assignment changes, C7 and C8 apply; the same session may finish configuring the new deck before elevation ends under C4.

### C. Concurrent agents during a deck change

Two normal sessions share one folder assignment. One is elevated and changes the deck. The approving session rewrites `use.json` and stays on the new deck with its admin lease; peer sessions keep their current deck until reconnect, then start normal on the updated assignment.

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
| Create/bind deck; change own assignment (when file exists); edit currently bound deck membership/order | No | Yes | Yes |
| Direct playbook or collection mutation | No | No | Yes |
| Call a service outside the bound deck | No | No | Yes |
| Change tool settings/OAuth or read secrets | No | No | Yes |
| Approve elevation | No | No | Yes |

Every HTTP and MCP operation declares exactly one centralized policy: `requireAgentResource`, `requireDeckAdmin`, `requireDashboard`, or an explicit `allowPublic`. The guard derives authority from the authenticated runtime or dashboard principal before the handler runs; caller-supplied role, workspace, admin, or dashboard headers are never principals. Establishing a launch principal may use `x-agent-deck-deck-id` per C9; that header never elevates admin. An undeclared operation is denied before its handler runs. Public operations cannot access principal-scoped resources.

`requireDeckAdmin` means dashboard principal **or** elevated `agent-admin` (NOT-153): the dashboard Create Deck path must not be rejected as `GRANT_REQUIRED`. Normal agents still receive `ADMIN_REQUIRED`.

## 5. MCP and error contracts

Required behavior:

- binding inspection returns redacted identity and expiry information;
- deck listing returns only the bound deck to normal sessions and safe metadata to admin sessions;
- binding the current deck is idempotent;
- binding a different deck follows the C4 switch rule (elevated + assignment file → rewrite; else `DECK_FIXED` or `ADMIN_REQUIRED`);
- create/switch/manage-deck actions require admin;
- manage-deck actions target only the currently bound deck and surface shared-workspace impact without a second approval;
- collection listing and mutation are denied to normal agents; admin receives only safe metadata;
- service listing and invocation remain limited to the bound deck in both modes;
- playbook proposal calls remain available under C6; and
- direct collection, playbook, OAuth, tool-setting, and secret operations remain dashboard-only.

Stable machine-readable errors:

| Code | HTTP | Meaning |
| --- | ---: | --- |
| `GRANT_REQUIRED` | 401 | No deck selected for this connection (MCP / API agent path — fix: `agent-deck use <deck>` so the launcher can send `x-agent-deck-deck-id`). Distinct from the dashboard SPA cookie miss, which renders **Dashboard Access Expired** with `agent-deck open` recovery. Code name kept for compatibility. |
| `SESSION_INVALID` | 401 | Runtime session absent or expired |
| `SESSION_REVOKED` | 401 | Runtime session was explicitly revoked or ended by session lifecycle (not assignment rewrite) |
| `RESOURCE_OUT_OF_SCOPE` | 403 | Resource is outside the bound deck |
| `ADMIN_REQUIRED` | 403 | Deck-admin elevation is required |
| `DASHBOARD_REQUIRED` | 403 | Operation is never available to an agent |
| `DECK_FIXED` | 403 | Deck cannot be changed (no assignment file, or switch not allowed for this session) |
| `ADMIN_CHALLENGE_EXPIRED` | 410 | Elevation challenge expired or was already consumed |

The MCP adapter preserves these codes instead of collapsing them into generic tool failures.

## 6. Dashboard bootstrap

The dashboard admin secret remains outside the workspace in a user-only store. A local launcher exchanges it for a short-lived nonce, then the dashboard establishes an `HttpOnly`, `SameSite` authenticated cookie. Dashboard HTTP handlers use the same mandatory policy registry as MCP operations; dashboard routes resolve the cookie to a dashboard principal, while any intentionally public bootstrap or health route explicitly declares `allowPublic` and cannot access principal-scoped resources. Direct loopback access or a caller-supplied header never confers agent-admin or dashboard authority. The menubar may open the approval URL but cannot approve it.

**As-built (NOT-67):** `agent-deck start` / `setup --start` open a bootstrapped URL by default; `agent-deck open` and menubar “Open dashboard” mint on click. Disposable bootstrap URLs are never printed as reusable links. Dashboard sessions are stored as hashes in SQLite with a 24-hour sliding inactivity lease; the persistent browser cookie is retained for up to 30 days, but server-side expiry remains authoritative. Bare `http://127.0.0.1:1111` without an existing cookie or `?bootstrap=` remains unauthorized. The SPA awaits bootstrap before the first API fetch and directs authentication failures to `agent-deck open`.

## 7. Migration and setup

Legacy manifests and MCP configuration are hints, never authority. `agent-deck use --refresh` diagnoses state and prints the explicit `agent-deck use <deck>` command; it does not invent a deck choice.

| Legacy state | Required behavior |
| --- | --- |
| Valid manifest and matching host config | Require explicit `use`, then write the v3 assignment, non-secret launcher/reference, stubs, and reload guidance |
| Valid manifest but one or more supported host configs are missing or partial | Treat the manifest only as a hint, require explicit `use`, preserve matching host configuration, install the selected missing pieces, leave unrelated host configuration untouched, and report reload guidance per changed host |
| Manifest missing but one host config names a deck | Show the hint and require explicit `use` |
| Corrupt metadata | Preserve it for diagnosis and require explicit selection |
| Stale deck ID with one exact-name match | Offer that match but require explicit confirmation |
| Ambiguous matches | List safe candidates in the trusted CLI and require a choice |
| Host configs disagree | Refuse automatic conversion and require an explicit choice |
| `agent-deck use <deck> --no-mcp` | Write the assignment, manifest, and stubs; warn that no host transport is configured |
| Legacy v2-shaped `use.json` / Keychain entry (≤1.8.1) | Launcher migrates once to v3 assignment; credentials from that era are not accepted |

Assignment writes use C7. Setup reports each changed configuration file and the host reload or restart required.

The harness starts with binding inspection. On `GRANT_REQUIRED`, it tells the user to run the explicit `use` command and never chooses a deck itself. It shows the bound summary once and requests admin only after a user asks for an admin-scoped action. Setup, harness, migration, and troubleshooting docs must reflect the same model.

## 8. Verification and release

Target verification matrix (design spec; 1.7.0 shipped with partial automated coverage — see as-built table):

Automated and manual coverage should include:

- folder path resolution and assignment read/write (v3; legacy v2 / Keychain migration);
- tracked-config scanning so no secret material is reintroduced;
- supported-host transport reuse, transport/session close, `exit_admin_mode` downgrade without session close, hard kill, 30-minute admin expiry, and 24-hour session cleanup;
- every authorization-matrix cell across HTTP and MCP; route-registry enumeration proving every operation declares exactly one policy, including explicit public exceptions; denial of undeclared operations before handler execution; and forged-header/direct-HTTP attempts against agent-admin and dashboard-only actions;
- elevated switch with assignment file, `ADMIN_REQUIRED` / `DECK_FIXED` negatives, and peer reconnect on the new assignment;
- every migration row, including partially configured supported hosts, and required reload behavior for each changed host; and
- a real flow: `use` → restart agent → automatic normal binding → playbook proposal → one admin approval → create or switch and bind → surface shared impact → edit the bound deck → peer reconnect on the new deck.

NOT-44 verification remains separate and mandatory: direct HTTP and MCP calls for a service outside the bound deck return `RESOURCE_OUT_OF_SCOPE`, while authenticated dashboard behavior remains unchanged.

**Release (1.7.0):** NOT-45 and NOT-44 shipped together after partial automated coverage (see as-built row), `npm run release:smoke`, and integration tests on main.

### As-built (current)

| PRD area | Status |
| --- | --- |
| C1–C2 folder assignment file (v3) | Shipped — CLI `use` writes/reads assignment; no secret; backend stores no workspace→deck mapping |
| C3 runtime MCP session | Shipped — MCP reads live mode from backend |
| C4 ephemeral `agent-admin` | Shipped — `/admin/approve` dashboard page; menubar challenge links |
| C4 switch rule (elevated + assignment file) | Shipped — else `DECK_FIXED` / `ADMIN_REQUIRED`; peers switch on reconnect |
| C5 admin scope (list decks + workspace counts) | Shipped for HTTP + MCP |
| C6 playbook proposals | Shipped (agent `propose_playbook_patch`; direct mutation dashboard-only) |
| C7–C8 assignment rewrite | Shipped — rewrite `.agent-deck/use.json`; peers switch on reconnect |
| C9 launch-selected deck | Shipped — `x-agent-deck-deck-id` launch sessions; `DECK_FIXED`; public `/api/launch/*` |
| Credential precedence | Shipped — deck header → `GRANT_REQUIRED` (“No deck selected for this connection”) |
| Central policy registry + route enumeration | Shipped — `HTTP_ROUTE_POLICIES` + `onRequest` hook; enumeration test on boot |
| §8 verification matrix (partial automated) | Partial — `auth-matrix.test.ts`, route-policy enumeration, containment tests, and related unit tests cover forged headers, elevation e2e, and NOT-44 scope; full host-transport lifecycle and canonical-path alias rows remain manual / follow-up |

## 9. Threats and non-goals

Design threats this feature mitigates (full automated coverage per §8 matrix not yet complete — see as-built gaps):
- forged authorization headers, reused or self-approved admin challenges, server restart, crashed hosts, concurrent deck changes without elevation, and newly added routes that omit policy.

Non-goals for v1:

- temporary deck switching;
- persistent admin authority in the assignment file;
- multiple simultaneous deck assignments per folder;
- agent access to OAuth, secrets, tool settings, collection mutation, or direct playbook mutation; and
- replacing dashboard review of playbook suggestions.

## 10. Implementation map (as-built)

Primary touchpoints (1.7.0 baseline; later tickets called out per bullet):

- SQLite schema + migrations — trusted **runtime** sessions
- `packages/backend/src/trusted-session/` — runtime sessions, elevation
- `packages/backend/src/lib/http-route-policies.ts` — centralized policy registry + Fastify hook
- MCP transport session establishment (**NOT-53**, **NOT-105**, **NOT-108**) — launch `x-agent-deck-deck-id` **before** advertising `mcp-session-id`; precedence: deck header → `GRANT_REQUIRED`; follow-up POST/GET/DELETE re-validate the same deck credential (401 without destroying transport); `/mcp/connect-deck` creates launch sessions; failed initialize after connect revokes via `mcp/disconnect-deck`; elevated assignment switch may call `setRuntimeSessionDeck`
- CLI `use` / `use --refresh` / `mcp-launch` (**NOT-108**) — assignment writer + launcher (`packages/cli/src/assignment.ts`); explicit Cursor `use` creates or repairs the user-level `mcp-launch` entry with `AGENT_DECK_WORKSPACE` (last explicit workspace wins), while `status` / `use --refresh` run the read-only `inspectCursorMcpConfig` report and never write; custom wrappers are not overwritten. Contract: [docs/decisions/cursor-mcp-config-resolution.md](./decisions/cursor-mcp-config-resolution.md)

- Dashboard `/admin/approve` + menubar challenge links
- Harness + docs — `CLAUDE.md`, setup/migration copy, `CHANGELOG.md`

For migration/rollback notes and route-to-matrix mapping, see PR #30 and release smoke (`scripts/release-smoke.sh`).

## History

Agent Deck **1.7.0** introduced path-bound workspace grants (opaque secrets, grant HTTP/MCP auth, Keychain). **1.8.2** ([NOT-105](https://linear.app/not-so-fat/issue/NOT-105/launch-selected-deck-for-agent-deck-mcp-connections-fixes-worktree)/107/108; [CHANGELOG](../CHANGELOG.md#182--2026-09-15)) removed that machinery: folder assignment file + launch-selected deck header only, with admin elevation as the sole approval step. Legacy v2/Keychain reads remain for upgrades from 1.8.1 and earlier; the error code name `GRANT_REQUIRED` is kept for compatibility (message: “No deck selected for this connection”).

