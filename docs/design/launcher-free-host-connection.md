# Launcher-free host connection (pure MCP over HTTP)

NOT-561 investigation. Base: `ad537fb` (local `main`, 2026-11-11; `origin/main`
could not be fetched — no network in this session).

## Problem

2026-11-10, Agent Deck 2.4.0: plugin enabled, daemon healthy,
`agent-deck doctor` printed `Codex plugin: OK (2.4.0, mcp-launch)`, yet Codex
logged `MCP server startup failed server_name="agent-deck" error=No such file
or directory (os error 2)` and exposed no Agent Deck tools.

Root cause: the shared repo-root `.mcp.json` (referenced by `.codex-plugin`,
`.claude-plugin` and `.cursor-plugin` via `"mcpServers": "./.mcp.json"`) runs
the bare command `agent-deck mcp-launch`. Desktop-launched hosts have
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, which lacks `~/.local/bin`, so the
executable lookup fails. A shell wrapper that patches PATH was rejected
(open PR #211 and its Dealer issue; do not build on them): the connection
must not depend on finding a CLI at all. Product principle: agents use MCP
only; the connection should be plain MCP.

## What the launcher does today

`packages/cli/src/mcp-launcher.ts` + `packages/cli/src/mcp-bridge.ts`:

- Reads the folder assignment (`.agent-deck/use.json`, via
  `packages/cli/src/assignment.ts`).
- Bridges host stdio to streamable HTTP `http://127.0.0.1:1110/mcp`
  (`buildMcpUrl`, `packages/cli/src/mcp-config.ts`).
- Sends `x-agent-deck-workspace: <folder>` on every request, plus
  `x-agent-deck-deck-id: <deck>` when the folder is assigned
  (`resolveMcpLaunchPlan`, mcp-launcher.ts:73-121).
- Caches the client `initialize` and replays it when the server answers an
  unknown `Mcp-Session-Id` with 404 (restart recovery, NOT-101).

The server (`packages/backend/src/mcp-server.ts`) authenticates the deck
header per request via `/api/trusted-session/mcp/connect-deck`; without it
the session is `unassigned` (NOT-50), never 401.

## Findings

### 1. Codex supports static custom headers — global and per-folder

**Answer: yes, both.** Verified against `codex-cli 0.157.1` on macOS.

Exact config key: `mcp_servers."<name>".http_headers` — a TOML inline table
mapping header name to static value. A second key,
`mcp_servers."<name>".env_http_headers`, maps header name to an environment
variable name whose value is sent. (`codex mcp get` also lists a third,
`http_headers_helper`, unset in all probes; syntax not verified.)

Global entry (`~/.codex/config.toml`) — a pre-existing
`[mcp_servers.existing-entry]` entry on the probe machine (server name
redacted) already proves the key parses:

```toml
[mcp_servers.existing-entry]
url = "http://127.0.0.1:3332/mcp"
http_headers = { "Authorization" = "Bearer [REDACTED]" }
```

`codex mcp get existing-entry` renders it (values redacted, proving the
map is read as headers):

```
existing-entry
  enabled: true
  transport: streamable_http
  url: http://127.0.0.1:3332/mcp
  bearer_token_env_var: -
  http_headers: Authorization=*****
  env_http_headers: -
  http_headers_helper: -
```

Per-folder entry (`<folder>/.codex/config.toml`) — verified with an
isolated `CODEX_HOME` so no user config was touched:

`<folder>/.codex/config.toml`:

```toml
[mcp_servers.probe-deck]
url = "http://127.0.0.1:1110/mcp"
http_headers = { "x-agent-deck-workspace" = "/tmp/codex-proj-probe" }
```

Trust seed in the isolated home (`$CODEX_HOME/config.toml` — the path must
be canonical; `/tmp/...` does not match, `/private/tmp/...` does):

```toml
[projects."/private/tmp/codex-proj-probe"]
trust_level = "trusted"
```

Result from the folder (`CODEX_HOME=/tmp/codex-home-probe2`):

```
$ codex mcp get probe-deck
probe-deck
  enabled: true
  transport: streamable_http
  url: http://127.0.0.1:1110/mcp
  bearer_token_env_var: -
  http_headers: x-agent-deck-workspace=*****
  env_http_headers: -
  http_headers_helper: -
```

and `codex doctor` from the folder reports `MCP servers 1` (vs `0` with a
non-canonical trust path or no trust entry). The project layer merges into
both management commands and sessions; the binary documents it as
"Project `.codex/config.toml`: settings for a trusted repository,
including sandbox, MCP, hooks, model, and reasoning defaults." No git repo
is required (verified after removing `.git`).

`env_http_headers` syntax verified the same way:

```toml
[mcp_servers.probe-deck]
url = "http://127.0.0.1:1110/mcp"
http_headers = { "x-agent-deck-workspace" = "/tmp/codex-probe" }
env_http_headers = { "x-agent-deck-deck-id" = "AGENT_DECK_DECK_ID" }
```

```
  http_headers: x-agent-deck-workspace=*****
  env_http_headers: x-agent-deck-deck-id=AGENT_DECK_DECK_ID
```

Caveats:

- `codex mcp add --url` exposes only `--bearer-token-env-var` (plus OAuth
  flags); there is no `--header` or `--scope` flag. `agent-deck use` must
  edit the TOML files directly.
- Per-folder config applies only to trusted folders. Trust is normally
  granted interactively on first open; the `[projects."<path>"]`
  `trust_level = "trusted"` row uses the canonical path.
- A same-named server in the project layer overrides the user layer
  ("Overridden by project config" in the binary), which is what makes a
  per-folder `agent-deck` entry shadow a global fallback entry.

**Working example for `agent-deck use <deck>` to write** (deck id resolved
server-side per §5 — no deck id in the file):

```toml
[mcp_servers.agent-deck]
url = "http://127.0.0.1:1110/mcp"
http_headers = { "x-agent-deck-workspace" = "<absolute folder>" }
```

Live header-transmission evidence (Codex `0.157.1`, config supplied
through `-c` overrides to avoid touching user config): the recording stub
received `x-agent-deck-workspace: <folder>` on **every** request,
including `initialize`, `notifications/initialized`, `tools/list` and
`tools/call`. The per-folder file form is covered by the `codex mcp get`
check above; the live run proves that the `http_headers` value reaches the
server. Condensed log is in §3; raw stub JSON lines are in Appendix A.1.
Note for `agent-deck use`:
Codex MCP calls need approval in non-interactive mode; the live run used
`default_tools_approval_mode = "approve"` on the probe server only.

### 2. Claude Code supports the same per-folder static header entry

**Answer: yes.** Verified against Claude Code `2.1.322` on macOS.

`claude mcp add --scope project --transport http <name> <url> --header`:

```
$ mkdir -p /tmp/claude-mcp-probe/proj && cd /tmp/claude-mcp-probe/proj
$ claude mcp add --scope project --transport http probe-deck \
    http://127.0.0.1:1110/mcp \
    --header "x-agent-deck-workspace: /tmp/claude-mcp-probe/proj"
Added HTTP MCP server probe-deck with URL: http://127.0.0.1:1110/mcp to project config
Headers: {
  "x-agent-deck-workspace": "/tmp/claude-mcp-probe/proj"
}
File modified: /private/tmp/claude-mcp-probe/proj/.mcp.json
```

Resulting `<folder>/.mcp.json`:

```json
{
  "mcpServers": {
    "probe-deck": {
      "type": "http",
      "url": "http://127.0.0.1:1110/mcp",
      "headers": {
        "x-agent-deck-workspace": "/tmp/claude-mcp-probe/proj"
      }
    }
  }
}
```

`claude mcp get probe-deck` confirms scope and headers:

```
probe-deck:
  Scope: Project config (shared via .mcp.json)
  Status: ⏸ Pending approval (run `claude` to approve)
  Type: http
  URL: http://127.0.0.1:1110/mcp
  Headers:
    x-agent-deck-workspace: /tmp/claude-mcp-probe/proj
```

Scoping: `--scope project` writes `<folder>/.mcp.json` (shared/tracked);
`local` (default) and `user` are machine-local. The `user` target path is
confirmed as `~/.claude.json` by the CLI itself — a `--scope user` write
attempted here failed only on a sandbox file lock with: `MCP server
"probe-user" was not saved to ~/.claude.json` (home path redacted). The
flag contract comes from `claude mcp add --help`.

Caveats:

- Project entries start as **Pending approval** and need one approval in
  `claude` before they connect — `agent-deck use` output must say so.
- `.mcp.json` project scope is explicitly "shared via .mcp.json", i.e.
  expected to be committed. Anything user-local (deck UUIDs) must stay out
  of it — same constraint as Codex, same answer (§5).

Live header-transmission evidence (Claude Code `2.1.322`): with the
project `.mcp.json` above (approval granted by the setting
`enableAllProjectMcpServers`), the recording stub received
`x-agent-deck-workspace: <folder>` on **every** request, including
`initialize`, `notifications/initialized`, `tools/list` and `tools/call`.
Raw stub JSON lines are in Appendix A.2.

### 3. Do the native HTTP clients re-initialize after a 404?

**Answer: yes, both hosts.** Verified live with the Appendix A stub, which
forgets all sessions after the first `tools/call` (simulated daemon
restart). Both hosts then received 404 on their next call, started a new
session with a fresh `initialize` carrying no session id, and the retried
call succeeded, so the second `ping` returned `pong` in both runs.

Codex `0.157.1` (log condensed; the user-agent header is removed):

```
POST initialize                 hdr x-agent-deck-workspace=<folder>            -> 200 new session d68d...
POST notifications/initialized  hdr x-agent-deck-workspace, session d68d...    -> 202
POST tools/list                 hdr x-agent-deck-workspace, session d68d...    -> 200
POST tools/call                 hdr x-agent-deck-workspace, session d68d...    -> 200   (pong)
-- SIMULATED_RESTART: all sessions forgotten --
POST tools/call                 hdr x-agent-deck-workspace, session d68d...    -> 404
POST initialize                 hdr x-agent-deck-workspace, no session id      -> 200 new session 29d6...
POST notifications/initialized  hdr x-agent-deck-workspace, session 29d6...    -> 202
POST tools/call                 hdr x-agent-deck-workspace, session 29d6...    -> 200   (pong)
```

Claude Code `2.1.322` behaved the same way: after the 404 it sent
`initialize` without a session id, got a new session, and its retried
`tools/call` returned 200 (`pong`). Claude Code differs in three ways:

- It sends a `server/discover` POST with no session before the first
  `initialize`. The stub answered 404 and Claude fell back to `initialize`.
  The real server must tolerate this probe without breaking connection
  setup. T2 adds an acceptance criterion for it.
- After the 404 it opened two `initialize` sessions in parallel and used
  one of them. The server must tolerate the extra session.
- It sent `x-agent-deck-workspace` on every request, including `server/discover`.

Raw Claude stub JSON lines (404 followed by new `initialize`): see
Appendix A.2. The Codex raw lines are in Appendix A.1.

Server side (verified in code and tests): an unknown `Mcp-Session-Id`
answers HTTP 404, header `mcp-session-status: expired`, JSON-RPC error
`-32001` with a re-initialize message (`sendSessionExpired`,
packages/backend/src/mcp-server.ts:1484-1489; covered by
`mcp-server.http.test.ts:276-293`, including the GET/SSE leg). An
`initialize` carrying a stale id is accepted and issued a fresh session
(mcp-server.ts:1986-1988).

MCP specification, revision 2025-06-18, Transports, Streamable HTTP,
Session Management
(`https://modelcontextprotocol.io/specification/2025-06-18/basic/transports`),
rules 3 and 4, quoted verbatim:

> 3. The server **MAY** terminate the session at any time, after which it **MUST** respond to requests containing that session ID with HTTP 404 Not Found.
>
> 4. When a client receives HTTP 404 in response to a request containing an `Mcp-Session-Id`, it **MUST** start a new session by sending a new `InitializeRequest` without a session ID attached.

The fetched page shows no revision date beyond the `2025-06-18` in its URL.

Design consequence: neither host needs the bridge for daemon-restart
recovery. The `StreamableHTTPClientTransport` in the TypeScript SDK throws
on 404 (its README points at the spec), but Claude Code's own host code
recovers, as the live run shows.

### 4. Unassigned folders

Pure-MCP global fallback for folders with no assignment.

Design: one **global** HTTP entry, no headers — it connects everywhere and
always lands in the existing unassigned session (NOT-50), which is already
launcher-independent:

- Codex (`~/.codex/config.toml`):

  ```toml
  [mcp_servers.agent-deck]
  url = "http://127.0.0.1:1110/mcp"
  ```

- Claude (`~/.claude.json`, user scope, or documented manual equivalent):

  ```json
  { "mcpServers": { "agent-deck": {
    "type": "http", "url": "http://127.0.0.1:1110/mcp" } } }
  ```

  (Cursor equivalent, out of scope to implement:
  `~/.cursor/mcp.json` `{"mcpServers": {"agent-deck": {"url":
  "http://127.0.0.1:1110/mcp"}}}` — same `url`-entry shape Cursor already
  parses; the host's real `~/.cursor/mcp.json` shows an HTTP entry with
  `url` + `headers` for an existing server (name redacted), proving
  static headers work there too. Project equivalent:
  `<folder>/.cursor/mcp.json`, cf.
  `resolveConfigPath('cursor', 'project')` in
  `packages/cli/src/mcp-config.ts`. No header support probe was run for
  Cursor.)

Per-folder entries written by `agent-deck use` (§1/§2) use the **same
server name** (`agent-deck`), so they shadow the global entry where an
assignment exists (Codex: project layer overrides user layer for the same
server, per the binary; Claude: project `.mcp.json` merges over user
scope — same-name precedence per host is confirmed in T3).

What the server returns (no server change needed for the fallback itself —
`handleInitialize` → `markUnassigned`, mcp-server.ts:2014-2047):

Concrete request/response example. Initialize without any
`x-agent-deck-*` headers:

```
POST /mcp
Accept: application/json, text/event-stream
Content-Type: application/json

{"jsonrpc":"2.0","id":0,"method":"initialize","params":{
  "protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}
```

```
HTTP/1.1 200 OK
mcp-session-id: <uuid>
Content-Type: application/json

{"jsonrpc":"2.0","id":0,"result":{
  "protocolVersion":"2025-03-26",
  "capabilities":{"tools":{}},
  "serverInfo":{"name":"agent-deck-server","version":"2.4.0"},
  "instructions":"No deck assigned to this folder. Run `agent-deck use <deck>` in the project folder, then reload MCP."}}
```

(`instructions` = `UNASSIGNED_DECK_MESSAGE`,
packages/backend/src/mcp-unassigned.ts:6-7, wired as initialize
instructions at mcp-server.ts:441-444.)

First-turn receipt: `tools/list` advertises only `get_session_binding`
and `get_session_context`, and both answer the same explain-only error
(`registerUnassignedTools`, packages/backend/src/mcp-tools/register.ts:169-193):

```json
{"jsonrpc":"2.0","id":1,"result":{
  "content":[{"type":"text","text":"{\n  \"deck\": null,\n  \"error_code\": \"GRANT_REQUIRED\",\n  \"message\": \"No deck assigned to this folder. Run `agent-deck use <deck>` in the project folder, then reload MCP.\"\n}"}],
  "isError":true}}
```

No resources are registered for unassigned sessions. The session stays
explain-only for life: a late deck header cannot promote it
(`requireFollowUpDeckHeader`, mcp-server.ts:1816-1820) — after
`agent-deck use`, the host must reload MCP.

Limitations:

- The global entry carries no folder identity, so the server cannot tell
  folders apart and cannot offer a folder-specific remedy beyond the
  static message. No `bind_workspace` self-service is available on
  unassigned sessions (only the two explain-only tools) — assignment
  stays a human CLI action, which matches the current trust model.
- After `agent-deck use` writes the per-folder entry, the host must
  reload MCP (and, first time per folder, approve the project entry /
  trust the folder — see §1/§2 caveats).
- Daemon-not-running reads differently per host (connection refused at
  the HTTP entry). `doctor` honesty (§6, child ticket) should cover
  "entry present but daemon down" distinctly from "no entry".

### 5. The deck-binding gap (headline finding)

The candidate design as stated — per-folder entry with `url` plus
`x-agent-deck-workspace` only — is **insufficient as specified**, because
the ticket's premise "the server resolves … the deck from the folder
assignment" does not hold in code:

- Deck binding comes **only** from the `x-agent-deck-deck-id` request
  header (launch path, `authenticateLaunchDeck`, mcp-server.ts:1711-1790,
  re-validated per request), a Bearer grant (NOT-318), or a
  `bind_workspace` session override on an already-assigned session.
- In the MCP path the backend reads `.agent-deck/use.json` only for
  **display** (`readUseManifest` for the workspace-default line,
  mcp-tools/register.ts:336-338) — never for MCP auth or binding.
  (Precedent for option (b): the run API already binds runs from the
  same file, `resolveDeckBinding` in
  packages/backend/src/agent-run-api/host.ts:27-29.)
- A session initializing with workspace header but no deck header is
  `markUnassigned` (mcp-server.ts:2041-2047): 2 explain-only tools, no
  self-bind. So workspace-header-only entries would connect every folder
  as unassigned — the fallback of §4, not the assigned connection.

Two ways to close the gap:

- (a) `agent-deck use` writes the deck id into the per-folder entry
  (`x-agent-deck-deck-id` header alongside the workspace header). Works
  with zero server change, but puts user-local deck UUIDs into
  typically-tracked files (Claude project `.mcp.json` is explicitly
  "shared via .mcp.json"), undoing the launcher design's "no deck id in
  tracked config" property (`buildAgentDeckEntry` comment,
  mcp-config.ts:66-69). Deck names instead of UUIDs are portable but go
  stale on rename and can collide.
- (b) The server resolves workspace → deck from the folder assignment at
  `initialize` when the deck header is absent but the workspace header is
  present (same file the launcher reads today, same loopback trust), then
  binds exactly as a launch session. No deck id in any host config;
  identical for Codex and Claude; the trust boundary does not move (the
  file is already the assignment authority — the reader just moves from
  the launcher process into the daemon).

**Recommendation: (b).** It keeps host config to URL + workspace header
(the ticket's candidate), preserves "no deck id in tracked files", and
concentrates the change in one place both hosts share. The per-request
re-validation the launch path enjoys should be preserved (re-read the
tiny local file per request, or cache per session with a defined
invalidation — the child ticket decides, with a perf note).

### 6. Doctor honesty (non-blocking)

`agent-deck doctor`'s `Codex plugin: OK (2.4.0, mcp-launch)` line
(`reportCodexPluginStatus`, packages/cli/src/codex-plugin.ts:637) reports
the installed plugin manifest (version + transport classifier), not a live
host connection — which is exactly why the 2026-11-10 outage read as OK.
Honest reporting (entry present? daemon reachable? session established?)
is a separate child ticket and explicitly **not a blocker** for the
launcher-free connection.

## Recommendation

1. Adopt pure MCP over HTTP for Codex and Claude with per-folder entries
   carrying `url` + `x-agent-deck-workspace` only, the global plugin
   keeping skills/guidance but no connection, and the §4 headerless
   global entry as the unassigned fallback.
2. Close the deck-binding gap server-side (§5, option b): resolve
   workspace → deck from `.agent-deck/use.json` at `initialize` when no
   deck header is present. This is the one load-bearing server change;
   everything else is config writing.
3. Launcher removal per host is supported by the live tests in §1-§3:
   both hosts transmit the configured headers and both re-initialize
   after a 404 (raw Claude lines pending operator paste, A.2), so no
   host needs to keep the bridge. Same-name project-over-global
   precedence is verified in T3.
4. `doctor` honesty ships separately and never blocks 1-3.

## Proposed tickets

Ordering: T1 is complete (this document). T2 and T3 run in parallel;
T4 after T2+T3; T5 after T4. T6 standalone, blocks nothing and is
blocked by nothing.

- **T1 — Live-test the pure-MCP connection for Codex and Claude.**
  Substantially complete in this document (§1-§3, Appendix A) except
  the operator paste of raw stub JSON lines (A.1 Codex, A.2 Claude;
  A.2 required for AC2/AC3). Only same-name project-over-global
  precedence remains after that; it is an acceptance criterion of
  T3. No longer blocks T2 or T3.
- **T2 — Server: resolve deck from folder assignment when the deck
  header is absent.** Scope: in `handleInitialize`, when
  `x-agent-deck-deck-id` is absent but `x-agent-deck-workspace` names a
  folder whose `.agent-deck/use.json` assigns a deck, bind as a launch
  session (same `connect-deck` path); absent/unreadable assignment →
  existing unassigned flow. Preserve per-request re-validation
  semantics; loopback trust unchanged. Tests:
  `mcp-server.http.test.ts`-level coverage for bind/no-assignment/
  corrupt-manifest, a session-less `server/discover` POST (sent by Claude
  Code before `initialize`), and two parallel `initialize` calls from one
  client; none may break connection setup. One-PR boundary: server +
  tests only, no CLI changes. Blocks: T4. Blocked by: nothing.
- **T3 — `agent-deck use`: write per-folder pure-MCP entries for Codex
  and Claude.** Scope: `use.ts`/`mcp-config.ts` write
  `<folder>/.codex/config.toml` (`[mcp_servers.agent-deck]` url +
  `http_headers`) and `<folder>/.mcp.json` (`type:http` url +
  `headers`) instead of launcher entries for those clients; keep
  writing `use.json` (now the server-read assignment); print the
  approve/trust + reload MCP next steps. Merge-preserving edits of
  existing files. Tests: `use.test.ts`/`mcp-config.test.ts` coverage.
  Also verify live, per host, that a same-name per-folder `agent-deck`
  entry shadows the global fallback entry, and for Codex that the
  per-folder `.codex/config.toml` file form transmits the header (repair
  round 1 proved transmission only via `-c` overrides; the file form is
  so far covered only by `codex mcp get`). One-PR boundary: CLI config
  writing only, no server change.
  Blocks: T4. Blocked by: nothing.
- **T4 — Global fallback entry + plugin decoupling.** Scope: setup
  guidance writes the headerless global HTTP entries (§4); plugin
  manifests drop the shared stdio `.mcp.json` connection (skills and
  guidance stay); docs updated (SETUP, CODEX_PLUGIN). Per-host rollout:
  both hosts re-initialize after a 404 (§3), so no host keeps the
  launcher entry for recovery reasons. One-PR boundary: plugin manifests +
  setup/doctor guidance text + docs, no behavior change to server or `use`.
  Boundary with T6: T4 only changes guidance text (including any doctor
  hint strings); live-connection detection in doctor is T6's scope.
  Blocks: nothing (rollout completes here). Blocked by: T2, T3.
- **T5 — Retire `mcp-launch`/bridge for migrated hosts.** Scope: remove
  the stdio launcher path for hosts fully on pure MCP (or demote to a
  documented escape hatch); delete the rejected wrapper work references.
  Explicitly after T4 has soaked. One-PR boundary: removal only.
  Blocked by: T4.
- **T6 — Honest doctor reporting for host connections (non-blocker).**
  Scope: `doctor` distinguishes "no entry", "entry present, daemon
  down", "entry present, daemon up, no live session" per host instead
  of reporting the plugin manifest as OK. One-PR boundary: doctor +
  tests only. Blocks: nothing. Blocked by: nothing.

## Appendix A — Live-test record (executed 2026-11-11)

Executed locally (loopback available) with `codex-cli 0.157.1` and Claude
Code `2.1.322`. Both used the recording stub below with
`--restart-after-first-call`, which forgets every session after the first
`tools/call` (a simulated daemon restart), so the next request carrying the
old `Mcp-Session-Id` gets 404 as in spec rule 3. The prompt asked each host
to call the stub's `ping` tool twice in sequence.

Stub: `python3 docs/design/launcher-free-host-connection/stub_mcp.py <port> <logfile> --restart-after-first-call`. It
answers `initialize` with a new `Mcp-Session-Id`, `tools/list`, and
`tools/call` (`pong`); it answers 404 plus `mcp-session-status: expired`
and JSON-RPC `-32001` for an unknown session id on any non-`initialize`
request, and logs method, selected headers and status per request. The
script is `docs/design/launcher-free-host-connection/stub_mcp.py`
(Python standard library only).

Commands:

```
# Claude (folder with .mcp.json from §2, headers incl. x-agent-deck-workspace)
cd <folder> && claude -p "<call ping twice, sequentially>" \
  --settings '{"enableAllProjectMcpServers":true}' --allowedTools "mcp__probe-deck__ping"

# Codex (config overrides, sandbox kept on; no user config or credential changed)
codex exec --skip-git-repo-check \
  -c 'mcp_servers.probe-deck.url="http://127.0.0.1:18111/mcp"' \
  -c 'mcp_servers.probe-deck.http_headers={"x-agent-deck-workspace"="<folder>"}' \
  -c 'mcp_servers.probe-deck.default_tools_approval_mode="approve"' \
  "<call ping twice, sequentially>"
```

### A.1 Codex raw stub log

Raw lines from the stub's logfile for the Codex run. Redactions: the
`user-agent` header is removed and the private folder prefix is replaced
with `<tmp>`. All other fields are unchanged.

```
{"http": "POST", "rpc": "initialize", "headers": {"x-agent-deck-workspace": "<tmp>/codex-run"}, "status": 200, "issued_session": "d68df5f9225c412492f4d73bb0fcf27a"}
{"http": "POST", "rpc": "notifications/initialized", "headers": {"x-agent-deck-workspace": "<tmp>/codex-run", "mcp-session-id": "d68df5f9225c412492f4d73bb0fcf27a"}, "status": 202}
{"http": "GET", "headers": {"x-agent-deck-workspace": "<tmp>/codex-run", "mcp-session-id": "d68df5f9225c412492f4d73bb0fcf27a"}, "status": 405}
{"http": "POST", "rpc": "tools/list", "headers": {"x-agent-deck-workspace": "<tmp>/codex-run", "mcp-session-id": "d68df5f9225c412492f4d73bb0fcf27a"}, "status": 200}
{"http": "POST", "rpc": "tools/call", "headers": {"x-agent-deck-workspace": "<tmp>/codex-run", "mcp-session-id": "d68df5f9225c412492f4d73bb0fcf27a"}, "status": 200}
{"event": "SIMULATED_RESTART: all sessions forgotten"}
{"http": "POST", "rpc": "tools/call", "headers": {"x-agent-deck-workspace": "<tmp>/codex-run", "mcp-session-id": "d68df5f9225c412492f4d73bb0fcf27a"}, "status": 404, "note": "unknown session id"}
{"http": "POST", "rpc": "initialize", "headers": {"x-agent-deck-workspace": "<tmp>/codex-run"}, "status": 200, "issued_session": "29d6c0c4de294ea4b225b5658ebb819f"}
{"http": "POST", "rpc": "notifications/initialized", "headers": {"x-agent-deck-workspace": "<tmp>/codex-run", "mcp-session-id": "29d6c0c4de294ea4b225b5658ebb819f"}, "status": 202}
{"http": "GET", "headers": {"x-agent-deck-workspace": "<tmp>/codex-run", "mcp-session-id": "29d6c0c4de294ea4b225b5658ebb819f"}, "status": 405}
{"http": "POST", "rpc": "tools/call", "headers": {"x-agent-deck-workspace": "<tmp>/codex-run", "mcp-session-id": "29d6c0c4de294ea4b225b5658ebb819f"}, "status": 200}
{"http": "DELETE", "status": 200}
{"http": "DELETE", "status": 200}
```

### A.2 Claude raw stub log

Raw lines from the stub's logfile for the Claude Code run, same
redaction rule. Every request carries `x-agent-deck-workspace`
(AC2). The `server/discover` probe, the 404 on the stale session, the new
`initialize` without a session id, and the parallel `initialize` pair
described in §3 are all visible (AC3).

```
{"http": "POST", "rpc": "server/discover", "headers": {"x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 404, "note": "unknown session id"}
{"http": "POST", "rpc": "initialize", "headers": {"x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 200, "issued_session": "165b41755ac24c7b99599f7eab672f68"}
{"http": "POST", "rpc": "notifications/initialized", "headers": {"mcp-session-id": "165b41755ac24c7b99599f7eab672f68", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 202}
{"http": "GET", "headers": {"mcp-session-id": "165b41755ac24c7b99599f7eab672f68", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 405}
{"http": "POST", "rpc": "tools/list", "headers": {"mcp-session-id": "165b41755ac24c7b99599f7eab672f68", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 200}
{"http": "POST", "rpc": "tools/call", "headers": {"mcp-session-id": "165b41755ac24c7b99599f7eab672f68", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 200}
{"event": "SIMULATED_RESTART: all sessions forgotten"}
{"http": "POST", "rpc": "tools/call", "headers": {"mcp-session-id": "165b41755ac24c7b99599f7eab672f68", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 404, "note": "unknown session id"}
{"http": "POST", "rpc": "server/discover", "headers": {"x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 404, "note": "unknown session id"}
{"http": "POST", "rpc": "server/discover", "headers": {"x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 404, "note": "unknown session id"}
{"http": "POST", "rpc": "initialize", "headers": {"x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 200, "issued_session": "ed49fa77140042a0ad44a62784860c19"}
{"http": "POST", "rpc": "initialize", "headers": {"x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 200, "issued_session": "4a11a0badb704db0af15c2da7ad9f452"}
{"http": "POST", "rpc": "notifications/initialized", "headers": {"mcp-session-id": "ed49fa77140042a0ad44a62784860c19", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 202}
{"http": "POST", "rpc": "notifications/initialized", "headers": {"mcp-session-id": "4a11a0badb704db0af15c2da7ad9f452", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 202}
{"http": "GET", "headers": {"mcp-session-id": "ed49fa77140042a0ad44a62784860c19", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 405}
{"http": "GET", "headers": {"mcp-session-id": "4a11a0badb704db0af15c2da7ad9f452", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 405}
{"http": "POST", "rpc": "tools/call", "headers": {"mcp-session-id": "4a11a0badb704db0af15c2da7ad9f452", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 200}
{"http": "POST", "rpc": "server/discover", "headers": {"x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 404, "note": "unknown session id"}
{"http": "POST", "rpc": "initialize", "headers": {"x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 200, "issued_session": "f33e3ba65984418183d05c25f1be80f4"}
{"http": "POST", "rpc": "notifications/initialized", "headers": {"mcp-session-id": "f33e3ba65984418183d05c25f1be80f4", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 202}
{"http": "GET", "headers": {"mcp-session-id": "f33e3ba65984418183d05c25f1be80f4", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 405}
{"http": "POST", "rpc": "tools/list", "headers": {"mcp-session-id": "f33e3ba65984418183d05c25f1be80f4", "x-agent-deck-workspace": "<tmp>/claude-proj"}, "status": 200}
```

Not executed here: same-name project-over-global precedence (A.4 of the
original protocol). It moves to T3 as an acceptance criterion.