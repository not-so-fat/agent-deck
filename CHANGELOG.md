# Changelog

## 1.11.3 — 2026-09-23

### Feature: one-call `get_session_context` bootstrap (NOT-189)

- Adds a read-only `get_session_context` MCP tool that replaces the two-call `get_session_binding` + `get_bound_deck` opener sequence with a single `/api/scope/deck` read: workspace root, effective deck id/name/source, badge, `display_summary`, services, credentials, and id/title/triggers playbook summaries (bodies stay lazy via `get_playbook`). The generated harness opener, checked-in `CLAUDE.md`/Cursor rule blocks, and session skill/docs now point at the one-call opener; `get_session_binding`/`get_bound_deck` remain registered for compatibility only. Adds `scripts/bench-session-context.mjs`, gating a 100-call p95 < 250ms benchmark in CI.

### Fix: "Get MCP URL" copies the correct Agent Deck endpoint (NOT-257)

- "Get MCP URL" derived the URL from the dashboard's own origin, which is wrong whenever MCP runs on a different host/port than the dashboard. The backend now serves the canonical endpoint from `GET /api/mcp/endpoint` (`AGENT_DECK_HOST` / `AGENT_DECK_MCP_PORT`, default `127.0.0.1:1110`), and the button copies that value verbatim to the clipboard and toast.

### UI: more compact Agent Deck top bar (NOT-256)

- Tightens the top bar's spacing using existing layout tokens, with a regression test covering the new layout.

### UI: "Add Deck" label uses the shared display font token (NOT-259)

- Routes the "Add Deck" label through `--font-ui-display`, matching the rest of the dashboard chrome.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.
- Reload MCP in your IDE (or restart the agent session) to pick up the new `get_session_context` tool.

## 1.11.2 — 2026-09-21

### Fix: `switch_deck` guidance for an unbound MCP session (NOT-234)

- An unbound session calling `switch_deck` used to throw a bare, unguided `GRANT_REQUIRED` — agent guidance wrongly sent the human to `agent-deck use` instead of just retrying the bind. `GRANT_REQUIRED` now carries a structured, bind-first message that branches between "not yet bound" (retry the bind) and "no deck assigned" (run `agent-deck use`).

### Fix: warn on a stale `agent-deck` earlier on PATH (NOT-236)

- If an older `agent-deck` CLI sits earlier on `PATH`, it silently runs `mcp-launch` and hides newer launcher features (e.g. the NOT-212 browser auto-open). `doctor` and `mcp-launch` startup now detect and warn about a stale CLI shadowing the current one.

### Fix: report detectable browser-open failures (NOT-237)

- `agent-deck open` no longer prints "Opened dashboard in your browser" when the open detectably failed (e.g. a missing opener binary raises `ENOENT`). Failures now surface an actionable message — opener binary, URL, and the menubar / `agent-deck open --path` fallback. Deck-switch and admin-elevation auto-open paths get the same handling. Note: the opener returns before the browser finishes launching, so success still only means the opener command was accepted, not that a window appeared.

### Fix: MCP client refreshes its tool list after bridge recovery (NOT-235)

- After a silent server re-initialize, the bridge now sends one `notifications/tools/list_changed` to the client so a session that outlives a backend upgrade re-fetches `tools/list` instead of calling tools the new backend lacks. Sent only when the client declared `capabilities.tools.listChanged` at initialize; overlapping recoveries share one notification.

### Fix: statusline follows the session-active deck after a switch (NOT-233)

- The statusline is fed by a live-display registry that a deck-switch approval didn't refresh, so it kept naming the previous deck even though `get_session_binding` already reported the new one. A resolved switch (session or workspace-default) now refreshes the live-display entry too, so the statusline and `get_session_binding` agree.

### Fix: `get_decks` / `bind_workspace` tool text scoped to the active deck (NOT-232)

- `get_decks` said "List all decks" while actually returning only the session deck, leading agents to conclude named decks didn't exist. Both tool descriptions now state the active-deck limit and point at `switch_deck` by exact name; `bind_workspace` no longer directs callers to `get_decks`.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.
- Reload MCP in your IDE (or restart the agent session) to pick up the updated tool descriptions and bridge recovery notification.

## 1.11.1 — 2026-09-21

### UI: Avenir-first dashboard labels

- The dashboard's display font (`--font-ui-display`) now leads with Avenir (local system stack, no downloads) instead of Optima.
- More chrome labels use it: Register MCP / API key / Playbook, Export all, Import, Copy for agent, the Feedback playbook filter label, and the Proposals / Detail headings. Deck names, search, filter values, auth notes and proposal/detail content stay Monaco.
- Corrected the 1.11.0 notes below (stub paths, status-line wording, MCP reload reason, `--scope project` upgrade step). No behavior change.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start` to load the updated dashboard.

## 1.11.0 — 2026-09-21

### Feature: switch decks from an agent session, with your approval

- Agents can now call `switch_deck` to ask for a different deck. The request only creates a pending approval — the active deck does not change until you approve, and no MCP reload is needed afterwards.
- You choose the scope when you approve: **This session only**, or **This workspace by default** (writes the folder's `.agent-deck/use.json`). Decline, expiry or a failed write leaves every binding unchanged.
- Approval reaches you three ways: the host's native form when the IDE supports MCP elicitation, otherwise a two-choice approval page that opens in your browser (once per request), plus a **Pending approvals** inbox in the menubar to recover a missed request.
- Failures on the approval page say what is wrong (expired, already used, session gone, not signed in) instead of an inert button.
- `get_session_binding` (and the `display_summary` line agents show) now reports the active session deck separately from the workspace default, so a session-only switch is visible. The terminal status line is unchanged.

### Change: no per-playbook stub files

- `agent-deck setup` and `agent-deck use` no longer generate deck-specific playbook stubs (Cursor rule stubs under `.cursor/rules/agent-deck-stubs/` and Claude skill stubs under `.claude/skills/agent-deck-*/`). Agents discover playbooks at runtime from `get_bound_deck` and read bodies with `get_playbook`, so switching decks never leaves stale files behind.
- On the next `setup` / `use`, stubs Agent Deck previously generated are removed (only files carrying Agent Deck's markers; your own skills and rules are untouched) and a note is printed.
- Trigger changes from accepted playbook patches take effect on the next `get_bound_deck` call — `agent-deck use --refresh` is no longer needed for them.

### Change: retired legacy switch paths

- Deck switches never use admin elevation any more. `bind_workspace` is bootstrap-only; use `switch_deck` to move an existing session. Admin elevation remains for creating and editing decks.
- Regenerated harness guidance (`CLAUDE.md` / `.cursor/rules/agent-deck.mdc`) teaches `switch_deck`. Re-run `agent-deck setup --client <client>` to refresh yours.

### UI

- Dashboard section labels (My Decks, Add Cards, My Collection, Get MCP URL, Feedback, review queue) use a configurable display font (`--font-ui-display`, system stack, no downloads). Card contents stay Monaco.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.
- Reload MCP in your IDE (or restart the agent session): the bridge's approval-page auto-open and the new tool list live in the `mcp-launch` process your IDE spawns, which keeps running the old code until reloaded.
- Run `agent-deck setup --client <client>` (or `agent-deck use <deck>`) from each folder that had generated stubs to remove them. Add `--scope project` to `setup` if you keep the guidance block in the repo (`CLAUDE.md` / `.cursor/rules/agent-deck.mdc`) rather than globally.

## 1.10.6 — 2026-09-20

### Fix: admin approval opens the approval page and explains failures (NOT-199)

- After `request_admin_elevation`, the MCP bridge opens the approval page in your browser, already signed in to the dashboard (set `AGENT_DECK_NO_OPEN` to skip). The tool result is never held back by this.
- If the open is skipped (the bridge was moved to a different MCP server by a deck assignment) or the browser cannot launch, the reason goes to stderr and the approval link in the tool result still works.
- The approval page now says what is wrong instead of an inert button: this browser is not signed in to the dashboard (run `agent-deck open`), the link is incomplete, the request expired or was already used, the agent session is gone, or Agent Deck is unreachable. The Approve button is dropped when a retry cannot succeed.
- Previously a browser without a dashboard sign-in showed "No deck selected for this connection" on a live-looking button.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.
- Reload MCP in your IDE (or restart the agent session): the auto-open lives in the `mcp-launch` bridge your IDE spawns, which keeps running the old code until reloaded.

## 1.10.5 — 2026-09-19

### Fix: a broken managed install now falls back to the last good version

- The `agent-deck` launcher checks a version once (then marks it `.verified`). If `current` cannot load, it falls back to the newest intact version, repoints `current`, and says so on stderr instead of crashing.
- After this, a bad update no longer leaves `agent-deck upgrade` unable to run.
- Corrected the 1.10.4 recovery steps below (the `agent-deck install` route could not work on a broken install).

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.

## 1.10.4 — 2026-09-19

### Fix: auto-update could install a broken CLI that will not start

- A background auto-update could leave a truncated file in the new version (`SyntaxError: Unexpected end of input` on `agent-deck start`, MCP connection closed) and still switch `current` to it.
- Concurrent CLI launches used to extract the same version into one shared temp directory; each install now gets its own.
- Every downloaded version is syntax-checked before it is installed or activated. A version that fails the check is discarded and re-downloaded instead of activated.

### If you are stuck on a broken 1.10.3

`agent-deck upgrade` and `agent-deck install` run the broken version, so they cannot fix it. Install the fixed version by hand instead:

- `npm install --prefix ~/.agent-deck/versions/1.10.4 @agent-deck/cli@1.10.4`
- `ln -sfn ~/.agent-deck/versions/1.10.4 ~/.agent-deck/current`
- `agent-deck stop; agent-deck start --daemon`, then reload MCP in your IDE.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.

## 1.10.3 — 2026-09-19

### Fix: Create Deck from the dashboard works again (NOT-153)

- Create Deck from the UI always failed; the dashboard can create decks again.
- Failed creates no longer leave a half-created deck, and errors show as clear toasts.

### Fix: CLI under host agent sandboxes (readonly `~/.agent-deck`) (NOT-154)

- Host sandboxes that can only write the workspace used to fail `agent-deck use` with a bare SQLite “readonly database” error.
- When the folder assignment already matches, the CLI repairs the project MCP pin without writing `~/.agent-deck`; otherwise it exits with an explicit sandbox / home-write recovery message.

### Docs / wording: drop leftover grant-model language (NOT-119)

- Setup-installed agent harness, display source names, and trusted-session docs now describe folder assignment + launch header + admin elevation only.
- **Re-run `agent-deck setup`** to refresh agent instructions between the harness markers.

### Internal

- Prune unused shadcn UI wrappers and their exclusive npm deps from the dashboard; add `apps/agent-deck/README.md` + `components.json` for re-adding blocks (NOT-46).

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.
- Re-run `agent-deck setup` (Cursor/Claude/Codex as you use) so harness wording matches the assignment model.

## 1.10.2 — 2026-09-18

### Fix: no-deck MCP connections explain recovery instead of trapping Cursor in `mcp_auth` (NOT-50)

- An MCP connect with no folder assignment (or no `x-agent-deck-deck-id`) used to answer **401**. Cursor treated that as OAuth and dead-ended on `mcp_auth` — the wrong recovery path for “pick a deck.”
- Those connects now become an **unassigned, explain-only session**: `get_session_binding` returns `GRANT_REQUIRED` with assignment recovery text; deck-scoped tools stay unavailable. Sending a deck header later cannot turn that session into a normal deck-bound one.
- `mcp-launch` still starts without a deck header so the session can explain what to do; missing assignment prints a stderr hint. Diagnostics use the same “don’t use `mcp_auth`” recovery line.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.
- Reload IDE MCP hosts once. If Agent Deck tools look missing or Cursor offers `mcp_auth`, run `agent-deck use <deck> --client cursor` in the project folder, then reload MCP — do not complete OAuth.

## 1.10.1 — 2026-09-17

### Fix: one duplicate display name no longer stops store sync for everyone (NOT-123)

- A single display-name collision anywhere in the file store aborted the whole store→sqlite reindex, so multi-laptop sync stopped dead and stayed dead — three playbooks sat unindexed for five days while `status` and `doctor` reported OK and the only trace was a `console.error` in `backend.log`.
- Display names are cosmetic; ids are what the snapshot keys on. **Duplicates are now warnings** that name every colliding path, and the import proceeds. SQLite still holds a UNIQUE index per display name, so later files are indexed as `<name> (imported)` — the same policy as the existing dedupe migration — and no card is dropped. **Genuine id collisions still fail closed:** that is real ambiguity, and one file would silently overwrite the other.
- The reindex outcome (timestamp, ok/error, warnings) is persisted in store meta. `agent-deck status` and `agent-deck doctor` report `Last reindex FAILED <when>: <error>`, and **doctor exits non-zero** — a failed import is visible on day one instead of after five days.
- `agent-deck reindex` prints its warnings instead of burying them in the result JSON.
- The status reader opens SQLite **read-only**: `DatabaseManager`'s constructor migrates, and a diagnostic must not mutate the database it is reporting on.
- A throw from outside the apply-snapshot path (an unreadable nested store directory, a file removed mid-walk) is caught, converted to a failed result, and persisted — previously it escaped and left the *previous*, stale outcome on display after a reindex that in fact failed.

### Fix: the supervisor now names the origin of every stop, and a failed start leaves a diagnostic (NOT-135)

- A failed preflight bypassed every persistent diagnostic. `runStart` returned as soon as the native probe failed, so an ABI mismatch reached only the invoking terminal: nothing in `supervisor.log`, nothing for `agent-deck status`. Every pre-supervisor exit — preflight, port conflict, missing backend build, a dead daemon supervisor — is now persisted to `supervisor.log` and to a record `status` reads.
- Signal handlers were installed only after startup finished, so a stop landing during preflight, upgrade checks, port probes or entry resolution took Node's default exit path — the exact missing-origin failure this ticket is about. They are now installed **before the first startup step**, once supervisor mode is known, and name the phase they interrupted.
- The daemon launcher gets its own handler: it owns no run state and no children, so it records the interrupted start and leaves an already-spawned supervisor alone.
- `verifySqliteNative` matched `ERR_DLOPEN_FAILED` in the error *message*, where Node never puts it, so an arch mismatch got no rebuild hint. It now matches on `code`.

### Internal

- The test run fails to start when `packages/shared/dist` predates its source or no longer throws for the real store (NOT-138). The real-store guard reaches every package through that build, so a lagging build removed it silently and store writes landed in `~/.agent-deck` again.
- Every test process now starts from ports that cannot reach a deck (`AGENT_DECK_BACKEND_PORT` / `AGENT_DECK_MCP_PORT` = 0 in all four vitest configs); `global-setup` fails before the first test if a config drops the pins. An isolated `AGENT_DECK_HOME` does not scope ports, so a test outside the harness could previously `stop` the developer's own daemon.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.
- **`agent-deck doctor` now exits non-zero when the last reindex failed.** If you gate CI or a shell prompt on doctor's exit code, expect a new failure mode. Run `agent-deck reindex` to see the warnings and clear the record.

## 1.10.0 — 2026-09-16

### Fix: MCP clients recover from a backend restart on their own (NOT-101)

- **The contract:** transport sessions do *not* survive a restart. Instead the server tells the client the session is gone, and the bridge re-initializes without anyone noticing.
- Unknown `Mcp-Session-Id` now returns **404** with `mcp-session-status: expired` (was **400** `Bad Request: No valid session ID provided`, which bridges could not tell apart from a malformed request). An `initialize` carrying a stale session id is accepted and gets a fresh session.
- `agent-deck mcp-launch` no longer shells out to `npx supergateway`. The built-in bridge caches the client handshake, replays it when the session goes missing, and retries the failed call — so an upgrade no longer strands every open IDE session. Set `AGENT_DECK_MCP_BRIDGE=supergateway` to fall back; note supergateway still does **not** reconnect and stays wedged until its host restarts.
- A restart that lands mid-call answers that one call with an error — never a hang, and never a silent retry of a tool call the server may already have applied. The bridge stays up and the next call goes through the new session. A stuck call no longer blocks the cancellation that would end it.
- Reconnecting keeps the deck you are on: the bridge re-reads the folder assignment before it replays the handshake, and checks which deck the new session is bound to. If a `bind_workspace` override or an elevated `switch_bound_deck` means the reconnected session would act on a different deck, the pending call is reported instead of retried there. When you had bound a deck yourself, further deck-scoped calls are refused the same way until you re-bind, so retrying the call cannot quietly apply it to the other deck; a session that just follows the folder assignment simply continues on the deck that assignment names now.
- A `bind_workspace` / `switch_bound_deck` whose answer arrives after the restart is reported as a lost binding instead of being taken at face value — it applied to a session that no longer exists, so the deck it names is not the one the reconnected session acts on.
- MCP `/health` gained `instanceId`, `startedAt`, `liveSessions`, and a `staleSessions` tally split into `recoveredSessions` and `unresolvedSessions`. `agent-deck status` prints a **Sessions** line and warns only about clients that never came back; ones that re-initialized on their own are reported as history, not as stranded.
- `agent-deck stop` now releases the MCP port instead of leaving the listener up.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.
- Reload IDE MCP hosts **once** so they pick up the new bridge. After that, restarts and upgrades recover on their own.
- Kill any long-lived `npx supergateway … 127.0.0.1:1110/mcp` processes left over from before the upgrade — they never reconnect.

## 1.9.0 — 2026-09-16

### Add: Codex host setup (`--client codex`)

- `agent-deck setup --client codex` installs or refreshes Agent Deck bootstrap guidance in global or project `AGENTS.md`, marker-merging it without replacing unrelated instructions. Codex MCP transport still comes from the separately installed Agent Deck plugin (`agent-deck mcp-launch`) — Codex setup merges `AGENTS.md` only.
- `--scope project` is now accepted for `codex` alongside `cursor` and `claude`.

### Changed: Claude Code registers the trusted stdio bridge

- Claude Code setup now registers `agent-deck mcp-launch` over stdio instead of a bare HTTP URL, carrying custom host/port values in the entry's environment. A bare HTTP entry cannot select a deck.
- `agent-deck debug-mcp` probes with the folder's deck/workspace headers, reports a missing folder assignment explicitly (and skips the authenticated probe) instead of misdiagnosing the expected `GRANT_REQUIRED` response as a daemon failure, and reports project/user launcher conflicts symmetrically.
- `debug-mcp` now **exits 1** when a Claude entry is still a bare HTTP URL instead of the `mcp-launch` stdio bridge. Recheck anything scripted on its exit code.

### Fix: fail-closed Agent Deck session bootstrap

- Generated Cursor and Claude harnesses now require `get_session_binding` → `get_bound_deck` before task work whenever Agent Deck MCP is configured, including launch-selected unattended sessions that intentionally have no `.agent-deck/use.json`.
- Project-scoped harnesses no longer emit the obsolete `bind_workspace` flow. `agent-deck use <deck>` is documented as the optional persistent folder-assignment path, not the source of connection authority.
- The session skill permits only Agent Deck configuration detection and read-only connection diagnostics before the bootstrap gate passes.
- Connection recovery now distinguishes host transport, folder assignment, instruction discovery, and session bootstrap.

### Fix: deck membership outside the deck routes reaches the store files (NOT-121)

- Accepting a `kind: create` playbook proposal now writes the new playbook id into `decks/<id>.json`. Previously the `.md` landed but the deck link lived only in SQLite, so `agent-deck reindex` (and every git-sync pull) dropped the playbook from the deck.
- Same flush for every other non-route caller: credential/service/playbook deck links, bundle import, and CLI service delete. Deleting a card now also removes it from the deck files it was on — a deck naming a missing card used to abort the next reindex.
- A deck file that cannot be written during a card delete no longer strands the card's own file: the card is still removed from the store before the write error surfaces, so a failed delete can't be undone by the next reindex.
- No change to reindex semantics: files still win.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.
- Re-run `agent-deck setup --client <host>` for each host so the regenerated harness carries the fail-closed bootstrap gate.
- Claude Code: migrate an older user-scope HTTP entry — `claude mcp remove agent-deck -s user && agent-deck setup --client claude`.
- Codex: verify the Agent Deck plugin is installed and enabled, run `agent-deck setup --client codex`, then start a new Codex task so MCP + `AGENTS.md` guidance reload.
- Reload IDE MCP hosts so connections send the deck header.

## 1.8.2 — 2026-09-15

### Add: launch-selected deck + folder assignment (NOT-105, NOT-108)

- MCP connections need `x-agent-deck-deck-id` or they get **No deck selected for this connection** (HTTP 401; machine code still `GRANT_REQUIRED`).
- `agent-deck use` / `mcp-launch` write and read `<folder>/.agent-deck/use.json` **v3** (`deckId`, `deckName`, optional `mcpUrl`) — **no secret**. Legacy v2 / Keychain migrate once to v3.
- Elevated agent may switch a folder’s deck only when an assignment file exists; otherwise `DECK_FIXED` / `ADMIN_REQUIRED`. Peers pick up the new deck on reconnect.
- Public `GET /api/launch/decks` and `/api/launch/decks/:id/playbooks` for orchestrators (e.g. Agent Dealer).

### Removed: workspace grant machinery (NOT-108)

- No more workspace grant secrets, grant HTTP/MCP auth, or grant CLI issue/store. Restarting the daemon rebuilds the session DB without the old grant tables.
- Removed error code `WORKSPACE_SCOPE_MISMATCH`.

### Removed: execution authority and coordinator enrollment (NOT-107)

- Deleted `/api/execution-authority/*` and CLI `agent-deck coordinator enroll|status|revoke`. Unattended workers select a deck with `x-agent-deck-deck-id` only — Agent Dealer must not mint or set enrollment env (NOT-106).
- `RESOURCE_OUT_OF_SCOPE` MCP contract shape is unchanged.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start`.
- Re-run `agent-deck use <deck>` in each project folder (migrates assignment to v3).
- Reload IDE MCP hosts so connections send the deck header. Agent Dealer worktrees stay deck-fixed without an assignment file (`DECK_FIXED`).

## 1.8.1 — 2026-09-14

### Fix: coordinator playbook metadata discovery (NOT-100)

- `GET /api/execution-authority/decks/:deckId/playbooks` returns playbook summaries for decks in the enrollment's `allowedDeckIds` (titles/triggers only).
- Deleted-but-still-allowed decks fail closed with `RESOURCE_OUT_OF_SCOPE` / `reason: deck_not_found` (distinct from `deck_not_permitted`).
- Enrollment is re-checked after awaits so revoke cannot race a successful metadata response; encoded-slash `deckId` path segments return `400`.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start` so the issuer picks up the new route.
- Enrolled coordinators can list playbook summaries with Bearer `enr_…:enrs_…` before minting authority.

## 1.8.0 — 2026-09-13

### Add: coordinator enrollment + short-lived execution authority (NOT-86)

- Durable enrollment / authority ledger (SQLite), HTTP issuer under `/api/execution-authority/*`, MCP auth with `authz_…:secret`, CLI `agent-deck coordinator enroll|status|revoke`.
- One-time `enrollmentSecret` (`enrs_…`) for coordinator mint; Bearer is `enr_…:enrs_…`. Authority secret is process-local for now (OS launcher → NOT-89; dashboard enroll UX → NOT-90).
- Interactive workspace grants unchanged.

### Fix: MCP session-local context and idempotent bind (NOT-84)

- One Agent Deck MCP process may host many transport sessions; request scope is immutable per transport (no process-global active session).
- Same-workspace + same-deck `bind_workspace` is idempotent; different-deck bind requires elevation when out of scope, then retries.
- Live-display unregister on transport close uses a short abort timeout so local session maps always clear if the backend hangs.

### After upgrade

- Upgrade the CLI, then `agent-deck stop && agent-deck start` (or restart the daemon) so MCP and the issuer pick up the new code.
- Enroll a coordinator: `agent-deck coordinator enroll --coordinator-id <id> --deck <deckId>…` — store the one-time `enrollmentSecret` (`enrs_…`) and use Bearer `enr_…:enrs_…` for mint; OS launcher and dashboard enroll UX come later.
- Reload IDE MCP hosts after upgrade so session-local bind behavior applies.

## 1.7.7 — 2026-09-12

### Fix: durable dashboard entry and recovery (NOT-67)

- **Dashboard session survives backend and browser restarts:** cookie retained up to 30 days; renews for 24 hours after dashboard use. Bare `http://127.0.0.1:1111` still grants no authority without a session.
- **`start` / `status` no longer print `?bootstrap=` URLs:** they point to `agent-deck open`; only `agent-deck start` / `agent-deck open` open a short-lived one-shot bootstrap URL in the browser.
- **Expired dashboard auth UI:** shows **Dashboard Access Expired** and `agent-deck open` — not daemon restart. Stale `?bootstrap=` is stripped from the address bar after the bootstrap cookie is set (or the attempt fails).
- **Verify:** Upgrade CLI → `agent-deck start` (or `agent-deck open`) → use the dashboard → restart backend → reopen `http://127.0.0.1:1111` in the same browser (should still load within 24h of activity). After the session expires, the UI should say run `agent-deck open`, not `agent-deck stop && start`.

## 1.7.6 — 2026-09-10

### Fix: statusline Unbound when live display has no workspace folder

- **Cause:** Grant MCP connect used the **server** `AGENT_DECK_WORKSPACE` (usually unset). Live display registered without `workspaceRoot`, so `GET /api/scope/display` could not match the Claude Code cwd. A late init upsert could also wipe a folder set by `bind_workspace`.
- **Fix:** `mcp-launch` forwards `x-agent-deck-workspace`; connect prefers that header (then prior bind); live-display upsert preserves an existing `workspaceRoot` when omitted; Claude `.mcp.json` pins `AGENT_DECK_WORKSPACE` on `agent-deck use`.
- **Verify:** Upgrade + restart, then in the project folder run `agent-deck use <deck> --client claude`, reload Claude MCP, confirm footer `◆ <deck> · …` (or `echo '{"cwd":"'"$PWD"'"}' | agent-deck statusline`).

## 1.7.5 — 2026-09-10

### Fix: statusline stays Unbound when live display uses `source: "grant"` (Claude Code / Cursor CLI)

- **Cause:** Trusted sessions register live display with `source: "grant"`, but `DeckDisplaySourceSchema` only allowed `session_override` | `env` | `unbound`. `POST /api/scope/live-display` rejected those registrations, so the footer never left Unbound.
- **Fix:** Accept `grant` in the display source enum (aligned with `DeckBindingSource`).
- **Verify:** Bind a deck in Claude Code, then confirm the status line shows `◆ <deck> · …` (or `echo '{"cwd":"'"$PWD"'"}' | agent-deck statusline`).

## 1.7.4 — 2026-09-09

### Docs + CLI: Cursor MCP contract (NOT-54) and read-only diagnostics (NOT-52)

- **Decision note:** [docs/decisions/cursor-mcp-config-resolution.md](docs/decisions/cursor-mcp-config-resolution.md) records evidence-backed Cursor MCP precedence, how the global launcher resolves workspace (`AGENT_DECK_WORKSPACE`), fail-closed cases, and known multi-root host bugs.
- **Read-only inspector:** `inspectCursorMcpConfig` / `status` / `use --refresh` report global + project shapes, transport, workspace pin, grant present/missing with deck name/id (no secrets), and issues including bare-URL → `mcp_auth` and `stale-endpoint` (endpoint mismatch text lives in that issue, not a separate endpoint line).
- **`status` / `use --refresh`:** print the inspection report and never rewrite MCP config (repair remains explicit `agent-deck use`).
- **Inspector review follow-ups:** resolve project `${workspaceFolder}` pins before grant lookup; treat only usable v2 grants (`version: 2` + `grantId`) as present (legacy v1 → `grant-missing`); keep per-source `shape=missing` but do not list shadow `missing` in overall issues when an effective entry exists.

### After upgrade

- Upgrade the CLI (`agent-deck upgrade` or reinstall). `agent-deck status` and `agent-deck use --refresh` now print the Cursor MCP inspection report without changing config.
- To repair a missing workspace pin: `agent-deck use <deck> --client cursor`, then reload Cursor MCP. Do not use Cursor's `mcp_auth` for Agent Deck grants.

## 1.7.3 — 2026-09-09


### Fix: Cursor workspace pin + start version output

- **Cursor user MCP repair:** an explicit `agent-deck use <deck> --client cursor` now creates or repairs Cursor's user-level `agent-deck` launcher with `AGENT_DECK_WORKSPACE`. This fixes v1.7.2 launchers that already used `mcp-launch` but still failed with `GRANT_REQUIRED` because Cursor started them outside the bound workspace.
- **Repair messaging:** every create/repair reports what changed; a workspace move names the previous and new pins and states that Cursor user-level Agent Deck is last explicit `agent-deck use` wins.
- **Custom wrappers untouched:** non–`agent-deck` user-level entries are left alone (with a skip warning on `use`).
- **Diagnostic-only status/refresh:** `status` and `use --refresh` report bare-URL, missing pin, stale endpoint, or custom-entry problems and never rewrite MCP config.
- **Setup preserves pin:** re-running global Cursor setup keeps a workspace pin written by `use`.
- **Start visibility:** successful foreground, background, and already-running `agent-deck start` summaries now print the CLI package version.

### After upgrade

- In the affected workspace, run `agent-deck use <deck> --client cursor`, then reload the Agent Deck MCP server in Cursor (or restart Cursor). Do not use Cursor's `mcp_auth` for Agent Deck workspace grants.

## 1.7.2 — 2026-09-09

### Fix: MCP grant auth across the transport session lifecycle (NOT-53)

- **Grant auth before advertising `mcp-session-id`:** failed grant auth no longer deletes a transport session after `initialize` already returned 200 — that left clients with a dead id (`No valid session ID provided` / `Session not found`).
- **Follow-up Bearer required:** POST/GET/DELETE with an established transport session re-validate the workspace grant; missing/wrong Bearer returns 401 without destroying the transport session (retry with the correct Bearer succeeds).
- **`grantId:secret` Bearer:** parse `wgr_…:secret` at the auth boundary; reject when the claimed grant id does not match the secret. `mcp-launch` stays secret-only.
- **Connect ownership:** `/mcp/connect` binds an `mcp-session-id` to the grant that first connected; a different grant cannot steal it — including after the runtime session expires or is revoked.
- **Init failure cleanup:** if MCP initialize throws after grant connect, revoke the durable runtime session via `/api/trusted-session/mcp/disconnect`.
- **Cursor user MCP (related):** `agent-deck use` / `status` / `use --refresh` upgrade **legacy global bare `url`** entries only to `mcp-launch` (do not create missing or overwrite custom wrappers); note that Cursor's `mcp_auth` is not the grant path.

### After upgrade

- Restart Agent Deck (`agent-deck stop && agent-deck start`) so MCP picks up grant-before-advertise and follow-up Bearer checks.
- In each workspace: `agent-deck use <deck>` if needed, then reload Cursor MCP (or restart Cursor). Do **not** use Cursor's `mcp_auth` for Agent Deck grants.
- If `~/.cursor/mcp.json` still has a bare `url` for agent-deck, run `agent-deck use <deck> --client cursor` in the intended workspace. Current releases keep `status` diagnostic-only.

## 1.7.1 — 2026-09-09

### Fix: `agent-deck use` grant activate

- **Empty JSON body on activate:** `activate` / `revoke-pending` now send `body: '{}'` with `Content-Type: application/json`. 1.7.0 set the header with no body, so Fastify returned `FST_ERR_CTP_EMPTY_JSON_BODY` and the CLI only printed opaque `Bad Request` — no `.agent-deck/use.json`, MCP stayed `GRANT_REQUIRED`.
- **Clearer CLI errors:** trusted-writer failures prefer Fastify `message` over bare `error: "Bad Request"`.

### Dashboard entry (bootstrap by default)

- **`agent-deck start` opens the dashboard by default** with a one-shot `?bootstrap=` cookie (foreground + daemon + `setup --start`). Opt out: `--no-open` or `AGENT_DECK_NO_OPEN=1`.
- **`agent-deck open [--path …]`** mints a fresh bootstrap URL and opens the browser (recovery / menubar).
- **`status` / start banners** print a bootstrapped Dashboard URL when possible — bare `http://127.0.0.1:1111` is not a usable link after 1.7.0 auth.
- **Menubar** “Open dashboard” and admin-approval rows run `agent-deck open` so each click gets a cookie (no bare href).
- **Frontend:** await bootstrap session before React Query mounts — fixes race where first paint stuck on **Error Loading Data / No valid workspace grant** (dashboard cookie miss — not MCP `GRANT_REQUIRED` / `agent-deck use`).

### After upgrade

- Restart Agent Deck (`agent-deck stop && agent-deck start`) so the new CLI defaults apply.
- Prefer `agent-deck open` (or a fresh `start`) over bookmarked bare `:1111` URLs.
- If `agent-deck use` previously printed only `Bad Request`, upgrade the CLI and re-run `agent-deck use <deck>` in each workspace (then restart the IDE MCP host).

## 1.7.0 — 2026-08-31

### Trusted agent sessions (NOT-45) + bound-deck containment (NOT-44)

- **Workspace grants:** `agent-deck use <deck>` issues a private grant (file + macOS keychain), writes a non-secret MCP launcher config, and removes deck UUIDs from tracked MCP JSON.
- **Runtime sessions:** MCP connects with grant Bearer auth; backend establishes a runtime session (`x-agent-deck-session-id`) — forged deck/client headers no longer expand authority.
- **Agent-admin:** `request_admin_elevation` / `exit_admin_mode` MCP tools; dashboard cookie bootstrap replaces spoofable `x-agent-deck-client` header. MCP admin gates read live runtime session mode from the backend after dashboard approval (not a stale in-memory cache).
- **Pending grant activation:** `agent-deck use` stages the grant locally, then activates server-side; pending grants are unusable until activation succeeds.
- **Admin deck change rotates grant:** agent-admin `bind_workspace` / `switch_bound_deck` rotate the workspace grant, revoke peer sessions, and surface `grant_refresh_note` to run `agent-deck use <deck>` before MCP reconnect.
- **Dashboard admin approval:** `/admin/approve` page for elevation challenges; menubar lists pending approvals with deep links (`GET /api/trusted-session/admin/challenges`).
- **Central HTTP policy:** `HTTP_ROUTE_POLICIES` registry + Fastify `onRequest` hook enforce auth on every API route; boot-time enumeration test guards omissions.
- **Auth matrix tests:** forged legacy headers, elevation e2e, workspace scope mismatch, admin deck-change peer session revocation.
- **Playbook mutation boundary:** direct playbook mutation and tool-settings routes are dashboard-only at the policy hook (agents use `propose_playbook_patch`).
- **NOT-44 containment:** agents only see/call services on the bound deck (`RESOURCE_OUT_OF_SCOPE` on cross-deck HTTP/MCP); credential/playbook off-deck reads and deck mutations return structured `error_code`; live-session popover shows session mode + rows for the deck being edited.
- **Migration:** `agent-deck use --refresh` diagnoses only — run explicit `agent-deck use <deck>` to (re)issue grants.

### Dashboard frontend

- **React 19:** bump `react` / `react-dom` to 19.2.8; `@testing-library/react` v16; root `overrides` + Vite dedupe for a single React copy in the monorepo.

### Dependencies

- Bump openid-client, Radix UI (accordion, hover-card), jsdom (dev), and HOL plugin scanner GitHub Action.

### After upgrade

- Restart the Agent Deck daemon (or `agent-deck install` / managed activate) so backend, MCP, and dashboard pick up trusted sessions + containment.
- In **each workspace** that uses Agent Deck MCP: run `agent-deck use <deck>` (not just `--refresh`) to issue the workspace grant, then restart the IDE MCP host (Cursor / Claude Code).
- Re-run `agent-deck setup --client cursor|claude` if statusline/menubar wrappers are stale.
- For agent-admin deck edits: approve elevation at `/admin/approve` (or menubar pending-approval link) before `bind_workspace` / deck mutations.
- Expect agents to stay within the bound deck — cross-deck service/playbook access returns `RESOURCE_OUT_OF_SCOPE`.

## 1.6.4 — 2026-08-27

### OAuth silent refresh (stop daily Connect)

- **Status endpoint** (`GET /api/oauth/:serviceId/status`) renews expired access tokens silently when a refresh token exists — concurrent renewals for the same card are deduped so rotation-safe providers do not invalidate each other; returns `refreshFailed` when renewal fails.
- **Collection warnings:** `oauth_expired` only when there is **no** refresh token (expired-but-refreshable is not an error on the home view).
- **Dashboard MCP card:** authenticated + refreshable shows `Access expires … · renews automatically`; refresh failure still prompts Connect.

### After upgrade

- Restart the Agent Deck daemon (or rebuild from this commit) so status + warnings pick up silent refresh
- Open a Linear (or other short-TTL OAuth) card — expect the green renews-automatically line instead of daily re-Connect after access TTL

## 1.6.3 — 2026-08-11

### Custom MCP headers persist again

- **Fix:** secret custom headers (Authorization / Bearer / API keys) set on an MCP card no longer vanish. They were stripped by the git-synced file store and then wiped from SQLite on the next store reindex/restart, so the card showed "No custom headers."
- **New `ServiceHeaderVault`:** secret headers now live in the local secret store (Keychain), keyed per service — mirroring OAuth-token handling. Non-secret headers stay on the service row + git store; secrets never touch git and survive reindex/restart.
- Every Service-returning path (`GET /api/services`, `/:id`, create/update, refresh-icon, tool-settings, deck payloads) merges vault secrets back for the dashboard (masked in the UI); agent-scoped responses still strip them.
- One-shot startup backfill moves secret headers still sitting in SQLite into the vault, so an existing header survives the upgrade without re-entry.

### Dependencies

- Bump fastify 5.5→5.11, dotenv, postcss (dev), react-icons, and Radix UI (switch/checkbox/separator); update `actions/checkout` and `actions/setup-node` in CI.

## 1.6.2 — 2026-08-04

### Playbook review queue

- **Supersede open proposals:** `propose_playbook_patch` accepts `supersedes: ["pp_…"]`; targets become `superseded` with `supersededBy`, signals re-link to the successor (reject/stale still unlink)
- **`get_playbook` → `openPatches`:** compact open proposals so agents can replace the same lesson instead of stacking duplicates
- **Harness / stubs:** check `openPatches` and pass `supersedes` when revising the same lesson
- **Dashboard:** Superseded filter + successor link; **Reject** is one click (reason optional)

### After upgrade

- Restart the Agent Deck daemon (or rebuild from this commit) so backend/MCP pick up supersede + optional reject
- Re-run `agent-deck setup --client cursor|claude` (or `use --refresh`) so harness/stubs mention `openPatches` / `supersedes`
- Open Playbook review queue → Waiting should show one live proposal per lesson after agents pass `supersedes`

## 1.6.1 — 2026-08-04

### Dashboard

- **Edit custom headers on remote MCP cards:** service details always shows Custom Headers (including when empty or unhealthy); Edit → JSON editor; invalid JSON is blocked client-side (no PUT); values masked in view mode
- **Non-MCP cards:** keep read-only Custom Headers badge/list when headers are present (edit UI is remote `mcp` only)
- **MCP client cache:** updating `headers` on a remote `mcp` service invalidates the cached transport so a rotated Bearer/API key is used on the next call

### CLI

- **statusline.sh:** `npm root -g` failure no longer aborts under `set -e` (was exit 1 / host-contract flake); fall through to offline ◆ line
- **statusline.sh:** prefer baked setup CLI before PATH `agent-deck` so a managed launcher from another home cannot steal the process (release-smoke empty stdout)

### After upgrade

- Restart the Agent Deck daemon (or rebuild from this commit) so the dashboard and backend pick up header edit + cache invalidation
- Open a remote MCP card → Custom Headers → Edit to rotate a bad token without re-registering
- Re-run `agent-deck setup --client cursor|claude` (or let setup rewrite `~/.agent-deck/bin/statusline.sh`) so the statusline wrapper picks up the `npm root` fix

## 1.6.0 — 2026-07-30

### Managed CLI install + auto-upgrade

- **Recommended install:** `agent-deck install` (or `scripts/install.sh`) unpacks into `~/.agent-deck/versions/`, points `current`, writes `~/.local/bin/agent-deck` — **existing decks/credentials untouched**
- **Auto-update on by default** for managed installs: background npm check ≤1×/24h, download pending version, activate on next `start` / `doctor` / `upgrade` (never on statusline/menubar)
- **Opt out:** `AGENT_DECK_DISABLE_AUTOUPDATER=1`
- **`upgrade`:** managed path activates the version tree; npm-global path still uses `npm i -g` (compat)
- **statusline / menubar:** prefer managed launcher before PATH / npm global / `npx`
- **Docs:** README, SETUP, PUBLISHING; design `docs/superpowers/specs/2026-07-30-managed-cli-auto-upgrade-design.md`
- **Release smoke:** asserts managed modules in dist + offline activate without wiping data home

### After upgrade

- New users: `curl -fsSL …/scripts/install.sh | bash` then `export PATH="$HOME/.local/bin:$PATH"`
- Existing `npm i -g` users: optional `agent-deck install` (CLI binary only — no data migration); put `~/.local/bin` first on PATH
- Re-run `agent-deck setup --client cursor|claude` so statusline/menubar wrappers pick the managed launcher
- Restart any running Agent Deck daemon after managed activate

## 1.5.3 — 2026-07-29

### Fixes

- **Trigger count grandfather:** create still hard-caps at 16; update/`set_triggers` may keep or shrink legacy over-cap lists (never grow). Body/title updates no longer re-validate stored triggers through the create cap. Stub sync no longer throws on count. Agent/MCP rejects include a fix-and-retry hint (do not ask the user); dashboard create keeps actionable max-16 copy.
- **Store migrate + legacy triggers:** file codecs no longer apply the create max of 16 triggers, so SQLite→files migrate completes for older playbooks
- **CLI:** `agent-deck store migrate --force` rewrites existing store files from SQLite (was library-only; CLI previously rejected the flag)

### After upgrade

- Restart the backend (or rebuild from this commit) so the trigger grandfather and migrate fixes load
- If migrate aborted mid-run earlier: `agent-deck store migrate` fills missing files; use `--force` only to rewrite from SQLite

## 1.5.2 — 2026-07-27

### File-backed store (git-friendly sync)

- **Canonical file tree** under Agent Deck home: `playbooks/*.md`, `services/*.json`, `credentials/*.yaml`, `decks/*.json`, `manifest.json` — SQLite remains a rebuildable cache
- **Migrate / reindex:** `agent-deck store migrate [--dry-run]` dumps SQLite → files; `agent-deck reindex` rebuilds SQLite from files (also auto on startup when the tree hash changes)
- **Dual-write:** dashboard/CLI mutations update files; import force-flushes the store so reindex cannot wipe imported cards
- **Secrets stay local:** Keychain + OAuth tokens never enter the tree; secret-like HTTP headers stripped from service files
- **Docs:** [STORE_FORMAT.md](./docs/STORE_FORMAT.md) — user-owned git sync (Agent Deck never runs git)

### After upgrade

- Restart the backend once so first-run migrate can write the store tree (or run `agent-deck store migrate`)
- To sync laptops: put the store dirs + `manifest.json` in your own git repo; after `git pull`, run `agent-deck reindex` (or restart)

## 1.5.1 — 2026-07-23

### Session-history bootstrap

- **`agent-deck bootstrap`:** mine local Claude Code and/or Cursor agent transcripts into digests + an offline handoff for playbook authoring (`propose_playbook_patch` only — no auto-register, no LLM in the parser)
- **Hosts:** `--host claude|cursor|all` (default `all`); Cursor reads `~/.cursor/projects/*/agent-transcripts` (skips subagents); Claude reads `~/.claude/projects`
- **Output:** `$AGENT_DECK_HOME/bootstrap/<timestamp>/` (default `~/.agent-deck/bootstrap/`) — host-agnostic, not under `~/.claude`
- **Real-envelope parsing:** unwrap Cursor `<user_query>` / strip `<timestamp>`; drop host injections on **both** hosts (Claude slash/hook chrome, Cursor “Briefly inform…”); shared `workspaceSlug` merges Claude+Cursor for the same repo; `--limit` keeps newest by mtime

### After upgrade

- Try: `agent-deck bootstrap --workspace <repo-root> [--host cursor|claude|all]` then paste the printed handoff into an agent chat bound to that workspace
- Review create proposals in the dashboard — nothing is auto-registered

## 1.5.0 — 2026-07-22

### Playbook feedback accumulation

- **Durable `feedback_signals`:** every correction can be logged via MCP `propose_playbook_patch` (incl. `kind: signal_only`) without forcing an immediate patch
- **Dashboard Feedback table** (`/feedback-signals`): filter by playbook + status (`open` / `actioned` / `discarded`); select-all; discard; Copy for agent
- **Copy for agent:** Markdown instructions + YAML list with signal `id`s so curated proposes pass `signal_ids` for tracking
- **Lifecycle:** propose **links** open signals (parked / in-proposal); **accept** → `actioned`; reject/stale clears the link so feedback stays reusable
- **No backend LLM:** backlog browse/discard stay dashboard-only; MCP remains capture/propose (see `docs/decisions/no-backend-llm-boundary.md`)
- **Backfill CLI:** `agent-deck import-feedback-signals` for Claude Code transcript dirs
- **Harness:** paste-from-Feedback guidance; re-run `agent-deck setup` after upgrade

### Codex / Claude plugin packaging

- **Option A at monorepo root:** `.codex-plugin/plugin.json`, root `skills/` (setup / session / playbooks stubs), `.codexignore`, `assets/icon.svg`, `SECURITY.md`
- **Codex desktop connect:** declare `mcpServers: "./.mcp.json"` in the Codex manifest; use `Read`/`Write` capabilities (not `Interactive`) so Plugins UI does not expect a missing app connector
- **Claude Code:** `.claude-plugin/plugin.json` + `marketplace.json` sharing the same skills and `.mcp.json` (port 1110)
- **HOL scanner:** `.plugin-scanner.toml` ignore paths for product surfaces; `.github/workflows/hol-plugin-scanner.yml`; SHA-pinned Actions in `ci.yml`; Dependabot for npm + Actions
- **Version sync:** `scripts/sync-versions.mjs` also updates Codex/Claude plugin manifests
- Local preflight: `plugin-scanner` 2.0.1015 → **100/100**, zero high/critical (HOL awesome-list PR after green CI on `main`)

### After upgrade

- Re-run `agent-deck setup --client cursor|claude` so harness mentions Feedback table + `signal_ids`
- Open dashboard **Feedback** to curate open signals; **Review** still accepts/rejects proposals

## 1.4.4 — 2026-07-14

### Service tool proxy

- **In-band MCP errors:** `callServiceTool` treats remote `isError` / `file_not_found` as `success: false` with `MCP_TOOL_ERROR` (no longer disguised as success)
- **Slack Connect hint:** Slack services get an actionable `details.hint` on `file_not_found` (retry won't help; ask for re-upload)
- **Binary / oversized spill:** payloads that look binary or serialize to ≥48 KB write to `~/.agent-deck/tool-results/` and return `{ spilled, path, mimeType, size }`
- **Compact tool JSON:** MCP `toolResult` no longer pretty-prints (drops per-call whitespace tax)

## 1.4.3 — 2026-07-12

### Stub lifecycle sync

- **Bind/switch:** MCP `bind_workspace` and `switch_bound_deck` sync thin Cursor/Claude trigger stubs to the workspace; records path in `deck_workspaces` for later heals
- **Patch accept:** when triggers/title change on create, `set_triggers`, or retire, stubs refresh on all recorded workspaces
- **`agent-deck use --refresh`:** deck resolve by name when `deckId` is stale; `bind_workspace` accepts deck name or UUID
- **Slug collisions:** disambiguate stub filenames with playbook id suffix when titles slug to the same name
- Opt out with `AGENT_DECK_STUB_SYNC=off`

### Trigger conflict detection

- **Normalize + detect:** exact, subsumes, and overlap warnings on playbook create/update, deck link, and `propose_playbook_patch`
- **Patch review:** dashboard shows trigger conflict panel; preview recomputes `trigger_conflicts`; MCP returns `trigger_warnings`

### Scope & performance

- **`GET /api/scope/deck`:** playbook summaries only; wider secret-header stripping on scoped deck payloads
- **`get_decks` MCP:** metadata-only deck list for agents
- **Deck hydration:** batch JOIN loaders for `getDeck` / `getAllDecks` / `getActiveDeck` (fixes N+1)

### After upgrade

- Re-run `agent-deck use --refresh` (or bind in IDE) so stubs match deck triggers
- Re-run `agent-deck setup --client cursor|claude` if harness wording changed

## 1.4.2 — 2026-07-12

### CLI daemon mode

- **`agent-deck start --daemon`:** detached supervisor survives terminal/IDE close; logs to `~/.agent-deck/logs/` (`supervisor.log`, `backend.log`, `mcp.log`); returns immediately
- Foreground `agent-deck start` unchanged for debugging; docs/README default to `--daemon`

### Playbook review UX

- **Review queue layout:** scrollable detail panel with pinned Accept/Reject footer — no overlap on wide screens
- **Accept button:** gold gate style (`#C4B643`) matching agent-dealer review drawers
- **Diff panel:** `minmax(0,1fr)` grid columns prevent horizontal blowout on long lines

### Patch apply fixes

- **`apply-patch-ops`:** trim blank edges when serializing sections (stops body inflating on every accept)
- **`add_item`:** insert before trailing blank lines so new list items stay adjacent

## 1.4.1 — 2026-07-12

### Playbook review & proposals

- **Propose-time validation:** update patches dry-run before storage; **409** on anchor mismatch, non-list `amend_item` targets, or no-op ops (`PatchNoChangeError`)
- **MCP `propose_playbook_patch`:** typed `PatchOpSchema` with field descriptions (`add_item`, `amend_item`, `remove_item`, `set_triggers`, `rewrite_body`)
- **Dashboard review queue:** GitHub-style unified diff; narrow list + wide detail; **No change detected** and **Preview failed** banners; Accept disabled when preview has no diff
- **Harness + stub templates:** pushier stub descriptions, `propose_playbook_patch` op table, playbook-task workflow — re-run `agent-deck setup` after upgrade; `agent-deck use --refresh` after trigger changes

### Tests & docs

- Route tests for `POST /api/playbook-patches` (409/201) and `patchPreviewHasChanges`
- Learning-loop manual scenarios H (propose 409) and I (visual diff)

## 1.4.0 — 2026-07-11

### Playbook learning loop

- **Proposal queue:** `propose_playbook_patch` MCP tool, `playbook_patches` / versions / events tables, REST lifecycle (propose → preview → accept/reject)
- **Dashboard:** Playbook patches review page with diff preview and evidence panel
- **Harness:** correction-driven write trigger (update + genesis cases); `update_playbook` reserved for explicit user-directed edits
- Re-run `agent-deck setup --client cursor|claude` after upgrade for new harness wording

### A′ trigger stubs

- **`agent-deck use <deck>`:** project MCP config, `.agent-deck/use.json`, thin Cursor/Claude trigger stubs (pointer only — bodies stay on deck)
- **`agent-deck use --refresh`:** regenerate stubs after trigger changes; accept API returns refresh hint when triggers/title change

## 1.3.4 — 2026-07-06

### Security

- **MCP proxy:** bind to loopback by default (`AGENT_DECK_MCP_HOST`, default `127.0.0.1`) — fixes LAN exposure on port 1110
- **REST backend:** default `HOST` is `127.0.0.1` instead of `0.0.0.0`
- **CORS:** restrict browser origins to dashboard/dev loopback URLs (or `AGENT_DECK_DASHBOARD_ORIGIN`)

### Packaging & CI

- License metadata standardized to MIT across all published packages; `LICENSE` included in npm tarballs
- GitHub Actions CI: install → build → rebuild-native → test → type-check
- CI fixes: build workspaces before tests, skip macOS-only menubar test on Linux, spawn statusline via `node`
- Commit `.mcp.json` contributor wiring for loopback MCP URL

## 1.3.3 — 2026-07-05

### Dashboard

- **OAuth:** collection cards refresh after connect (popup `postMessage`, WebSocket, service modal close)
- **MCP tools:** clearer tool descriptions in the service details panel (summary + expand for long text)
- Empty deck builder placeholder centered; playbook details modal widened
- Updated README screenshots (`misc/Idea.png`, `misc/UI.png`)

### README

- Problem / Idea call out **self-improving skills** — feedback updates deck skills across sessions

## 1.3.2 — 2026-07-05

### Default ports (CLI / npx)

Fresh installs use shorter localhost ports:

| Surface | Port |
|---------|------|
| Dashboard | `http://127.0.0.1:1111` |
| Agent Deck MCP | `http://127.0.0.1:1110/mcp` |

Dev workflow unchanged (`8000` API, `3000` UI, `3001` MCP). Re-run `agent-deck setup` if your host still points at `11111` / `11112`.

### README & docs

User-facing Quick Start (global install, macOS Keychain warning, Cursor vs Claude MCP registration, agent-first skills). Tagline and Problem/Idea sections refreshed.

### Dashboard

- Home page ambient orbs animate again
- Browser tab title: **AgentDeck**
- Create-deck dialog: name only (matches deck model)

### Deck model

Removed unused `description` field from decks (schema, API, MCP `create_deck`, export bundles). Existing SQLite DBs migrate on startup; legacy export bundles with `description` still import.

## 1.3.1 — 2026-07-04

### Export / import (metadata layouts)

Port MCP, playbook, and deck layouts between machines or share deck templates. **No credentials or secrets** in the bundle.

```bash
agent-deck export all -o backup.agent-deck.json
agent-deck export deck <uuid> -o my-deck.agent-deck.json
agent-deck import backup.agent-deck.json
```

- **Dashboard:** My Collection **Export all** / **Import**; per-deck **Export** on My Decks
- **REST:** `POST /api/export`, `POST /api/import` (dashboard client only)
- **Import:** try create; **skip** when display name already exists (same name = same card/deck), link membership, report `created` / `reused` + warnings
- **Unique names:** deck `name`, service `name`, playbook `title`, credential `label` enforced in SQLite

### Dashboard UX

- Narrow / portrait layout scrolls (Glass-friendly); wide layout unchanged
- Inline rename for deck name (builder header) and service name (details modal)
- Removed per-card color picker (colors fixed by type)

## 1.3.0 — 2026-07-03

### MCP tool surface (breaking for agents & playbooks)

Default MCP catalog is **~16 tools** (was ~31). Hot path: `bind_workspace` → `get_bound_deck` → `call_service_tool` / `get_playbook`.

| New / primary | Replaces (removed from default) |
|---------------|----------------------------------|
| `get_bound_deck` (includes services, credentials, playbook summaries, `display_summary`) | `list_playbooks`, `list_bound_deck_services`, `list_bound_deck_credentials`, `list_active_deck_*`, `get_active_deck` |
| `manage_deck_card` (`action`: link \| unlink \| reorder, `card_type`, `card_id`) | `add_*_to_bound_deck`, `remove_*_from_bound_deck` (×3 card types) |
| `list_collection` (optional `card_type`) | `list_collection_services`, `list_collection_credentials`, `list_collection_playbooks` |
| `create_deck` | (unchanged; always on default profile) |

**Removed from MCP (use CLI / dashboard):** `delete_service`, `delete_playbook`.

```bash
agent-deck service list|delete <id>
agent-deck playbook list|delete <id>
agent-deck deck list|delete <id>
```

**Still on MCP:** `register_playbook`, `update_playbook`, `get_playbook`, `register_service`, `update_service`, `call_service_tool`, bind/session tools.

Optional: `AGENT_DECK_MCP_TOOL_PROFILE=legacy` restores old tool names for one release while you migrate playbooks. Dynamic mid-session tool loading is **not** supported (Cursor/Claude ignore `list_changed`).

### Playbooks — update required

Any playbook body (or skill/rule) that names old MCP tools will fail after upgrade. Search deck playbooks for the left column and rewrite:

| Old (broken on default MCP) | New |
|-----------------------------|-----|
| `list_playbooks` | `get_bound_deck` → read `playbooks` (id, title, triggers) |
| `list_bound_deck_services` / `list_bound_deck_credentials` | `get_bound_deck` |
| `add_service_to_bound_deck` / `add_credential_to_bound_deck` / `add_playbook_to_bound_deck` | `manage_deck_card` with `action: "link"`, matching `card_type` + `card_id` |
| `remove_*_from_bound_deck` | `manage_deck_card` with `action: "unlink"` |
| `list_collection_*` | `list_collection` |
| `delete_service` / `delete_playbook` | CLI: `agent-deck service delete` / `agent-deck playbook delete` |

`get_playbook` and `update_playbook` are unchanged.

### Harness (Cursor / Claude instructions)

Templates now use `get_bound_deck` (not `list_playbooks` / `list_bound_deck_services`). **Re-run setup** or agents keep calling removed tools:

```bash
agent-deck setup --client cursor   # refreshes ~/.cursor/rules/agent-deck.mdc
agent-deck setup --client claude   # refreshes harness block in CLAUDE.md
```

Then **restart Cursor / Claude Code** so MCP tool cache matches the new catalog.

### Upgrade from 1.2.x

1. **Install globally:** `npm i -g @agent-deck/cli@1.3.0`
2. **Restart:** `agent-deck stop && agent-deck start` (and `npm run dev:all` if you use `:3001` dev MCP)
3. **Restart Cursor / Claude Code** — clears stale MCP tool cache
4. **Re-run setup:** `agent-deck setup --client cursor` (or `claude`) — refreshes harness
5. **Update playbooks** — replace old tool names per table above (or temporarily `AGENT_DECK_MCP_TOOL_PROFILE=legacy`)

### Tests

- **MCP golden paths (CI)** — `golden-path.http.test.ts`: bind, `get_bound_deck`, `manage_deck_card` link/unlink, playbook get/update, `call_service_tool`, `create_deck`, catalog snapshot
- **Harness** — templates must not name removed tools (`list_playbooks`, `add_*_to_bound_deck`, …)
- **CLI rare ops** — `cli-runtime` delete + dependency block; collection-admin arg wiring
- **Release smoke** — after `setup --client cursor`, harness contains `get_bound_deck` and no removed tool names
- **FE (Vitest)** — dashboard drag link/unlink for service, credential, playbook (`useDragAndDrop.deck-link.test.tsx`)
- **Statusline / menubar (CI)** — bound + offline paths against HTTP stub (`display-surfaces.http.test.ts`); release-smoke installs menubar plugin script contract

## 1.2.10 — 2026-07-03

### Session-only binding (repo deck removed)

- **`bind_workspace` requires `deckId`** — `get_decks` then `bind_workspace({ workspaceRoot, deckId })`; no `.agent-deck/deck.yaml`
- **Removed** — `setup_repo_deck`, `get_repo_deck_status`, `POST /api/scope/resolve`, `GET /api/scope/manifest-template`, `repo-deck-init` on project setup
- **Harness** — session opener uses `get_decks` + `deckId`; re-run `agent-deck setup` to refresh global Cursor/Claude rules
- **Dashboard** — copy deck id (not yaml snippet) from My Decks

### Menu bar & session badges

- **SwiftBar menubar** — `agent-deck menubar`; default on macOS `setup` (`--no-menubar` to skip); brew + plugin folder auto-config
- **Session badges** — `⌘word` per MCP session in menubar, statusline `display_summary`, and `GET /api/scope/bindings`
- **Dashboard** — live session chip in page header (replaces old editing-deck name/cards chip); My Decks shows `N cards, M sessions`; Deck panel keeps `{name} ({n} cards)`

### Upgrade from 1.2.9

1. **Install globally:** `npm i -g @agent-deck/cli@1.2.10`
2. **Restart:** `agent-deck stop && agent-deck start` (and `npm run dev:all` if you use `:3001` dev MCP)
3. **Restart Cursor** — clears stale MCP tool cache (`setup_repo_deck` ghosts when `agent-deck-dev` was cached)
4. **Re-run setup:** `agent-deck setup --client cursor` (or `claude`) — refreshes harness + menubar plugin
5. **Bind with deck id:** agent calls `get_decks`, then `bind_workspace({ workspaceRoot, deckId })`
6. **Delete leftover** `.agent-deck/deck.yaml` — ignored by the server; confuses agents if left in repo

### Tests

- **`tools/list` regression** — asserts `setup_repo_deck` / `get_repo_deck_status` are not registered and `bind_workspace` requires `deckId`

## 1.2.9 — 2026-07-03

### Deck display — live MCP reality only

- **Live registry** — `bind_workspace` / `switch_bound_deck` register display state on the backend; status line shows only active MCP session binds
- **Unbound at launch** — no sidecar, manifest, or env guessing before `bind_workspace`
- **Removed** — `bindings.json` sidecar writes/reads, workspace/session sidecar lookup, CLI sidecar fallback
- **Unbound copy** — `◆ Unbound — bind a deck to use Agent Deck`; optional `· MCP offline` when backend is up but MCP is down
- **MCP health** — backend receives `AGENT_DECK_MCP_PORT` from `agent-deck start`; dev `dev:all` exports `:3001`; skip false offline when a live bind exists

### Upgrade from 1.2.8

1. **Install globally** (avoids slow `npx` on every statusline refresh): `npm i -g @agent-deck/cli@1.2.9`
2. **Restart backend:** `agent-deck stop && agent-deck start` (or `setup --client claude --start`)
3. **Re-run setup:** `agent-deck setup --client claude` — refreshes `statusline.sh`
4. **Re-bind once per MCP session:** ask the agent to `bind_workspace` (footer is unbound until bind)
5. **Monorepo dev:** set `AGENT_DECK_PORT=8000` for Claude statusline; restart `npm run dev:all` after pull

Optional: delete stale `~/.agent-deck/bindings.json` (ignored in 1.2.9).

If the footer still shows a deck before bind, statusline is hitting the wrong API (`:11111` prod vs `:8000` dev) — set `AGENT_DECK_PORT` to match your MCP backend.

## 1.2.8 — 2026-07-02

### Deck display — upgrade fix

- **Legacy sidecar fallback** — pre-1.2.7 workspace-keyed `bindings.json` entries still resolve when `session_id` is missing or not yet written
- **Statusline API handling** — trust any successful `/api/scope/display` response (fixes `◆ —` incorrectly falling through to **Agent Deck offline**)

### Upgrade from 1.2.6 / 1.2.7

1. **Install globally** (avoids slow `npx` on every statusline refresh): `npm i -g @agent-deck/cli@1.2.8`
2. **Restart backend:** `agent-deck start` (or `setup --client claude --start`)
3. **Re-run setup:** `agent-deck setup --client claude` — refreshes `statusline.sh` and drops `refreshInterval`
4. **Re-bind once per session:** ask the agent to `bind_workspace` (writes session-keyed sidecar)

If the footer still says **Agent Deck offline**, the statusline subprocess cannot reach `http://127.0.0.1:11111` (backend stopped) or is timing out (install global CLI; Claude `statusLine.timeoutMs` ≥ 3000).

## 1.2.7 — 2026-07-02

### Deck display (terminal status line)

- **Session-scoped bindings** — `bindings.json` keyed by session id (not workspace path); `GET /api/scope/display?sessionId=`; statusline reads host `session_id` from stdin
- **Event-driven refresh** — setup no longer sets `refreshInterval` (Claude) or timer polling; host refreshes on prompt/conversation update
- **Timestamp suffix** — bound lines show `(updated YYYY-MM-DD HH:mm)` from last bind; offline shows last known time when available

### Dashboard

- **My Collection:** flex layout fills remaining column height; card grid scrolls inside panel; `5rem` column width + right padding so fan overlap is not clipped
- **Deck fan:** hide scroll chevrons at scroll ends (no disabled ghost buttons); remove edge gradients; stronger chevron styling

### Upgrade from 1.2.6

1. **Install globally:** `npm i -g @agent-deck/cli@1.2.7`
2. **Restart backend:** `agent-deck start`
3. **Re-run setup:** `agent-deck setup --client claude`
4. **Re-bind once per session:** `bind_workspace` in agent chat

## 1.2.6 — 2026-07-02

### Dashboard

- **Deck fan:** fix right-edge clipping at 10 cards (viewport includes horizontal padding); clickable scroll chevrons; align Deck panel height with My Decks (`h-80`); remove spurious scrollbar on yellow drop zone
- **MCP tools panel:** resync disabled-tool state when tool list changes after reconnect (not only when count changes)

### Backend

- **Agent API:** redact OAuth tokens, client secrets, `Authorization` headers, and `localEnv` from deck service payloads returned to agent clients (`get_decks`, bound deck reads)
- **MCP client cache:** invalidate cached connection on tool discovery failure (same as tool-call failures)

### Docs

- **README:** end-user Quick Start only — dev clone/`dev:all` moved to [DEVELOPMENT.md](docs/DEVELOPMENT.md)
- **SETUP.md:** document Claude Code stale MCP tool index after reconnect (session restart workaround)

## 1.2.5 — 2026-07-01

### Deck display — terminal only

- **Removed Cursor IDE extension** — deck display is terminal `statusLine` only (Claude Code / Cursor CLI); IDE Agent chat has no host footer API
- **Harness session opener** — on first turn: `bind_workspace` → `get_session_binding` → show `display_summary` to user (Glass/IDE workaround)
- **Status line:** open-stdin host contract (no hang when Claude leaves pipe open); `readStdin` idle timeout; prod port `11111` before dev `8000` unless `AGENT_DECK_DEV`
- **`setup --scope project`** — `repo-deck-init` writes/repairs `.agent-deck/deck.yaml`

### Process & docs

- `.cursor/rules/user-surface-feasibility.mdc` — gate user-visible surfaces; no IDE display claims
- Release playbooks + smoke aligned to terminal-only scope
- [PUBLISHING.md](docs/PUBLISHING.md), [PRD_DECK_DISPLAY.md](docs/PRD_DECK_DISPLAY.md) — IDE extension removed from distribution story

## 1.2.4 — 2026-07-01

### Deck display & CLI

- **`setup` installs deck status line by default** for Claude Code / Cursor CLI (`--no-statusline` to skip); writes `~/.agent-deck/bin/statusline.sh` and merges `statusLine` into client settings
- **Status line:** prefer `workspace.project_dir`; walk up bindings sidecar; fall through when prod API is unbound but dev/prod sidecar has a bind; strip ANSI; `NO_COLOR` + stderr redirect in wrapper (no `npm warn` on stdout); **stdin host-contract tests** (Claude leaves pipe open)
- **Bindings sidecar:** backend merges prod + dev `bindings.json` for `GET /api/scope/display`
- **`npm run release:smoke`** — fresh-`HOME` setup + artifact checks; runs in `build:release` before publish

### Backend

- **MCP auth:** resolve `service.credentialId` from vault into outbound requests; stop stripping manual `Authorization` when OAuth is absent; merge custom headers before OAuth overrides
- **MCP errors:** clearer parsing for plain JSON auth failures (e.g. Docmost `401 Unauthorized`)

### Harness & docs

- Agent harness: connect MCP before `bind_workspace`
- Release playbooks + `.cursor/rules/release-integration-smoke.mdc`; generic playbook `pb_user_path_integration_smoke`

## 1.2.3 — 2026-07-01

### Deck display (Phase 5a) — on npm

- **Bindings sidecar** (`~/.agent-deck/bindings.json`) written on `bind_workspace` / `switch_bound_deck`
- **`GET /api/scope/display`** — resolved bound deck + `displayLine` for status surfaces
- **CLI** `agent-deck statusline` command (installer wiring completed in 1.2.4)
- **MCP** `get_session_binding.display_summary` and `agent-deck://bound-deck/summary` resource
- Shared `deck-display` schemas; `resolveAgentDeckHome` in `@agent-deck/shared`

### Backend fixes — on npm

- MCP client: stop setting global `Content-Type` on transport headers (fixes Streamable HTTP GET probes)
- Smarter SSE fallback — skip when Streamable HTTP returns actionable 4xx/5xx; prefer Streamable error over misleading SSE “Invalid content type”
- Streamable HTTP first, legacy SSE fallback only for ambiguous failures

### Docs — on npm

- [PUBLISHING.md](docs/PUBLISHING.md) — distribution model (CLI + terminal statusline)
- [PRD_DECK_DISPLAY.md](docs/PRD_DECK_DISPLAY.md) — Phase 5a shipped; IDE display out of scope

## 1.2.2 — 2026-07-01

### Backend

- `call_service_tool`: propagate MCP failures with `error_code` and `details.cause` instead of a flat `"Failed to call tool"`
- On tool-call failure, invalidate cached MCP client and mark service `unhealthy` so stale `healthy` snapshots do not linger
- MCP client: Streamable HTTP first with legacy SSE fallback; SSE fallback now forwards OAuth/custom headers

## 1.2.1 — 2026-06-30

### Dashboard

- Deck fan: extra vertical/side padding and softer edge gradients so tilted/hovered edge cards never clip
- MCP and deck cards share a resilient icon component (favicon fallback → agent silhouette when missing)

### Backend

- Service icons: re-resolve favicon when `iconUrl` exists but the cached file is missing; `/api/services/:id/icon` now retries before 404

## 1.2.0 — 2026-06-29

### Security & OAuth

- OAuth **client secrets** and **access/refresh tokens** stored in macOS Keychain (dev file fallback) — SQLite holds metadata only (`oauth_has_token`, expiry)
- Legacy plaintext tokens migrate automatically on first connect or MCP call; duplicate `Authorization` in `services.headers` stripped
- OAuth reconnect UX: prefill saved Client ID, hide secret field when stored, collapsed Slack first-time steps

### Dashboard

- Deck fan: bounded 10-card viewport, edge-hover scroll, position-based tilt, scroll chevrons, hover lift
- In-deck collection badge styling; deck playbook count fix; reduced service warning spam
- OAuth connect panel improvements

### CLI

- **Agent harness** installer (`agent-deck setup` writes Cursor rules / CLAUDE.md guidance) — see [AGENT_HARNESS.md](docs/AGENT_HARNESS.md)
- Dev vs production data: `npm run dev:all` uses `~/.agent-deck/dev/`; `agent-deck start` uses `~/.agent-deck/`

### Docs

- [SETUP.md](docs/SETUP.md) — secrets & OAuth storage, performance notes
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — secret storage section

## 1.1.7 — 2026-06-29

### Dashboard

- **Fix:** Remote MCP registration headers JSON field was not editable (parse-on-keystroke); now accepts free typing with validation on register
- Updated AgentDeckLogo3 header asset and regenerated `favicon.png` from the new logo

## 1.1.6 — 2026-06-28

### MCP & OAuth

- **Remove** seeded Gmail, Google Calendar, and Google Drive remote cards (BYO GCP too painful); [GOOGLE_DRIVE_WORKAROUND.md](docs/GOOGLE_DRIVE_WORKAROUND.md) documents local stdio path
- **Fix:** GitHub OAuth token exchange (form-urlencoded response from GitHub)
- **Fix:** Fail fast on actionable Streamable HTTP MCP errors instead of masking with SSE 401 fallback (Slack MCP enablement)
- Session-scoped deck binding: `bind_workspace`, `switch_bound_deck`, `get_session_binding` + `x-agent-deck-deck-id` header
- Richer OAuth provider setup guides in connect panel; GitHub guide clarifies Copilot subscription not required for general MCP
- MCP card icon backfill on list/startup for seeded services
- Local MCP import accepts unwrapped server maps, bare `{ command, args }`, and markdown-fenced JSON

### Dashboard

- AgentDeckLogo3 header logo and favicon
- Local MCP setup hints on service details (Google Drive auth is out-of-band, not Agent Deck OAuth)

### CLI

- Published default ports **11111** (API/dashboard) and **11112** (MCP); dev repo stays 8000/3001
- Shared `defaults.ts` for port resolution

### Docs

- MVP, SETUP, PUBLISHING, MCP integration strategy aligned with session bind and Google local path

## 1.1.5 — 2026-06-28

### OAuth & MCP

- **Fix:** Tokens without `expires_at` (Linear, Notion, Slack) no longer show as expired or unauthenticated
- **Fix:** Collection warnings treat a stored OAuth token as sufficient (no `Authorization` header required on the service row)
- **Fix:** Service details modal no longer keeps stale OAuth state from a previously opened service
- OAuth connect panel with provider-specific setup guides (Slack manifest copy, managed vs BYO)
- Managed Slack mode when `AGENT_DECK_SLACK_CLIENT_ID` + `AGENT_DECK_SLACK_CLIENT_SECRET` are set
- Configurable OAuth redirect via `AGENT_DECK_OAUTH_REDIRECT_URI` or `AGENT_DECK_PUBLIC_URL`
- MCP OAuth discovery helpers and connect service refactor

### CLI

- `agent-deck stop` / `agent-deck status` — manage local daemon
- Node **24** recommended; **20+** supported (`node-runtime` checks, clearer doctor messaging)
- Removed `scripts/use-node20.sh`; dev scripts use Node on PATH

### Docs

- [OAUTH_REQUIREMENTS.md](docs/OAUTH_REQUIREMENTS.md) — product OAuth needs, vendor tiers, Slack marketplace, Stytch feasibility
- [OAUTH_AND_HOSTING.md](docs/OAUTH_AND_HOSTING.md) — local vs hosted, HTTPS, Slack paths
- [SLACK_OAUTH_APP.md](docs/SLACK_OAUTH_APP.md) — shared Slack app registration
- [MCP_INTEGRATION_STRATEGY.md](docs/MCP_INTEGRATION_STRATEGY.md) — connection tiers and deferred work
- [SETUP.md](docs/SETUP.md) — Node 24 default policy rewrite
- Slack MCP manifest example: [docs/examples/slack-mcp.manifest.json](docs/examples/slack-mcp.manifest.json)

### Tests

- OAuth session expiry, oauth-manager, oauth-redirect, shared-oauth-apps, provider guides
- MCP Streamable HTTP, PKCE, paths, CLI ports/MCP config
- `rebuild-native.mjs` runs before tests and on `postinstall` so `better-sqlite3` matches active Node

## 1.1.4 — 2026-06-28

### Backend

- **Fix:** SQLite migration for legacy `services` tables missing `is_connected` (indexes now run after migrations)
- **Fix:** Always use `~/.agent-deck/agent_deck.db` — ignore stray `./agent_deck.db` in cwd unless `AGENT_DECK_DB_PATH` is set
- **Fix:** MCP Streamable HTTP for Claude Code — per-client sessions plus GET/DELETE on `/mcp` (1.1.3 used one global session; Claude showed Failed to connect)
- Log database path on backend startup

### CLI

- **Fix:** MCP failure no longer kills the API backend on partial start; reuse existing MCP when port is busy
- `agent-deck debug-mcp` — one-shot MCP connectivity diagnostics

### Tests

- MCP Streamable HTTP integration tests (multi-session initialize, GET `/mcp` SSE)
- DB legacy migration + index tests; CLI MCP config URL tests
- `pre-publish-check` gates `npm publish` and `build:release` — publish aborts if tests fail

## 1.1.3 — 2026-06-28

### CLI

- Fail fast on Node ≠ 20 and on `better-sqlite3` ABI mismatch (stale `~/.npm/_npx` cache)
- Fix `npx` from monorepo cwd resolving workspace backend instead of installed package
- `engines`: Node `>=20 <21`

## 1.1.2 — 2026-06-28

### CLI

- **Fix:** `npx @agent-deck/cli start` — bin shim resolved wrong path (`node_modules/dist` instead of `@agent-deck/cli/dist`); server never started
- Upgrade `better-sqlite3` 9 → 12 (Node 20–24 prebuilds; no API changes in Agent Deck)
- `agent-deck stop` / `agent-deck status` — manage the local daemon
- `agent-deck start --force` — restart if already running
- Detect port conflicts with clear errors; reuse existing instance instead of double-starting
- Claude setup fallback writes `~/.claude.json` (not `settings.json`)
- Dashboard URL docs: npm uses **:8000**; OAuth redirect follows bundled UI (not hardcoded :3000)

## 1.1.1 — 2026-06-28

### CLI

- `agent-deck setup --client cursor|claude|claude-desktop` — write MCP client config (merge-safe)
- `agent-deck upgrade` / `--check` — npm version check and global reinstall
- Update notification on `start` (24h cache); `AGENT_DECK_AUTO_UPGRADE=1` for silent upgrade

## 1.1.0 — 2026-06-27

### Distribution

- Publishable npm packages: `@agent-deck/cli`, `@agent-deck/backend`, `@agent-deck/shared`
- CLI npm name is `@agent-deck/cli` (bin remains `agent-deck`; unscoped `agent-deck` was rejected by npm as too similar to `agentdeck`)
- `agent-deck start` — single command for backend, dashboard UI, and MCP server
- `agent-deck doctor` and `agent-deck --version`
- MCP Registry metadata in `server.json`
- Release scripts: `npm run build:release`, `npm run version:sync`, `npm run publish:packages`

### Agent & dashboard (from prior work on main)

- Agent MCP tools for collection CRUD and bound-deck linking
- Dashboard: MCP tool toggles, credential details, health status, collection warnings

## 1.0.0

- MVP Modules 1–3: vault, playbooks, repo deck binding, collection warnings
