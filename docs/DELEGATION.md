# `agent-deck run` delegation reference (per-client)

## Agent-operated delegation is MCP; the host CLI is exceptional

There are two ways to start a run. They use the same Agent Run service on the
Agent Deck host.

| | Who | How | When |
|---|---|---|---|
| **Normal: agent-operated** | An agent in a bound Agent Deck MCP session, including a Dealer role worktree or any coding sandbox | MCP tools only: `get_session_context`, optional human-approved `switch_deck`, `start_run`, `get_run`, `cancel_run` ([MCP_RUN_TOOLS.md](./MCP_RUN_TOOLS.md)); protocol in the [`agent-deck-run` skill](../skills/agent-deck-run/SKILL.md) | Every delegation an agent performs |
| **Exceptional: host CLI** | A human operator (or a script) in a terminal on the Agent Deck host itself | `agent-deck run …` and the poll subcommands below | Installation checks, diagnostics, and recovery |

The caller's shell is not the Agent Deck host. A delegating agent never runs
the `agent-deck` CLI, writes a prompt file for it, calls the host's loopback
ports, inspects host processes, or installs a second Agent Deck copy as a
fallback. If MCP, the launch workspace, or the provider is unavailable, it
reports the structured error (`WORKSPACE_REQUIRED`, `CLIENT_UNAVAILABLE`, …)
and stops. `packages/cli/src/run-skill-contract.test.ts` enforces this for the
skill and every generated harness paragraph.

The rest of this file is the host-side reference. Per-client behavior
(resume ids, tool mappings, trust, sign-in) applies to both paths: `start_run`
passes the same `client`, `tools`, `resumeSessionId`, and `playbookVersion` to
the same adapters.

One reference for orchestrators and operators: how `agent-deck run` behaves per
client. The brief–launch–monitor–review–resume protocol lives in the
orchestrator skill, and the first-run walk-through lives in the friend path
(see [Links](#links)); this file is the per-client detail both point to.

Source of truth is the code. The CLI, `packages/cli/src/`, owns `run.ts`
(flags, console output), `run-status.ts` (status/log/list rendering), and
`run-detach.ts` (`--detach`). The host-local run service the CLI and backend
share (NOT-479), `packages/backend/src/agent-run/`, owns `service.ts` (binding
gate, run lifecycle), `records.ts` (log, meta.json, status reads),
`adapter.ts` (client list, tool profiles, `trustOverride`), and
`<client>.ts` (flag mappings, resume, trust and sign-in gates).
Every mapping below names its file; anything no adapter code or fixture shows
is marked `<TBD: confirm>`.

Remote coordinators use the same service over HTTP instead of the CLI: see
[AGENT_RUN_API.md](./AGENT_RUN_API.md) (same-host execution, run grants,
capabilities, cancel, restart recovery).

## Launch

Launch form (`run.ts` `printRunHelp`): `agent-deck run <deck> --client claude|codex|cursor|muse --cwd <dir> (--prompt <text>|--prompt-file <path>) [--tools readonly|edit] [--log <path>] [--resume <sessionId>] [--detach]`, plus the poll subcommands `agent-deck run status <runId> [--json]`, `agent-deck run log <runId> [--tail <n>] [--follow] [--json]`, and `agent-deck run list [--json] [--limit <n>]`. The full text is `agent-deck run --help`.

| Flag | Meaning (`run.ts` `parseRunArgs`) |
|------|-----------------------------------|
| `--client` | Required. One of `claude`, `codex`, `cursor`, `muse` (`agent-run/adapter.ts` `RUN_SUPPORTED_CLIENTS`). |
| `--cwd` | Required. Session working directory; its deck assignment must already name `<deck>` (`run` never rewrites it). |
| `--prompt` / `--prompt-file` | Exactly one required. The brief text, or a file it is read from. |
| `--tools readonly\|edit` | Tool profile, default `readonly`. Passed again on resume; nothing is inherited. |
| `--log` | Log file. Default `~/.agent-deck/runs/<runId>/run.jsonl`; `meta.json` sits next to the log either way. |
| `--resume <sessionId>` | Continue a previous client session id under a new run log. |
| `--playbook-version <playbookId>=<versionId>` | Pin one playbook to a stored version for this run only (baseline evaluation). |
| `--detach` | Start in the background in a new session, so the run survives the launching shell going away (`run-detach.ts`). Prints `run <runId> detached: pid <pid> log <path>`; child stdout/stderr go to `run.out` next to the log. Stop a run with `kill <pid>` (`run.ts` `printRunHelp`). |

Examples (one per client, plus polling):

```sh
agent-deck run mydeck --client claude --cwd /path/to/repo --prompt-file ./brief.md --tools readonly --detach
agent-deck run mydeck --client codex --cwd /path/to/repo --prompt "Summarize this repo in five sentences." --tools readonly
agent-deck run mydeck --client cursor --cwd /path/to/repo --prompt-file ./brief.md --tools edit --resume <chatId>
agent-deck run mydeck --client muse --cwd /path/to/repo --prompt-file ./brief.md --tools readonly --detach
agent-deck run status <runId> --json
agent-deck run log <runId> --tail 50
```

Pinned playbook runs (`run.ts` `parseRunArgs`, `agent-run/service.ts` validation): `agent-deck run mydeck --client codex --cwd /path/to/repo --prompt "..." --tools readonly --playbook-version pb_my_playbook=<versionId>` runs one session against a stored older version of one playbook, so a baseline-vs-candidate evaluation can test each version with a real agent. The run's MCP session reads that version's title, body and triggers with no open patches (the `get_playbook` result carries `pinnedVersionId`) and cannot file playbook proposals; the live playbook is never modified, the pin dies with the run's session, and a repeated flag, a malformed value, an unknown version, a version from another playbook, or a playbook off the run's deck all fail before any model work starts. Supported on all four clients: `--client codex` (pin travels as a `-c mcp_servers.agent-deck` override), `--client claude` (pin travels as an inline SDK MCP server), `--client cursor` (pin travels as a header in the worker home's per-run MCP entry), and `--client muse` (pin travels as a header in the worker config's per-run entry). The pin is recorded in the run's `meta.json` as `playbookPin`.

## Clients at a glance

| `--client` | Headless transport | Sign-in prerequisite (preflight) | Workspace trust / `trustOverride` |
|------------|--------------------|----------------------------------|-----------------------------------|
| `claude` | Claude Agent SDK `query()` in-process (`@anthropic-ai/claude-agent-sdk`, lazily required; `agent-run/claude.ts`) | `claude` CLI on PATH, plus `claude auth status` reporting a login — or `ANTHROPIC_API_KEY` set, which skips the login check once the CLI is found (`agent-run/claude-probe.ts` `defaultClaudeClientProbe`); fix: `claude auth login` | No trust gate; `trustOverride` is always false (`agent-run/claude.ts` `planStart`) |
| `codex` | `codex` binary (`CODEX_BIN` override; verified against codex-cli 0.157.1; `agent-run/codex.ts`) | `codex login status` exits 0 and reports `Logged in`; fix: `codex login` | `trustOverride` is true only when `--cwd` is outside a git work tree, in which case `--skip-git-repo-check` is passed (`agent-run/codex.ts` `codexTrustOverride`) |
| `cursor` | `cursor-agent` binary (`CURSOR_BIN` override; verified against cursor-agent 2026.10.01; `agent-run/cursor.ts`) | `cursor-agent status --format json` parses as authenticated (exit code alone is not enough); fix: `cursor-agent login` | `--trust` is passed on every launch, so `trustOverride` is always true (`agent-run/cursor.ts` `planStart`) |
| `muse` | `muse` binary (`MUSE_BIN` override; verified against Muse Code 1.4.4; `agent-run/muse.ts`) | `META_API_KEY` set, or the Muse auth file's `providers` object containing a `meta` entry (`agent-run/muse.ts` `isMuseSignedIn`); fix: `muse login`. The `agent-deck` MCP entry must also exist in the Muse global or project config (`agent-run/muse.ts` `hasMuseMcpEntry`); fix: `agent-deck setup --client muse` | Never trusted from `run`: `--trust-workspace` is never passed, so `trustOverride` is always false; an untrusted-workspace warning surfaces as a log notice instead (`agent-run/muse.ts` `planStart`) |

## Resume: where the session id comes from

`--resume` takes the client session id of a previous run. For every client it
is read the same two places (`agent-run/records.ts`): the `sessionId` field
of `agent-deck run status <runId> --json`, and the log, where `result`, `end`,
`error`, and `notice` lines carry `sessionId` (human `run log` renders
`sessionId=<id>` on `result`/`end` lines; the final console line prints
`run <runId> <state>: log <path> sessionId <id>`). What differs per client is
which native id that is and how resume is invoked:

| `--client` | `sessionId` is... (`agent-run/<client>.ts`) | Resume invokes... |
|------------|----------------------------------------|-------------------|
| `claude` | The SDK message `session_id` (`agent-run/claude.ts` maps it onto every event) | SDK `query()` with the `resume` option set to the id |
| `codex` | The codex thread id (UUID) from the `thread.started` event's `thread_id` (`agent-run/codex.ts` `codexEventsFromLine`) | `exec resume --json [--skip-git-repo-check] -- <thread> <prompt>`; resume takes no `-s`, so the thread keeps its original sandbox; resume is allowed only for a thread an Agent Deck run started with the same deck, canonical cwd, and `--tools` (see **Resume gates**) |
| `cursor` | The chat id (32-hex) from the result object's `session_id` (aliases `sessionId`, `chat_id`, `chatId`; `agent-run/cursor.ts` `cursorEventsFromOutput`) | `--resume <id>` added to the same `-p --trust --output-format json` launch |
| `muse` | The muse session id (UUID) from every record's `stream: {kind: "session", id}` (`agent-run/muse.ts` `museEventsFromLine`) | `--session-id <id>` added to the `exec --json` launch; the `--tools` flags are still passed to the resumed process |

Resume ids starting with `-` fail closed for codex, cursor, and muse
(`agent-run/codex.ts`, `agent-run/cursor.ts`, `agent-run/muse.ts` `planStart`): session ids never
start with `-`. Cursor output is single-shot `json`, so all log lines land when
the process exits and status polling shows no intermediate lines
(`agent-run/cursor.ts`).

## `--tools` mapping per client

| `--client` | `--tools readonly` | `--tools edit` (`agent-run/<client>.ts`) |
|------------|--------------------|------------------------------------|
| `claude` | SDK `allowedTools` = `RUN_READONLY_TOOLS`: `mcp__agent-deck__*`, `Read`, `Glob`, `Grep`, `git log`/`git status`/`ls`-scoped `Bash` | `allowedTools` = `RUN_EDIT_TOOLS`: readonly plus `Edit`, `Write`, `git diff`/`git add`/`git commit`/`git checkout -b`-scoped `Bash`. `permissionMode` is always `acceptEdits`; `settingSources` are `project` and `user`; `bypassPermissions` is never used (`agent-run/adapter.ts`, `agent-run/claude.ts`) |
| `codex` | `-s read-only` | `-s workspace-write` (`CODEX_SANDBOX_FOR_PROFILE`). `--dangerously-bypass-approvals-and-sandbox` is never passed (`agent-run/codex.ts`) |
| `cursor` | `--sandbox enabled --plan --approve-mcps` (verified in `cursor-agent --help`; the worker home's per-run MCP entry is the only approved server) | `--sandbox enabled --force --approve-mcps`: `--force` is command preapproval, not a sandbox. `--yolo` is never passed (`CURSOR_FORBIDDEN_FLAGS`; `agent-run/cursor.ts`). Whether the mapping truly holds is settled by the operator edit-vs-readonly test, not by the flags |
| `muse` | `--approval-mode never --disable-write --sandbox-network restricted` (fails closed unless the installed `muse` lists every flag in `muse exec --help`; `museEnforcementFlagsSupported`; no `--disable-shell`, so shell reads survive) | `--approval-mode never --sandbox-network enabled` (sandbox stays on). `--yolo`, `--trust-workspace`, `--disable-approval`, `--disable-sandbox`, `--permission-profile`, `--disable-shell`, and `--disable-web-tools` are never passed (`MUSE_FORBIDDEN_FLAGS`; `agent-run/muse.ts`) |

## Worker profiles

Agent Deck owns two worker profiles, `readonly` and `edit`, as one shared
definition: `packages/backend/src/agent-run/profiles.ts` (`WORKER_PROFILES`).
It is the single source of truth every client adapter maps onto its own
flags, and the MCP server enforces the Agent Deck tool sets server-side.
Contents are the owner decision of 2026-11-25 — one profile pair mapped
consistently onto claude, codex, cursor and muse, not tightened beyond the
table below.

| Capability | `readonly` | `edit` |
|---|---|---|
| Shell | Read-only commands | Any command |
| File writes | None | The run workspace and the agent user's home (git checkouts, `~/workspace/obsidian` Lexicon vault, caches) |
| Network and web | Reads | Full access |
| Git | No commit or push | Commit and push |
| Host CLIs | No mutations | `gh`, `npm`, `curl` (including `curl` to Agent Dealer at `127.0.0.1:2222`) |
| Claude `Monitor` | No | Yes |
| Agent Deck MCP tools | Read-only tools, explicitly allowed (`get_run`, `get_playbook`, `list_service_tools`, …); `call_service_tool` only when the target service tool is annotated `readOnlyHint: true`. Anything not in the allow set is denied. | Every tool outside the shared deny set, explicitly allowed — including `call_service_tool`, `propose_playbook_patch`, `bind_workspace`, and `cancel_run`. Anything not in the allow set is denied. |
| Always denied | `switch_deck` (and the retired `switch_bound_deck` alias), `request_deck_assignment` (the unassigned-session counterpart — it opens a pending human approval), `request_admin_elevation` and every admin-only tool (`exit_admin_mode`, `manage_deck_card`, `list_collection`, `create_deck`), the deprecated deck-card mutators, `start_run` (workers must not re-delegate), plus every mutating Agent Deck tool (`propose_playbook_patch`, `cancel_run`, `bind_workspace`, deck/card/service writes) | `switch_deck` (and `switch_bound_deck`), `request_deck_assignment`, `request_admin_elevation` and every admin-only tool, the deprecated deck-card mutators, `start_run` |

How it runs:

- The run service mints an unguessable per-run worker token at every
  launch/resume — including runs written to a custom `--log` path — stores
  only its SHA-256 hash in `meta.json` (`runTokenHash`), writes a
  token→record pointer under `<home>/runs-by-token/` so custom locations
  resolve server-side, and passes the plaintext to the adapter
  (`AdapterStartArgs.runToken`). Every adapter carries it as the
  `x-agent-deck-run-token` header in its per-run MCP override
  (`agent-run/codex.ts` `buildCodexMcpConfigOverride`,
  `agent-run/claude.ts` `buildClaudeRunMcpServer`, the Cursor worker
  home's per-run entry, and the Muse worker config's per-run entry).
- An MCP session presenting a valid token is a worker session bound to its
  run's effective profile (adopt-once per session: the identity can never be
  dropped or replaced). Tool calls outside the profile return
  immediately — no elicitation, no pending approval — with the structured
  error `{ code: "PROFILE_DENIED", profile, tool, reason }`. An invalid or
  expired token (no live run matches) is rejected with 401. Leader/owner
  sessions without a token are unchanged, including the `switch_deck`
  human approval (there is no workspace hold: a tokenless session may bind
  anywhere, including a workspace with a live run). Each adapter's per-run
  MCP override must replace the global agent-deck entry under the same server
  name (adapter tickets), so the worker's own client always connects with its token.
  Known limitation: profiles are not a sandbox against a deliberately
  adversarial `edit` worker — with shell, `curl` and agent-home writes it
  could open a tokenless loopback session; closing that would tighten
  `edit`, which is out of scope.
  Worker sessions also never learn their backend runtime session id, so the
  id cannot be reused for direct backend calls past the MCP layer.
- Every adapter answers `profileEnforcement(args)` before any spawn; a
  `false` answer fails the run with its remedy and no process starts. Each
  adapter whose mapping is unproven rejects launch and resume until its own
  mapping lands and is verified.
- Denials are recorded on the run (`RunMeta.denials`, oldest first) with
  `{ at, client, profile, source: "agent-deck" | "client", kind:
  "mcp_tool" | "shell" | "file_write" | "network" | "client_tool", target,
  reason }`: `agent-deck` denials come from the MCP enforcement above,
  `client` denials from the `denial` normalized event adapters yield for
  client-reported refusals. Record writes serialize across processes on a
  per-record lock, so concurrent service and MCP-server writers lose no
  entry. `get_run` and `agent-deck run status` return
  `effectiveProfile` and `denials`. The plaintext token never appears in
  run records, logs, pointers, or `get_run`.

## Log and status fields (shared by all clients)

The JSONL log (`agent-run/records.ts` `RunLogLine`) has one line per event: `text`
(`ts`, `text`), `tool` (`ts`, `name`), `result` (`ts`, `sessionId`, `subtype`,
`result`, optional `usage`), `end` (`ts`, `sessionId`), `notice` (`ts`, `message`, `sessionId`),
`error` (`ts`, `message`, `sessionId`). A run writes at most one `result`
line per turn, just before `end`. For `claude`, `codex`, and `muse` a
`success` result's `result` is the final assistant answer as a string, so
callers read the answer from that line instead of picking among `text`
lines; `cursor` keeps its raw result object (`agent-run/cursor.ts`). Codex
token usage travels in `usage` and never replaces `result`; the answer is the
last `agent_message` of the turn, and every `agent_message`, commentary
included, still streams as a `text` line (`agent-run/codex.ts`
`codexEventsFromLine`). A codex turn that completes with no assistant message
is never an empty success: it writes a `failed` result whose `result` is
``codex turn completed without a final assistant message: re-run the prompt, or read the text and tool lines above for what the session did.``
and the run ends `error` (`CODEX_NO_FINAL_MESSAGE`). `meta.json` (`agent-run/records.ts` `RunMeta`) holds
`runId`, `deck`, `client`, `tools`, `cwd`, `canonicalCwd` (realpath of `cwd`
at launch), `pid`, `startedAt`, `state` (`running`|`ended`|`error`), plus
`sessionId` once known, `trustOverride` only when the launch bypassed a client
workspace-trust guard, and `resumedFrom` (`runId`, `sessionId`, `tools` of the
run that started the session) only on a codex resume.
`agent-deck run status` (`agent-run/records.ts` `RunStatusInfo`) reports `runId`,
`deck`, `client`, `state` (`running`|`ended`|`error`|`died` — a `running` meta
whose pid is gone reads as `died`), `sessionId`, `startedAt`, `lastLogTs`,
`logPath`, `effectiveProfile` (the enforced worker profile), `denials` (the
recorded profile denials, see **Worker profiles**), and `resumedFrom` when the
run resumed another run's session (human output: `resumed from <runId>
(--tools <profile>)`); `run log` prints one readable line per event (`--json` prints raw
JSONL, `--tail` limits, `--follow` streams until `end`/`error`); `run list`
shows recent runs newest first (default limit 20).

Polling cadence: the `agent-deck-run` skill polls `run status` every 30
seconds and caps feedback at 3 resume rounds before escalating to the human
(owner decision, NOT-432). The interval comes from three real read-only
planner/Codex runs on one workstation (2026-10-12), each ending `ended`:
`run-20261012T180930-b3e06c` in 66.787s, `run-20261012T180929-365f84` in
70.065s, and `run-20261012T180928-aa4fe8` in 196.119s. All three still read
`running` at ~42–44s and the two short runs read `ended` by ~67–71s, so their
ends were seen within one 30-second poll. For the long run only the end time
(196.119s) was recorded, not the poll that first read `ended`.

## Fail-closed modes and remedies

Every gate below exits non-zero before or without a usable session, printing
the remedy quoted. Placeholders in `<angle>` brackets stand for run values.

**Deck binding mismatch** (`agent-run/service.ts` `validate`; all clients). The
folder's assignment must already name the deck; `run` never rewrites it:

- ``No deck assigned in <cwd>: run `agent-deck use <deck>` there first, then retry. Refusing to start an unbound session.``
- ``Folder <cwd> is bound to "<other>" (<id>), not "<deck>". Run `agent-deck use <deck>` in that folder to rebind it, then retry. Refusing to start a mis-bound session.``
- After the run, a receipt naming another deck marks it `error`
  (`agent-run/service.ts` `findReceiptDeckMismatch`; printed by `run.ts` `runRun`): ``Session receipt names deck "<other>", not "<deck>": marking run error. Rebind the folder with `agent-deck use <deck>` and retry.``

**Missing sign-in or missing binary** (preflight; per client):

- claude (`agent-run/claude-probe.ts`): ``Claude Code is not installed (no `claude` on PATH). Install Claude Code, then run `claude auth login` to sign in, then retry.`` or ``Claude Code is not signed in. Run `claude auth login` to sign in with your own account, then retry.`` A missing SDK adds (`agent-run/claude.ts`): ``The Claude Agent SDK is not installed. Reinstall the CLI (`agent-deck upgrade` or `npm install -g @agent-deck/cli@latest`) so @anthropic-ai/claude-agent-sdk is present, then retry.``
- codex (`agent-run/codex.ts`): ``codex CLI not found (tried "<bin>"): install codex-cli 0.157+ and ensure 'codex' is on PATH (or set CODEX_BIN=/path/to/codex), then retry.`` or ``codex is not signed in: run `codex login`, then retry.``
- cursor (`agent-run/cursor.ts`): ``cursor-agent CLI not found (tried "<bin>"): install cursor-agent 2026.10+ and ensure 'cursor-agent' is on PATH (or set CURSOR_BIN=/path/to/cursor-agent), then retry.`` or ``cursor-agent is not signed in: run `cursor-agent login`, then retry.``
- muse (`agent-run/muse.ts`): ``muse CLI not found (tried "<bin>"): install Muse Code 1.4+ and ensure 'muse' is on PATH (or set MUSE_BIN=/path/to/muse), then retry.`` or ``muse is not signed in: run `muse login`, then retry.`` A missing MCP entry adds: ``agent-deck MCP server is not registered with Muse: run `agent-deck setup --client muse` to register it, then retry. If Muse reports the server needs authorization, run `muse mcp login agent-deck` (see `muse mcp --help`).``

**Untrusted workspace** (per client):

- codex: not a failure — outside a git work tree `run` passes
  `--skip-git-repo-check` and records `trustOverride: true` (`agent-run/codex.ts`).
- cursor: `--trust` is always passed (`trustOverride: true`), but output
  containing `Workspace Trust Required` still fails the run as `error`
  (`agent-run/cursor.ts` `cursorEventsFromOutput`): `cursor-agent reported "Workspace Trust Required": open the folder in Cursor and accept the workspace trust prompt, then retry.` An empty result at exit 0 fails the same way.
- muse: never trusted from `run` (`trustOverride: false`); stderr lines
  matching `warning|untrusted|delegation|error|fail`
  (`MUSE_STDERR_NOTICE_PATTERN`) surface as log notices and never fail the run
  (`agent-run/muse.ts`). Which capabilities an untrusted workspace actually loses is
  `<TBD: confirm>` on the installed Muse build — `run` only surfaces the
  warning and continues.
- claude: no workspace-trust gate in the adapter (`trustOverride` always
  false; `agent-run/claude.ts`).

**Resume gates** (per client): `codex exec resume` accepts no sandbox flag, so a
codex thread keeps the sandbox it started with. `validate`
(`agent-run/service.ts`, via `agent-run/provenance.ts`
`resolveResumeProvenance`) therefore resumes a codex session only when the
earliest non-resume run record under `~/.agent-deck/runs/` that captured that
`sessionId` (runs written to a custom `--log` path are not discoverable) matches
the request on client, deck, canonical cwd (realpath, so a symlinked path to the
same folder matches), and `--tools`. Edit→edit and readonly→readonly continue
under the unchanged session id and record `resumedFrom`; everything else fails
before codex is launched:

- unknown or external session: ``Cannot resume codex session <id>: no Agent Deck run on this host started it, so its sandbox is unknown. Resume only a sessionId printed by `agent-deck run` (see `agent-deck run list`), or start a new run without --resume.``
- client mismatch: `Cannot resume session <id> with --client codex: it was started by --client <client> in run <runId>. Resume it with --client <client>, or start a new run.`
- deck mismatch: `Cannot resume session <id> on deck "<deck>" (<deckId>): run <runId> started it on deck <originDeckId>. Resume it on that deck, or start a new run on "<deck>".`
- cwd mismatch: `Cannot resume session <id> in <cwd>: run <runId> started it in <canonicalCwd>. Resume it with --cwd <canonicalCwd>, or start a new run here.`
- profile mismatch (readonly→edit escalation, or edit→readonly, which would still write): `Cannot resume session <id> with --tools <requested>: run <runId> started it with --tools <origin>, and a resumed codex thread keeps its original sandbox. Resume with --tools <origin>, or start a new run with --tools <requested>.`

The codex adapter re-checks the profile against the resolved origin in
`planStart`, so a caller that skips `validate` still fails closed.
`--dangerously-bypass-approvals-and-sandbox` is never passed on start or resume.
Cursor start with no deck receipt fails closed
(`agent-run/cursor.ts`): `cursor-agent run produced no deck receipt (missing ◆ display_summary line): the session may be bound to another folder's deck. Ask the agent to call get_session_context and print display_summary verbatim, then retry.` (Resume is exempt: the harness prints the receipt on the first turn only.)

## Links

- Orchestrator skill (brief–launch–monitor–review–resume protocol): [skills/agent-deck-run/SKILL.md](../skills/agent-deck-run/SKILL.md)
- Friend path (first delegated run walk-through): [FRIEND_PATH.md](./FRIEND_PATH.md)
