# `agent-deck run` delegation reference (per-client)

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
| `cursor` | No write-enabling flag | `--force`. `--yolo` and `--approve-mcps` are never passed (`agent-run/cursor.ts`). Print mode (`-p`) reports access to all tools including write and shell, so whether `readonly` truly cannot write is `<TBD: confirm>` — settled by the operator edit-vs-readonly test, not by the flags (`agent-run/cursor.ts`) |
| `muse` | `--disable-write --disable-shell` (fails closed unless the installed `muse` lists both in `muse exec --help`; `museReadonlyFlagsSupported`) | No extra flags: default bounded permissions (approval on-request, sandbox on). `--yolo`, `--trust-workspace`, `--disable-approval`, `--disable-sandbox`, and `--permission-profile` are never passed (`MUSE_FORBIDDEN_FLAGS`; `agent-run/muse.ts`) |

## Log and status fields (shared by all clients)

The JSONL log (`agent-run/records.ts` `RunLogLine`) has one line per event: `text`
(`ts`, `text`), `tool` (`ts`, `name`), `result` (`ts`, `sessionId`, `subtype`,
`result`), `end` (`ts`, `sessionId`), `notice` (`ts`, `message`, `sessionId`),
`error` (`ts`, `message`, `sessionId`). `meta.json` (`agent-run/records.ts` `RunMeta`) holds
`runId`, `deck`, `client`, `tools`, `cwd`, `canonicalCwd` (realpath of `cwd`
at launch), `pid`, `startedAt`, `state` (`running`|`ended`|`error`), plus
`sessionId` once known, `trustOverride` only when the launch bypassed a client
workspace-trust guard, and `resumedFrom` (`runId`, `sessionId`, `tools` of the
run that started the session) only on a codex resume.
`agent-deck run status` (`agent-run/records.ts` `RunStatusInfo`) reports `runId`,
`deck`, `client`, `state` (`running`|`ended`|`error`|`died` — a `running` meta
whose pid is gone reads as `died`), `sessionId`, `startedAt`, `lastLogTs`,
`logPath`, and `resumedFrom` when the run resumed another run's session (human
output: `resumed from <runId> (--tools <profile>)`); `run log` prints one readable line per event (`--json` prints raw
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
