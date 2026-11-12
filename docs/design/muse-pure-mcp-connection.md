# Muse pure-MCP connection (NOT-568 investigation)

Base: `4122410` (NOT-566, local `main`). Companion design:
`docs/design/launcher-free-host-connection.md` (NOT-561, Codex and Claude);
recording stub: `docs/design/launcher-free-host-connection/stub_mcp.py`.

## Background

Muse today connects to Agent Deck through a stdio launcher entry.
`buildAgentDeckEntry('muse', ...)` (`packages/cli/src/mcp-config.ts`) writes
`{command: agent-deck, args: [mcp-launch], env: {AGENT_DECK_MCP_PORT,
AGENT_DECK_HOST}}` into the user settings file
(`~/.config/muse/settings.json`, or `$XDG_CONFIG_HOME/muse/settings.json`,
`schema_version: 1`, key `mcpServers`). `agent-deck use --client muse` and
`agent-deck setup --client muse --scope project` write the same launcher
entry into the project file `<cwd>/.mcp.json` — the same path Claude Code
uses for its per-folder entry, so the two clients currently overwrite each
other's same-name `agent-deck` entry there. The launcher resolves the
workspace from the Muse session working directory at runtime.

The pure-MCP pattern is merged for Codex and Claude: NOT-562 (server binds
the deck from the `x-agent-deck-workspace` header via
`.agent-deck/use.json`), NOT-563 (per-folder entries), NOT-565 (global
headerless fallback, plugins ship no server), NOT-566 (launcher retired for
those hosts).

Pre-collected operator results with the stub and real Muse Code 1.4.14
(`muse exec`, one prompt headless): Muse supports HTTP MCP entries with a
`url` and `headers`; a
`-c 'mcpServers.<name>={"url":...,"headers":{"x-agent-deck-workspace":"${VAR}"}}'`
override in a trusted workspace delivered the header (value taken from the
environment variable) on `initialize`, `notifications/initialized` and
`tools/list`, and a `tools/call` returned `pong`; header values are treated
as secrets, so `-c` refuses a literal value and requires a whole-value
`${VAR}` reference; a project `<folder>/.mcp.json` with
`{type:http,url,headers}` in a trusted folder was NOT picked up (the stub
saw nothing and Muse reported no such tool); `muse exec --provider echo`
never starts MCP servers, so MCP tests need the real provider;
`muse init` only scaffolds `AGENTS.md`; the workspace must be trusted
(`~/.config/muse/trust.json`) for MCP to start.

## Method

Static probes in this session used Muse Code 1.4.15
(`muse-bin-1.4.15-R8339.1`), a scratch `XDG_CONFIG_HOME`, scratch git
repositories under `/tmp`, and a hand-written scratch `trust.json` whose
format was reverse-engineered from the CLI's own error messages (Appendix
A.3). The user's real `~/.config/muse/settings.json` and `trust.json` were
never read or written. `muse mcp list/get/add` need no provider and no
network, so config-layer questions (a), (b) and the static half of (c) are
answered with verified command transcripts. Live header transmission,
404 recovery and the unassigned-folder UX need the real provider plus
loopback plus (for (e)) the real daemon, which this sandbox cannot do
(no `listen()`, no credentials); Appendix B gives the exact operator
protocol with paste blocks for the raw stub lines.

## (a) Literal vs `${VAR}` header values in settings.json

User `settings.json` accepts **both** literal header values and `${VAR}`
references. There is no whole-value constraint in files:

```
$ muse mcp add probe-user --url http://127.0.0.1:1110/mcp \
    -H "x-agent-deck-workspace: /tmp/muse-probe-repo"
Added MCP server `probe-user` to user settings.
```

written file:

```json
{
  "mcpServers": {
    "probe-user": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:1110/mcp",
      "headers": {
        "x-agent-deck-workspace": "/tmp/muse-probe-repo"
      }
    }
  },
  "schema_version": 1
}
```

`muse mcp add-json` with `"${MY_WORKSPACE}"`, with `type: "http"`
(Claude's shape), with no `type` at all, and even with a token-looking
`Authorization: Bearer sk-probe-...` literal were all accepted into user
settings; `muse mcp get <name> --json` reports every shape back as
`type: "streamable-http"` with header values masked as `[REDACTED]`.
A literal path header was likewise accepted into a project `.mcp.json`
via `muse mcp add --project` (see (b)).

The strict rule lives only on the `-c/--config` override path (and
partly on `--project` writes):

```
$ muse exec --provider echo \
    -c 'mcpServers.probe-lit={"url":"http://127.0.0.1:1110/mcp",
        "headers":{"x-agent-deck-workspace":"/literal/path"}}' 'say hi'
muse: -c mcpServers.probe-lit: refusing run: secret leaves need exactly
one whole-value `${VAR}` naming a set variable (see `--help` for the
-c/--config shape)
```

The same refusal fires for a `${VAR}` naming an *unset* variable; with the
variable set, the run passes config validation. `muse mcp add --project`
refuses only secret-*looking* literals
(`Refusing to write a literal secret to the project file: use
--bearer-token-env-var VAR to forward it by name instead.`); a filesystem
path is not secret-looking and is written verbatim.

**Answer: `settings.json` accepts a literal header value; `${VAR}` is
also accepted. The whole-value-`${VAR}`-naming-a-set-variable rule is
`-c`-only (plus a secret-looking-literal refusal on `--project` writes).
Live delivery of a file-configured header (literal and `${VAR}`) is
operator probe B1.**

## (b) Per-workspace config layer for mcpServers

A per-workspace layer **exists**: project scope is a `.mcp.json` chain
read from the repository root down to the cwd, managed by
`muse mcp add/list/get/remove [--user|--project]`:

- `muse mcp add probe-proj --url ... -H "x-agent-deck-workspace: ..." --project`
  writes `<repository root>/.mcp.json` (refuses outside a repository) and
  warns when the folder is not trusted: `Warning: this folder is not
  trusted; the entry is saved but will not load until the folder is
  trusted.`
- `muse mcp list --project` shows entries from every `.mcp.json` from the
  repo root down to the cwd (verified: repo-root file plus a nested
  `sub/.mcp.json` both listed, with `source` naming each file).
- Same-name shadowing works in both directions: a project `agent-deck`
  entry shadows the user-settings entry, and a nearer file shadows a
  farther one (`muse mcp list` annotates the loser with
  `overridden_by=<winning file>`).
- `type: "http"` and typeless `{url, headers}` entries in project files
  parse and normalize to `streamable-http`, exactly as in user settings.
- `${VAR}` headers are accepted in project files.

Two gates decide whether a project file loads at all:

1. **Repository.** A hand-written, trusted `<folder>/.mcp.json` in a
   plain folder is NOT picked up (`muse mcp list --project` →
   `{"servers":[]}`); after `git init` in that same folder, with the same
   file and the same trust row, the entry appears. This explains the
   pre-collected NOT-picked-up finding. Only git was verified; other VCS
   layouts are unknown.
2. **Trust.** Without trust the entry is saved but invisible. The trust
   store format, recovered from the CLI's validation errors, is:

   ```json
   {"schema_version": 1,
    "projects": {"/private/tmp/muse-probe-repo": {"decision": "trusted"}}}
   ```

   (`decision` accepts only `trusted` or `untrusted`; paths are
   canonical — `/private/tmp/...`, not `/tmp/...`.) `muse exec` confirms
   it: `muse: workspace trust: trusted source=user-config`.

Consequence: the Muse project file is the same `<folder>/.mcp.json`
Claude Code uses, and Muse parses the exact entry shape
`agent-deck use --client claude` already writes (NOT-563). A trusted git
checkout with a Claude per-folder entry is one `mcp list` away from
showing that entry to Muse.

**Answer: yes — the `.mcp.json` chain from repository root to cwd
carries `mcpServers` per workspace, with same-name project-over-user
shadowing. It loads only inside a repository (git verified) and only for
trusted folders.**

## (c) Muse-set workspace environment variable for `${VAR}`

No environment variable set by Muse for the session workspace was found.
The 1.4.15 binary contains no `MUSE_WORKSPACE`, `MUSE_CWD` or
`MUSE_REPO`; the nearest names are `MUSE_PARENT_SESSION_PROJECT` (set on
spawned subagents, not sessions), `MUSE_PROJECTS_HOME` and
`MUSE_WORKSPACES_ROOT` (directory roots, not the current workspace).
`muse exec` announces `muse: workspace root: <cwd> (cwd default)` but
does not export that path under any discovered name.

What `${VAR}` resolves from is the invoking process environment, proven
on the `-c` path: an unset variable refuses the run, a set variable
passes validation. File-based `${VAR}` headers are expected to resolve
the same way at session start; since no Muse-set variable carries the
workspace, no `${VAR}` spelling can deliver per-workspace identity —
identity must come from the project file layer in (b).

Two mechanics were validated for the operator's empirical confirmation
(probe B4, Appendix B.4): a stdio env-dump MCP server answers
`initialize`/`tools/list` correctly standalone and logs its full spawn
environment, and an echo-provider run with that server installed
produced no dump file — confirming the pre-collected claim that
`--provider echo` never starts MCP servers (so B4 needs the real
provider).

**Answer: no Muse-set session-workspace variable exists (static search
of the 1.4.15 binary and CLI surface); `${VAR}` resolves from the
invoking process environment and therefore cannot carry per-workspace
identity. Operator probe B4 confirms empirically via the full spawn
environment dump.**

## (d) 404 re-initialize and per-request headers

Pre-collected evidence shows the configured header on `initialize`,
`notifications/initialized` and `tools/list`, and a `tools/call`
returning `pong` — but the header's presence on `tools/call` was not
explicitly recorded, and no restart/404 run was done. Static probing
adds nothing: the binary yielded no session-expiry handling strings
either way. The MCP specification (2025-06-18, Streamable HTTP, Session
Management, rules 3–4, quoted in the companion design §3) requires the
client to start a new session with a fresh `InitializeRequest` on HTTP
404, and both sibling hosts were observed doing exactly that — so a yes
is expected, but it is not yet observed for Muse.

Operator probe B2 (Appendix B.2) decides it: the recording stub with
`--restart-after-first-call`, a file-configured settings entry (literal
header), and a prompt that calls the stub's `ping` tool twice in
sequence. A yes looks like the Codex/Claude runs — `tools/call`,
`SIMULATED_RESTART`, `tools/call` → 404, fresh `initialize` with no
session id, retried `tools/call` → 200 — with `x-agent-deck-workspace`
on every line.

**Answer: not yet observed — operator probe B2 is the decision
procedure (expected yes per the spec). The recommendation does not
assume it: writing per-folder and fallback entries (C1/C2) is safe
either way; only launcher removal (C3) requires a yes.**

## (e) Headerless global entry in an unassigned folder

Muse accepts a headerless HTTP entry. `muse mcp add-json probe-bare
'{"url":"http://127.0.0.1:1110/mcp"}'` validates into user settings;
`muse mcp get` reports `type: streamable-http`, empty headers,
`enabled: true`, and the human list shows `auth=logged-out`. Nothing on
the Muse side distinguishes it from a headed entry except the missing
header names.

Server side needs no change: an `initialize` with neither
`x-agent-deck-deck-id` nor `x-agent-deck-workspace` follows the existing
unassigned flow (`handleInitialize` → `markUnassigned`,
`packages/backend/src/mcp-server.ts`; NOT-50; NOT-562 consults the
assignment only when a workspace header is present). The session gets
`instructions` =
`No deck assigned to this folder. Run \`agent-deck use <deck>\` in the
project folder, then reload MCP.` (`UNASSIGNED_DECK_MESSAGE`,
`packages/backend/src/mcp-unassigned.ts:6-7`) and only the two
explain-only tools, both answering the same `GRANT_REQUIRED` error
(`registerUnassignedTools`, `packages/backend/src/mcp-tools/register.ts`).
The session stays explain-only for life: after `agent-deck use` the
host must reload MCP.

One Muse-specific wrinkle: in a non-repository folder the project layer
never loads (b), so the headerless global entry is the *only* entry and
the static message's `agent-deck use` remedy cannot bind that folder
for Muse (it would write a `.mcp.json` Muse still ignores). The message
stays correct for repo checkouts; non-repo folders are a documented
limitation (see Recommendation).

**Answer: Muse accepts the headerless global entry and connects; the
server lands it in the existing explain-only unassigned session with no
server change. Operator probe B3 confirms the live UX against the real
daemon in an unassigned folder.**

## Recommendation

Adopt the same per-folder plus global-fallback pattern as Claude, with
no Muse-specific entry shape and no permanent launcher exception:

1. **Per-folder entry** (written by `agent-deck use --client muse`):
   the identical `<folder>/.mcp.json` `agent-deck` entry Claude uses
   today — `{type: http, url, headers: {x-agent-deck-workspace}}` — which
   Muse parses (b) and which shadows the global entry by same-name
   precedence. The server binds the deck from `.agent-deck/use.json`
   (NOT-562, already merged). This also ends the current shared-file
   collision where `use --client muse` (launcher entry) and
   `use --client claude` (HTTP entry) overwrite each other's
   `agent-deck` entry in the same file.
2. **Global fallback** (written by `agent-deck setup --client muse`):
   the headerless `{type: http, url}` entry in user `settings.json`
   (reusing `buildGlobalFallbackHttpEntry`), landing unassigned folders
   in the explain-only session (e). Same-name per-folder entries shadow
   it where an assignment exists.
3. **Documented gates**: the per-folder entry loads only inside a
   repository (git verified) and only in trusted folders; after
   `agent-deck use` the host must reload MCP (and first time per folder,
   trust it). Non-repository folders stay on the headerless fallback and
   read the unassigned message — the same tradeoff Codex accepts for
   untrusted folders — with `git init` as the one-step remedy.
4. **Retire the launcher for Muse** once probe B2 answers yes (d),
   following the NOT-566 precedent: no `agent-deck` executable lookup
   remains on the Muse path.

Rejected alternatives: server-side workspace resolution without any
header is impossible over plain HTTP (no folder signal reaches the
server); a `${VAR}`-carried workspace is impossible (no Muse-set
workspace variable, (c)); keeping a permanent launcher exception would
preserve the `PATH` fragility that motivated the whole pure-MCP program
plus the shared-file collision.

## Proposed child tickets

Ordering: C1 and C2 run in parallel; C3 after C1+C2 have soaked AND
probe B2 answers yes; C4 standalone, blocks nothing and is blocked by
nothing. No server change in any ticket (NOT-562 already binds
workspace → deck).

- **C1 — `agent-deck use`: write the per-folder pure-MCP entry for
  Muse.** Scope: `buildAgentDeckEntry('muse', ...)` returns the HTTP
  entry with the `x-agent-deck-workspace` header when `workspaceRoot` is
  given (the same object shape as the Claude branch); `use.ts` passes
  `parsed.workspaceRoot` for Muse instead of `undefined` and prints the
  trust + reload-MCP next steps. Merge-preserving edit of the shared
  `.mcp.json` (Claude entries and unrelated servers untouched); writing
  for Muse and Claude converges on one identical entry.
  Files: `packages/cli/src/mcp-config.ts`,
  `packages/cli/src/mcp-config.test.ts`, `packages/cli/src/use.ts`,
  `packages/cli/src/use.test.ts`.
  Acceptance criteria: [agent] `use --client muse` in a scratch folder
  writes `{type:http,url,headers}` with the resolved workspace and keeps
  a sibling Claude entry byte-identical; [agent] `use.test.ts` /
  `mcp-config.test.ts` cover the muse branch and the shared-file merge;
  [ci] `ci.yml` green on the PR head; [operator] live run shows the
  header delivered from the project entry in a trusted git repo (or
  cites Appendix B.1 of this note once filled).
- **C2 — `agent-deck setup`: headerless global fallback for Muse plus
  guidance.** Scope: `setup --client muse --scope global` writes the
  headerless HTTP entry via `buildGlobalFallbackHttpEntry` (keeping the
  `schema_version` merge); project scope keeps writing the per-folder
  HTTP entry (same as C1); next-steps text covers trust, reload MCP,
  and the repo requirement. Files: `packages/cli/src/setup.ts`,
  `packages/cli/src/setup.test.ts`, `packages/cli/src/mcp-config.ts`
  (only if a shared helper is needed).
  Acceptance criteria: [agent] global setup writes a headerless entry
  that `muse mcp get agent-deck` reports as `streamable-http` with empty
  headers; [agent] project setup writes the headed entry; [ci] `ci.yml`
  green; [operator] headerless global entry in an unassigned folder
  lands in the explain-only session (or cites Appendix B.3 once filled).
- **C3 — Retire `mcp-launch` for Muse.** Scope: remove the Muse stdio
  launcher branch; extend the legacy-upgrade rewrite to convert
  existing Muse launcher entries (user `settings.json` and the shared
  project `.mcp.json`, where a Muse-shaped entry today carries neither
  `type: stdio` nor the workspace pin — see the
  `isLegacyClaudeLaunchEntry` comment) to the HTTP shape; update
  setup/use/doctor texts and docs. Explicitly after C1+C2 have soaked
  and probe B2 answers yes. Files: `packages/cli/src/mcp-config.ts`,
  `packages/cli/src/use.ts`, `packages/cli/src/setup.ts`, upgrade
  helpers + their tests, docs mentioning the Muse launcher.
  Acceptance criteria: [agent] no `mcp-launch` reference remains on the
  Muse path and the upgrade converts a Muse launcher entry to the HTTP
  entry in both files; [agent] tests cover the conversion;
  [ci] `ci.yml` green; [operator] fresh `setup` + `use` in a trusted
  repo binds the deck end-to-end over pure MCP.
- **C4 — Honest doctor reporting for the Muse connection (non-blocker).**
  Scope: `doctor` distinguishes "no entry", "entry present, daemon
  down", "entry present, daemon up, no live session", and (Muse-only)
  "folder is not a repository" / "folder is not trusted" instead of
  reporting install state as OK. Files: doctor module(s) under
  `packages/cli/src/` + tests. Acceptance criteria: [agent] each state
  renders distinctly in a scratch-driven test; [ci] `ci.yml` green.

## Appendix A — Static probe record (agent, Muse Code 1.4.15)

All runs used `MUSE_NO_AUTO_UPDATE=1`, `XDG_CONFIG_HOME=/tmp/muse-probe-home`
(a scratch dir), and scratch folders `/tmp/muse-probe-repo` (git) and
`/tmp/muse-probe-plain`. Redactions: none needed (scratch-only paths).

### A.1 Entry shapes accepted into user settings

`muse mcp add-json` accepted each of these (each followed by
`Added MCP server ... to user settings.`), and `muse mcp get --json`
reported every one back as `type: "streamable-http"` with header values
`[REDACTED]`:

- `{"type":"streamable-http","url":"...","headers":{"x-agent-deck-workspace":"/tmp/..."}}`
  (also written by `muse mcp add -H "x-agent-deck-workspace: ..."`)
- `{"type":"streamable-http","url":"...","headers":{"x-agent-deck-workspace":"${MY_WORKSPACE}"}}`
- `{"type":"http","url":"...","headers":{"x-agent-deck-workspace":"/tmp/x"}}`
- `{"url":"...","headers":{"x-agent-deck-workspace":"/tmp/x"}}`
- `{"url":"...","headers":{"Authorization":"Bearer sk-probe-ABCDEF1234567890abcdef"}}`
  (fake token; accepted verbatim into user settings)
- `{"url":"..."}` (headerless; reported back with empty headers)

### A.2 `-c` secret rule

Literal and unset-`${VAR}` overrides refuse identically:

```
muse: -c mcpServers.probe-lit: refusing run: secret leaves need exactly
one whole-value `${VAR}` naming a set variable (see `--help` for the
-c/--config shape)
```

With the variable set (`MY_WS_UNSET_12345=/tmp/x muse exec --provider
echo -c '...${MY_WS_UNSET_12345}...' 'say hi'`), config validation
passes; the run then failed only on the sandbox session lock
(environmental, unrelated to config).

### A.3 Trust store format (error-message oracle)

```
{"trusted":[...]}  -> malformed trust store ...: missing field `schema_version` ...
[{"..."}]          -> malformed trust store ...: invalid type: string ..., expected u32 ...
{"projects":{...{"trusted":true}}} -> malformed trust store ...: missing field `decision` ...
{"schema_version":1,"projects":{P:{"decision":"trust"}}} -> unknown variant `trust`, expected `trusted` or `untrusted` ...
```

Working format (project entry immediately listed afterwards):

```json
{"schema_version": 1,
 "projects": {"/private/tmp/muse-probe-repo": {"decision": "trusted"}}}
```

### A.4 Project chain, precedence, and the repository gate

```
$ cd /tmp/muse-probe-repo/sub   # sub/.mcp.json + root .mcp.json present
$ muse mcp list --project --json | <names,sources>
[('probe-proj', '/private/tmp/muse-probe-repo/.mcp.json'),
 ('probe-sub', '/private/tmp/muse-probe-repo/sub/.mcp.json')]
```

Same-name user+project entries: `muse mcp get probe-user` returned the
project URL with `source: /private/tmp/muse-probe-repo/.mcp.json`; the
human list marks the loser (`source=user ... overridden_by=
/private/tmp/muse-probe-repo/.mcp.json`). Root-vs-sub same name: the
nearer file wins. Non-repo folder (trusted, hand-written `.mcp.json`):
`{"servers":[]}`; after `git init` in that folder:
`[('probe-plain', '/private/tmp/muse-probe-plain/.mcp.json')]`.

### A.5 Echo run (trust + workspace announcements, MCP untouched)

```
$ muse exec --provider echo 'say hi'   # scratch settings + trust
muse: workspace root: /private/tmp/muse-probe-repo/sub (cwd default)
muse: workspace trust: trusted source=user-config
echo: say hi
```

A stdio env-dump MCP server installed in the scratch user settings was
not spawned (no dump file), confirming `--provider echo` never starts
MCP servers. The dump script itself was validated standalone: it
answers `initialize`/`tools/list` and logs its spawn environment.

## Appendix B — Operator live-run protocol (real provider)

Run B1–B4 in order on a machine with loopback, real Muse credentials,
and this repo checked out. Each probe uses scratch folders plus a
temporary backup/restore of the real Muse settings and trust file; the
real files must be byte-identical afterwards (the `trap` below
guarantees it). Use a free loopback port per probe (shown as 18211+).

Setup (once):

```sh
export MUSE_NO_AUTO_UPDATE=1
TS=$(date +%s)
cp ~/.config/muse/settings.json /tmp/muse-settings.$TS.bak
cp ~/.config/muse/trust.json /tmp/muse-trust.$TS.bak
restore_muse() {
  cp /tmp/muse-settings.$TS.bak ~/.config/muse/settings.json
  cp /tmp/muse-trust.$TS.bak ~/.config/muse/trust.json
}
trap restore_muse EXIT
mkdir -p /tmp/muse-live && cd /tmp/muse-live && git init -q repo 2>/dev/null || true
```

Trust the scratch repo for this run only (merge, don't clobber, the
real trust file — or approve the trust prompt in a TUI session):

```sh
python3 -c "
import json
p = __import__('os').path.expanduser('~/.config/muse/trust.json')
d = json.load(open(p))
d.setdefault('projects', {})['/private/tmp/muse-live/repo'] = {'decision': 'trusted'}
json.dump(d, open(p, 'w'), indent=2)"
```

### B.1 Header delivery from a settings entry (literal + `${VAR}`)

Decides the live half of (a), and doubles as the project-entry
delivery check: run once with a user-settings entry, once with the
entry in `/tmp/muse-live/repo/.mcp.json` instead (same `live-b1` name
via `muse mcp add-json live-b1 ... --project` and `muse mcp remove live-b1 --project`, so the real `agent-deck`
entry is never touched).

```sh
cd /tmp/muse-live/repo
python3 <repo>/docs/design/launcher-free-host-connection/stub_mcp.py 18211 /tmp/muse-live/b1.log &
STUB=$!
muse mcp add-json live-b1 '{"type":"http","url":"http://127.0.0.1:18211/mcp","headers":{"x-agent-deck-workspace":"/tmp/muse-live/repo"}}'
muse exec 'Call the ping tool once, then report its exact reply.'
muse mcp remove live-b1 --user
kill $STUB
```

Repeat with `"${MUSE_LIVE_WS}"` (exported to `/tmp/muse-live/repo`) in
place of the literal, then repeat both from the project file instead of
user settings. PASS: the stub log shows `x-agent-deck-workspace` on
`initialize`, `notifications/initialized`, `tools/list` and
`tools/call`, and the reply is `pong`.

OPERATOR: paste raw `/tmp/muse-live/b1.log` lines here (redact only
`user-agent` and the private path prefix):

```
(pending operator run)
```

### B.2 404 re-initialize (decides (d))

```sh
cd /tmp/muse-live/repo
python3 <repo>/docs/design/launcher-free-host-connection/stub_mcp.py 18212 /tmp/muse-live/b2.log --restart-after-first-call &
STUB=$!
muse mcp add-json live-b2 '{"type":"http","url":"http://127.0.0.1:18212/mcp","headers":{"x-agent-deck-workspace":"/tmp/muse-live/repo"}}'
muse exec 'Call the ping tool twice in sequence, then report both exact replies.'
muse mcp remove live-b2 --user
kill $STUB
```

PASS: both replies are `pong`; the log shows `tools/call` →
`SIMULATED_RESTART` → `tools/call` → 404 → fresh `initialize` with no
session id → retried `tools/call` → 200, with the workspace header on
every request.

OPERATOR: paste raw `/tmp/muse-live/b2.log` lines here:

```
(pending operator run)
```

### B.3 Headerless global entry in an unassigned folder (decides (e))

Needs the real Agent Deck daemon on its default port; run it from the
trusted scratch repo, which has no `.agent-deck/use.json` (stays
unassigned), keeping the workspace-trust gate satisfied:

```sh
agent-deck start --daemon
muse mcp add-json live-b3 '{"type":"http","url":"http://127.0.0.1:1110/mcp"}'
cd /tmp/muse-live/repo && muse exec 'List your Agent Deck tools and report what get_session_binding says.'
muse mcp remove live-b3 --user
```

PASS: the run reports only the explain-only tools and the
`GRANT_REQUIRED` "No deck assigned to this folder" message; no error
response, no crash.

OPERATOR: paste the `muse exec` output and the daemon-side session line
here:

```
(pending operator run)
```

### B.4 Spawn-environment dump (confirms (c))

```sh
mkdir -p /tmp/muse-envdump && cat > /tmp/muse-envdump/dump.py <<'EOF'
#!/usr/bin/env python3
import json, os, sys
with open('/tmp/muse-envdump/spawns.log', 'a') as f:
    f.write(json.dumps({'argv': sys.argv, 'env': dict(os.environ)}) + '\n')
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid, method = msg.get('id'), msg.get('method')
    if method == 'initialize':
        resp = {'jsonrpc': '2.0', 'id': mid, 'result': {
            'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}},
            'serverInfo': {'name': 'envdump', 'version': '0'}}}
    elif method == 'tools/list':
        resp = {'jsonrpc': '2.0', 'id': mid, 'result': {'tools': []}}
    elif mid is None:
        continue
    else:
        resp = {'jsonrpc': '2.0', 'id': mid, 'result': {}}
    sys.stdout.write(json.dumps(resp) + '\n')
    sys.stdout.flush()
EOF
chmod +x /tmp/muse-envdump/dump.py
muse mcp add-json live-b4 '{"command":"/tmp/muse-envdump/dump.py","args":[],"env":{"PROBE_MARKER":"m1"}}'
cd /tmp/muse-live/repo && muse exec 'Say hi.'
muse mcp remove live-b4 --user
python3 -c "
import json
d = json.loads(open('/tmp/muse-envdump/spawns.log').read().splitlines()[-1])
e = d['env']
print('marker:', e.get('PROBE_MARKER'))
print('workspace-ish:', sorted(k for k in e if 'WORKSPACE' in k or 'MUSE_' in k or k in ('PWD',)))
print('MUSE_PARENT_SESSION_PROJECT:', e.get('MUSE_PARENT_SESSION_PROJECT'))"
```

PASS: the dump lists the full spawn environment; confirm no variable
carries the session workspace path (expected per (c)).

OPERATOR: paste the `workspace-ish` line (and any variable whose value
is the session workspace path) here:

```
(pending operator run)
```
