# Friend path: cold machine → first deck switch → first Dealer issue

> Start here, finish with one small issue sitting in the Dealer queue.
> Anything deeper lives in [Setup](./SETUP.md); the full product map is the [README](../README.md).

**The split in one line:** Agent Deck stores your portable method — playbooks, tools, and credentials. Agent Dealer runs the issue queue on top of it.

## Prerequisites

- **macOS** — production Deck secret storage uses macOS Keychain.
- **Node.js 20+** and **npm** (`node -v` to check).
- **`gh` authenticated** — `gh auth status` must succeed before Dealer can touch GitHub.
- **One working agent runtime:** Claude Code or Cursor, installed and signed in.
  Runtime install/doctor detail is out of scope here — see the Dealer setup guidance below
  and the deeper per-runtime guide landing with [NOT-166](https://linear.app/not-so-fat/issue/NOT-166/per-runtime-installation-guide-claude-codex-cursor-with-verifiable).
- Everything else (Linear, Notion, Slack keys) is **optional** — add only what your first deck needs.

## 1. Install Deck

```bash
curl -fsSL https://raw.githubusercontent.com/not-so-fat/agent_deck/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
```

(One-shot alternative: `npx @agent-deck/cli@latest install`.)
Verify before moving on: `agent-deck --version` prints a version.

## 2. Open the dashboard — always with `agent-deck open`

```bash
agent-deck open
```

This starts the backend when it is stopped and opens the dashboard with a fresh launch pass.
**Never type bare `http://127.0.0.1:1111` as the entry URL** — without a launch pass it only shows a recovery view.
Verify: the dashboard opens in your browser with **My Decks** and **My Collection** visible.

## 3. Create a small deck

In the dashboard: **My Decks → create a deck** (e.g. `friend`). Keep it tiny — no integration cards yet; you can drag cards on later.
Verify: the new deck appears under **My Decks**.

## 4. Connect your host and switch a sample workspace to that deck

```bash
agent-deck setup --client claude   # --client one of claude|codex|cursor|muse (once per machine)
cd /path/to/a/sample/repo
agent-deck use friend
```

Restart the host after `setup` so it picks up the Agent Deck connection.
Verify: terminal agents show `◆ friend · …` in the footer.
Cursor IDE chat has no status-line badge (terminal status line only) — there, ask the agent which deck is bound to this workspace and confirm it answers `friend`.

## 5. Install Dealer, check `gh`, configure agents

```bash
npx agent-dealer@latest install
export PATH="$HOME/.local/bin:$PATH"
gh auth status
agent-dealer setup
```

(Managed install, same shape as Deck — existing `~/.agent-dealer` data is kept.
`agent-dealer --version` confirms the install; `agent-dealer doctor` reports install state.
Exact launch flags live in [the Dealer README](https://github.com/not-so-fat/agent-dealer).)

`setup` walks you to the Dealer Issues home. There, connect the **developer** and **reviewer** agents and choose a GitHub repository.
A fresh home shows a compact **First issue** strip pointing at the next missing step (**Agents** or **New issue**) — follow it until it stops pointing at Agents.
Verify: Dealer agent health is ready before moving on.

## 6. Create one small issue

In Dealer: **New issue**, pick the repository, and write one small task.
Verify: the issue appears in the Dealer queue — open it to see it in the timeline.

## First delegated run (detach, check, resume)

Whoever drives the commands below — a cloud orchestrator with local shell access, or the friend's own terminal — must be able to run commands on the machine where Claude Code is signed in. Delegated execution is local-only: an orchestrator that cannot reach that machine's shell is out of scope for this path, and there is no remote runner to fall back to.

Finish steps 1–4 above first (install, `open`, a small deck, `setup` + `use`); Dealer steps 5–6 are not needed here. What follows is the friend-side half: one `agent-deck run` launched detached, checked with `status` and `log`, then resumed once. If you are the orchestrator rather than the friend, the brief–launch–monitor–review–resume loop lives in the orchestrator skill ([NOT-403](https://linear.app/not-so-fat/issue/NOT-403/ship-an-orchestrator-skill-brief-launch-monitor-review-resume-a-deck)) — this section is the commands it drives, not a second copy of that skill.

`agent-deck run` accepts `--client claude`, `--client codex`, `--client cursor`, or `--client muse`; the worked example below uses `claude`.

### Prerequisites

- **macOS** with **Node.js 20+** (`node -v` to check) — same as the top of this guide.
- **Claude Code installed and signed in by the friend.** Sign-in is yours alone: run `claude auth login` on this machine and complete it in your own browser/terminal. Agent Deck never sees, stores, or proxies your Claude credentials.
- **Steps 1–4 done**: a small deck exists (called `friend` below) and the sample folder is bound to it (`agent-deck use friend` in that folder).
- **Shell access**: the rule from the top of this section — the orchestrator must be able to run commands on this machine, where Claude Code is signed in. Without that, stop here.

### The brief (read-only and safe)

The example brief below only asks for a summary of the sample repo. It runs under the default `--tools readonly` profile, which cannot create, modify, or delete files, so it is safe to run sight-unseen. (The `edit` profile exists for real work; this first run does not need it.)

### 1. Launch detached (`run --detach`)

`--cwd` must be the sample folder bound in step 4 (the folder where `agent-deck use friend` was run — `run` checks the binding of `--cwd`, not the shell's current folder):

```bash
agent-deck run friend --client claude --cwd /path/to/a/sample/repo --prompt "List the top-level files and directories in this working directory and summarize in at most five sentences what this project appears to do. Do not create, modify, or delete any files." --tools readonly --detach
```

Expected output (ids and pid differ):

```text
run run-20261012T000000-a1b2c3 detached: pid 12345 log /Users/you/.agent-deck/runs/run-20261012T000000-a1b2c3/run.jsonl
```

Save the run id (`run-…`): the next commands take it as `<runId>`. The run survives the launching shell going away. To stop a still-running run, `kill <pid>` with the printed pid.

### 2. Check the run (`run status`, `run log`)

Poll until the state reads `ended` (a fresh launch may still say `running`):

```bash
agent-deck run status <runId>
```

Expected output:

```text
run run-20261012T000000-a1b2c3 ended
  deck deck-friend
  client claude
  started 2026-10-12T00:00:00.000Z
  session ses_abc123
  last log 2026-10-12T00:01:00.000Z
  log /Users/you/.agent-deck/runs/run-20261012T000000-a1b2c3/run.jsonl
```

Save the session id (`ses_…`). Then read what the run did:

```bash
agent-deck run log <runId> --tail 20
```

Expected output:

```text
2026-10-12T00:00:30.000Z text <first sentences of the summary>
2026-10-12T00:01:00.000Z result success sessionId=ses_abc123 <short result>
2026-10-12T00:01:00.000Z end sessionId=ses_abc123
```

(`run log --follow` streams a still-running log; `run list` shows recent runs.)

### 3. Resume on the same session (`--resume`)

Continue the same Claude session under a new run log:

```bash
agent-deck run friend --client claude --cwd /path/to/a/sample/repo --prompt "In one sentence, restate your conclusion about this project." --resume <sessionId> --detach
```

Verify with the new run id:

```bash
agent-deck run status <newRunId>
```

Expected output:

```text
run run-20261012T000005-d4e5f6 ended
  deck deck-friend
  client claude
  started 2026-10-12T00:05:00.000Z
  session ses_abc123
  last log 2026-10-12T00:05:30.000Z
  log /Users/you/.agent-deck/runs/run-20261012T000005-d4e5f6/run.jsonl
```

The two `session` lines are equal: the resume continued the same Claude session under a new run log. That is the whole delegation loop.

### When it fails (three remedies)

- **Not signed in.** `run` exits 1 with one line naming the fix — do what it says, then retry the same command:

  ```text
  Claude Code is not signed in. Run `claude auth login` to sign in with your own account, then retry.
  ```

  ```bash
  claude auth login
  ```

  The sibling message means the CLI itself is missing:

  ```text
  Claude Code is not installed (no `claude` on PATH). Install Claude Code, then run `claude auth login` to sign in, then retry.
  ```

  One exception: when `ANTHROPIC_API_KEY` is set, the preflight skips the sign-in check once the `claude` CLI is found (the CLI must still be on PATH; the SDK accepts the key instead of the login). API-key mode is not part of this path — sign in with `claude auth login` as above — and a stale key sails through the preflight only to fail inside the run.

- **Deck not found.** `Deck not found: friend` (or the `No deck assigned` / `mis-bound` variants) means step 3–4 drift: re-check the deck name in the dashboard and run `agent-deck use friend` inside the sample folder, then retry. `run` never rebinds the folder for you.
- **Run `died`.** `run status` shows `died` when the process is gone with no `end` line (machine slept, process killed). Read `agent-deck run log <runId>` and the `run.out` file next to the printed log path for the last words, then relaunch the same `run --detach` command for a fresh run.

### Verification note

2026-10-12 — rehearsed end to end on macOS 27.0.1 with agent-deck 2.0.0 and Claude Code 2.1.296, using the CLI's fake runner (`AGENT_DECK_RUN_FAKE`, no model call) in place of the network: the five commands above, with `--cwd` pointed at a scratch workspace (`/tmp/friend-path-rehearsal/ws`, assignment `deck-friend`/`friend`, `AGENT_DECK_HOME` under `/tmp/friend-path-rehearsal/home`), produced a detached run ending in `ended`, a matching `status`/`log` read, and a resume whose `session` equaled the first run's (`ses_friendpath01` in both; run ids `run-20261012T065914-612d58` and `run-20261012T065917-5fd347`). Log excerpt from that rehearsal:

```text
2026-10-12T06:59:14.845Z text Rehearsal brief acknowledged (fake runner, no model call).
2026-10-12T06:59:14.846Z result success sessionId=ses_friendpath01 fake ok
2026-10-12T06:59:14.846Z end sessionId=ses_friendpath01
```

The fake runner made no model call, so the equal session ids say nothing about real resume behavior; the real run on a clean machine with the friend's own Claude sign-in is owned by [NOT-421](https://linear.app/not-so-fat/issue/NOT-421) as a separate follow-up. After merging `main` (NOT-404 adapter refactor) the same fake-runner rehearsal was repeated on the merged tree with identical results (`ended`, matching `status`/`log`, resume session `ses_merge01` in both runs), and once more as a final check on the shipping tree (`ended`, resume session `ses_repair02` in both runs).

## If you get stuck (two notes, nothing more)

- **Typed `http://127.0.0.1:1111` and see “Open your dashboard securely”?**
  Nothing is broken — that address alone can never sign anyone in.
  Click **Open dashboard**, or run `agent-deck open` in your terminal.
- **Dealer asks about a worktree or policy gate?**
  Read the short question and take the primary action (e.g. **Resume safely**).
  Open **Details** only when you need the paths, exact commands, or logs.
