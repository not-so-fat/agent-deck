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

Global entry (`~/.codex/config.toml`) — the pre-existing
`[mcp_servers.botmancers]` entry on the probe machine already proves the
key parses:

```toml
[mcp_servers.botmancers]
url = "http://127.0.0.1:3332/mcp"
http_headers = { "Authorization" = "Bearer [REDACTED]" }
```

`codex mcp get botmancers` renders it (values redacted, proving the map is
read as headers):

```
botmancers
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

Live header-transmission evidence (stub server recording the header) could
not be collected in this session: the sandbox forbids `listen()` (EPERM,
verified once). Repro protocol + stub script: see Appendix A.

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
"probe-user" was not saved to /Users/not_so_fat/.claude.json.` The flag
contract comes from `claude mcp add --help`.

Caveats:

- Project entries start as **Pending approval** and need one approval in
  `claude` before they connect — `agent-deck use` output must say so.
- `.mcp.json` project scope is explicitly "shared via .mcp.json", i.e.
  expected to be committed. Anything user-local (deck UUIDs) must stay out
  of it — same constraint as Codex, same answer (§5).

Live header-transmission evidence: pending for the same sandbox reason;
same Appendix A protocol (replace the Codex config step with the
`claude mcp add` command above and run `claude -p` or an interactive
session from the folder).

### 3. Do the native HTTP clients re-initialize after a 404?

**Short answer: unknown for both hosts — live test required (Appendix A).
What is established statically is on which side the responsibility sits.**

Server side (verified in code + tests): an unknown `Mcp-Session-Id`
answers the restart signal — HTTP 404, header
`mcp-session-status: expired`, JSON-RPC error `-32001` with a
"re-initialize" message (`sendSessionExpired`,
packages/backend/src/mcp-server.ts:1484-1489; covered by
`mcp-server.http.test.ts:276-293`, including the GET/SSE leg). An
`initialize` carrying a stale id is accepted and issued a fresh session
(mcp-server.ts:1986-1988). The code comment states the contract as spec
(mcp-server.ts:1442-1443):

> The streamable-HTTP spec says a server MUST reply 404 to an unknown
> `Mcp-Session-Id`, and that a client seeing 404 MUST re-initialize.

Client side, TypeScript SDK v1.29.0
(`node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js`,
the stack Claude Code builds on): **`StreamableHTTPClientTransport` does
not recover by itself.** The POST path handles 401/403 (auth), 202 and 405
(lines 314, 336, 370, 102); any other non-OK status — including 404 —
becomes `StreamableHTTPError(404, ...)` thrown to the host (line 364).
Session recovery is therefore entirely host code. Whether Claude Code 2.1.x
re-initializes on it could not be determined statically; one bundle string
("Session expiry is not retried automatically; callers can mcp_reconnect
and retry") shows at least one MCP path does not auto-retry, and `/mcp
reconnect` exists as the manual path — but that string may describe the
subprocess/agent path rather than the interactive HTTP client. Live test
decides.

Codex 0.157.1 embeds Rust `rmcp-3.2.0`
(`transport/streamable_http_client.rs`) plus its own
`rmcp-client/src/streamable_http_retry.rs` (source paths from binary
strings). Its 404 behavior could not be determined statically either —
`streamable_http_retry.rs` suggests retry logic exists, but retry is not
re-initialization. Live test decides.

MCP specification quote: **not retrieved — no network in this session.**
The SDK README points at `https://modelcontextprotocol.io/specification/draft`
(Streamable HTTP transport, Session Management). From memory (UNVERIFIED,
do not cite): the server MUST answer 404 to an unknown session id and the
client MUST start a new session with a fresh `initialize` without a
session id. The child ticket implementing the live test must paste the
exact spec paragraph into this document.

Design consequence: if either host does not re-initialize, the pure-MCP
design needs a per-host answer before the launcher can be removed for that
host — e.g. keep the bridge for that host, accept manual `/mcp reconnect`
after daemon restarts (documented limitation), or shorten the exposure
(e.g. daemon restarts only on explicit user action). Do not assume both
hosts recover.

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
  `url` + `headers` for `botmancers`, proving static headers work there
  too. Project equivalent: `<folder>/.cursor/mcp.json`, cf.
  `resolveConfigPath('cursor', 'project')` in
  `packages/cli/src/mcp-config.ts`. No header support probe was run for
  Cursor.)

Per-folder entries written by `agent-deck use` (§1/§2) use the **same
server name** (`agent-deck`), so they shadow the global entry where an
assignment exists (Codex: project layer overrides user layer for the same
server; Claude: project `.mcp.json` merges over user scope — precedence of
same-named servers must be confirmed in the live test).

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
- The backend reads `.agent-deck/use.json` only for **display**
  (`readUseManifest` for the workspace-default line,
  mcp-tools/register.ts:336-338) — never for auth or binding.
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
3. Gate launcher removal per host on the Appendix A live test: headers
   received, 404 → re-initialize (or a documented recovery story), and
   same-name project-over-global precedence. If a host fails
   re-initialization, that host keeps the bridge until it passes — the
   design degrades per host, not wholesale.
4. `doctor` honesty ships separately and never blocks 1-3.

## Proposed tickets

Ordering: T1 first (evidence gate); T2 and T3 in parallel after T1;
T4 after T2+T3; T5 after T4. T6 standalone, blocks nothing and is
blocked by nothing.

- **T1 — Live-test the pure-MCP connection for Codex and Claude.**
  Scope: run the Appendix A protocol with network sandbox enabled:
  stub-server header capture per host, mid-session stub restart →
  404 → re-initialize (or documented failure), same-name
  project-over-global precedence, and paste the MCP spec paragraph on
  404/re-initialize into §3. One-PR boundary: this document updated
  with the logs + spec quote, no product code. Blocks: T2, T3.
- **T2 — Server: resolve deck from folder assignment when the deck
  header is absent.** Scope: in `handleInitialize`, when
  `x-agent-deck-deck-id` is absent but `x-agent-deck-workspace` names a
  folder whose `.agent-deck/use.json` assigns a deck, bind as a launch
  session (same `connect-deck` path); absent/unreadable assignment →
  existing unassigned flow. Preserve per-request re-validation
  semantics; loopback trust unchanged. Tests:
  `mcp-server.http.test.ts`-level coverage for bind/no-assignment/
  corrupt-manifest. One-PR boundary: server + tests only, no CLI
  changes. Blocks: T4. Blocked by: T1.
- **T3 — `agent-deck use`: write per-folder pure-MCP entries for Codex
  and Claude.** Scope: `use.ts`/`mcp-config.ts` write
  `<folder>/.codex/config.toml` (`[mcp_servers.agent-deck]` url +
  `http_headers`) and `<folder>/.mcp.json` (`type:http` url +
  `headers`) instead of launcher entries for those clients; keep
  writing `use.json` (now the server-read assignment); print the
  approve/trust + reload MCP next steps. Merge-preserving edits of
  existing files. Tests: `use.test.ts`/`mcp-config.test.ts` coverage.
  One-PR boundary: CLI config writing only, no server change.
  Blocks: T4. Blocked by: T1.
- **T4 — Global fallback entry + plugin decoupling.** Scope: setup/doctor
  guidance writes the headerless global HTTP entries (§4); plugin
  manifests drop the shared stdio `.mcp.json` connection (skills and
  guidance stay); docs updated (SETUP, CODEX_PLUGIN). Per-host rollout:
  a host whose T1 re-init result failed keeps the launcher entry until
  its recovery story lands. One-PR boundary: plugin manifests +
  setup/doctor guidance + docs, no behavior change to server or `use`.
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

## Appendix A — Live-test protocol (pending: needs `listen()`)

Blocked in this session by the network sandbox (`listen()` → EPERM).
Run with `--sandbox-network enabled` or `--disable-sandbox`.

A.1 Recording stub server (`/tmp/stub-mcp.py`, stdlib only). Run:
`python3 /tmp/stub-mcp.py 1120` (port unused by the daemon):

```python
import json, sys, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SESSION = None  # reset by restarting the process mid-session (test A.3)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj, session=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if session:
            self.send_header("mcp-session-id", session)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        global SESSION
        length = int(self.headers.get("Content-Length", 0))
        msg = json.loads(self.rfile.read(length) or b"{}")
        print(f"HDR x-agent-deck-workspace={self.headers.get('x-agent-deck-workspace')!r} "
              f"mcp-session-id={self.headers.get('mcp-session-id')!r} method={msg.get('method')}",
              flush=True)
        if msg.get("method") == "initialize":
            SESSION = uuid.uuid4().hex
            print(f"NEW session {SESSION}", flush=True)
            self._send(200, {"jsonrpc": "2.0", "id": msg.get("id"),
                             "result": {"protocolVersion": "2025-03-26",
                                        "capabilities": {"tools": {}},
                                        "serverInfo": {"name": "stub", "version": "0"}}},
                       session=SESSION)
            return
        if self.headers.get("mcp-session-id") != SESSION:
            print(f"404 for {self.headers.get('mcp-session-id')!r} (ours: {SESSION})", flush=True)
            self._send(404, {"jsonrpc": "2.0", "id": msg.get("id"),
                             "error": {"code": -32001,
                                       "message": "Unknown session; client MUST re-initialize"}})
            return
        method = msg.get("method")
        if method == "tools/list":
            self._send(200, {"jsonrpc": "2.0", "id": msg.get("id"),
                             "result": {"tools": []}}, session=SESSION)
        elif method == "notifications/initialized" or msg.get("id") is None:
            self.send_response(202)
            self.end_headers()
        else:
            self._send(200, {"jsonrpc": "2.0", "id": msg.get("id"), "result": {}},
                       session=SESSION)

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
```

A.2 Header capture.

- Codex: `mkdir -p /tmp/codex-live/.codex`, write the §1 example with
  port `1120` and workspace `/tmp/codex-live`, trust the folder, then
  from `/tmp/codex-live` run `codex exec --sandbox read-only
  "list your MCP tools"` (or open the TUI). Expect stub lines showing
  `HDR x-agent-deck-workspace='/tmp/codex-live'`. Paste the stub log.
- Claude: `mkdir -p /tmp/claude-live && cd /tmp/claude-live`,
  `claude mcp add --scope project --transport http live-deck
  http://127.0.0.1:1120/mcp --header "x-agent-deck-workspace:
  /tmp/claude-live"`, approve, run `claude -p "list your MCP tools"`.
  Expect the same header line. Paste the stub log.

A.3 404 → re-initialize. With the host session connected, restart the
stub process (kills `SESSION`), then trigger another tool call from the
same host session. Expect stub lines: `404 for '<old>'` followed by a
fresh `initialize` + `NEW session`. Per host, paste the log and record
re-initialized yes/no. If no: record the host's actual behavior (error
surfacing? manual `/mcp reconnect` recovery?) verbatim.

A.4 Precedence. With the §4 global entry plus the per-folder entry under
the same name, confirm the folder session sends the workspace header
(global shadowed). Paste the stub line.

A.5 Spec quote. Fetch
`https://modelcontextprotocol.io/specification/draft` (Streamable HTTP
transport, Session Management) and paste the 404/re-initialize paragraph
into §3, replacing the UNVERIFIED note.
