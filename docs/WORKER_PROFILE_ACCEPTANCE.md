# Worker profile operator acceptance (NOT-672)

Runs the two `[operator]` acceptance criteria: real headless Codex and
Claude starts and resumes under both worker profiles, with verified
permissions and no approval waits. Do this on a machine with network
access, provider credentials, and a running Agent Deck daemon — it cannot
run in a restricted sandbox.

Reference versions (record the actuals with the evidence): codex-cli
0.169.0, Claude Code 2.1.327, `@anthropic-ai/claude-agent-sdk` 0.3.296.

## 0. Setup

```sh
git checkout <PR-branch> && git rev-parse --short HEAD   # PR SHA for the evidence
agent-deck start                                          # daemon + MCP on 127.0.0.1:1110
agent-deck use <deck>                                     # in each fixture workspace below
node scripts/worker-profile-probe-server.mjs 18080       # controlled HTTP endpoint
```

Per client × profile you need a disposable workspace (a git repo with one
seed file) and a disposable home-marker path. The briefs below take
`$WS` (workspace), `$HOME_MARKER` (a file path under the agent home, e.g.
`$HOME/worker-probe-<id>.txt`), and `$PROBE` (default
`http://127.0.0.1:18080`):

```sh
export WS=/tmp/worker-probe-ws && rm -rf $WS && mkdir -p $WS
cd $WS && git init -q && echo "seed" > seed.txt && git add -A && git -c user.email=t@t -c user.name=t commit -qm seed
export HOME_MARKER=$HOME/worker-probe-$(date +%s).txt PROBE=http://127.0.0.1:18080
```

Dealer loopback (`127.0.0.1:2222`) must be reachable for the edit checks;
if Dealer is not running there, record that and treat the loopback step as
not-run rather than passed.

No step below may prompt: if any run waits on an approval, elicitation, or
question, stop and record it as a failure. Denials must land immediately
(seconds, not minutes) with no pending approval left behind
(`switch_deck` in particular must create nothing approvable).

## 1. Codex, readonly

Start:

```sh
agent-deck run <deck> --client codex --cwd $WS --tools readonly --prompt '
You are verifying a read-only worker profile. Do exactly these probes in order, reporting each outcome:
1. Read the file seed.txt in the working directory and report its content.
2. GET '$PROBE'/read with curl and report the body.
3. Call the Agent Deck MCP tool get_run for a made-up run id and report the error shape (proves read-only MCP works).
4. Try to write the file probe-write.txt in the working directory (expect failure) and report the exact error.
5. Try curl -X POST '$PROBE'/write -d probe=1 (expect failure) and report the exact error.
6. Try the Agent Deck MCP tool switch_deck to any other deck (expect immediate PROFILE_DENIED) and report the error.
Do not attempt anything else.'
```

Expect: 1–3 succeed; 4 fails at the read-only sandbox (write refused);
5 fails (no direct network write from the sandbox); 6 fails immediately
with `PROFILE_DENIED`. Record the run id and `sessionId` from the final
line, then resume with the same profile and the mutation probes again:

```sh
agent-deck run <deck> --client codex --cwd $WS --tools readonly --resume <sessionId> --prompt '
Repeat the read-only verification on the resumed thread: read seed.txt, GET '$PROBE'/read,
then try the probe-write.txt write, the POST to '$PROBE'/write, and switch_deck again.
Report each outcome.'
```

Expect the same verdicts on the unchanged `sessionId`. A resume with
`--tools edit` must fail closed before launch (profile mismatch), as must
a resume of an unknown id.

## 2. Codex, edit

Fresh `$WS` (re-run the setup), then start:

```sh
agent-deck run <deck> --client codex --cwd $WS --tools edit --prompt '
You are verifying an edit worker profile. Do exactly these probes in order, reporting each outcome:
1. Write the file probe-write.txt in the working directory containing "workspace-ok".
2. Write the file '$HOME_MARKER' containing "home-ok".
3. GET '$PROBE'/read and report the body.
4. POST probe=codex-edit to '$PROBE'/write and report the response, then GET '$PROBE'/writes.
5. GET http://127.0.0.1:2222/ (Agent Dealer loopback) with curl and report reachable-or-refused.
6. Call the Agent Deck MCP tool get_run for a made-up run id (approved MCP) and report the error shape.
7. Try the Agent Deck MCP tool switch_deck to any other deck (expect immediate PROFILE_DENIED).
8. Try the Agent Deck MCP tool start_run with a trivial prompt (expect immediate PROFILE_DENIED).'
```

Expect: 1–6 succeed; 7–8 fail immediately with `PROFILE_DENIED`.
Verify side effects yourself: `$WS/probe-write.txt` says `workspace-ok`,
`$HOME_MARKER` says `home-ok`, and `GET /writes` lists the `codex-edit`
body. Then resume with `--tools edit` and repeat probes 1 (overwrite with
`resumed-ok`), 4, and 7.

## 3. Claude, readonly

Fresh `$WS`, then start (note: readonly `curl` is intentionally denied —
web reads go through WebFetch; the compound commands must each fail as a
whole):

```sh
agent-deck run <deck> --client claude --cwd $WS --tools readonly --prompt '
You are verifying a read-only worker profile. Do exactly these probes in order, reporting each outcome:
1. Read the file seed.txt with the Read tool.
2. WebFetch '$PROBE'/read and report the body.
3. Call the Agent Deck MCP tool get_run for a made-up run id and report the error shape.
4. Try to Write the file probe-write.txt (expect denial) and report the rejection.
5. Try the Bash command "curl -X POST '$PROBE'/write -d probe=1" (expect denial).
6. Try the Bash command "ls; touch probe-write.txt" (expect denial of the whole compound).
7. Try the Bash command "git status && curl -X POST '$PROBE'/write -d probe=2" (expect denial).
8. Try the Bash command "python3 -c \"print(1)\"" (expect denial).
9. Try the Agent Deck MCP tool switch_deck to any other deck (expect immediate denial).
10. Try the Monitor tool with command "ls" (expect denial).'
```

Expect: 1–3 succeed; 4–10 denied immediately. Then resume same-profile
and repeat probes 4–7. Also resume once with `--tools edit` and once with
an unknown id: both must fail closed before launch.

## 4. Claude, edit

Fresh `$WS`, then start:

```sh
agent-deck run <deck> --client claude --cwd $WS --tools edit --prompt '
You are verifying an edit worker profile. Do exactly these probes in order, reporting each outcome:
1. Write probe-write.txt containing "workspace-ok" and Edit it to append "-edited".
2. Write the file '$HOME_MARKER' containing "home-ok" with the Write tool.
3. GET '$PROBE'/read with curl and report the body.
4. POST probe=claude-edit to '$PROBE'/write with curl, then GET '$PROBE'/writes.
5. GET http://127.0.0.1:2222/ (Agent Dealer loopback) with curl and report reachable-or-refused.
6. Run "git add -A && git commit -m probe" and report the commit (then leave the repo as is).
7. Call the Agent Deck MCP tool get_run for a made-up run id and report the error shape.
8. Arm a Monitor watch running "echo tick" briefly, read one event, and stop it.
9. Try switch_deck and start_run (expect immediate denial for both).'
```

Expect: 1–8 succeed; 9 denied immediately. Verify
`$WS/probe-write.txt`, `$HOME_MARKER`, `/writes`, and the git log
yourself. Then resume same-profile and repeat probes 3–4 and 9.

## 5. Evidence to record

Per client × profile, record all of:

- Client version (`codex --version`, `claude --version`), PR SHA.
- Start run id + resume run id + shared `sessionId`.
- Fixture side effects: workspace file contents, home-marker contents,
  `GET /writes` bodies, git log line for the Claude edit commit.
- Redacted `agent-deck run status <runId> --json` (or `get_run`) for the
  start and the resume, showing `effectiveProfile` and every denial with
  its type (`source`/`kind`) and `target`. Tokens never appear in run
  records; verify none leaked into the pasted JSON.
- A no-prompts attestation: the four starts and four resumes completed
  without human interaction, and no pending approval was left behind.

## 6. Cleanup

```sh
rm -rf $WS "$HOME_MARKER"
```

(Use a fresh `$WS` per section; home markers are timestamped.)
