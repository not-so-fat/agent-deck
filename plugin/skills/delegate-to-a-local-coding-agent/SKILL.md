---
name: Delegate to a local coding agent
description: >-
  Use when a task should be handed to Claude Code, Codex, Cursor, or muse on a
  machine with agent-deck, then monitored, reviewed, and resumed with feedback
  until it is right.
---
# Delegate to a local coding agent

Goal: the coding session does the work; you own the brief, the review, and the follow-up. Never just relay its summary.

## Prerequisites
- agent-deck >= 2.1.0 on the target machine (`agent-deck --version`; `agent-deck doctor` if anything looks off, `agent-deck setup` on a fresh machine).
- The client CLI (`claude`, `codex`, `cursor-agent`, or `muse`) installed and signed in on that machine.
- You (the orchestrator) can run shell commands on that machine. If not, stop and say so.

## 1. Pick deck and client
The user names the deck; never pick or change it yourself. Use the client they ask for (`claude|codex|cursor|muse`). Pick the tool profile: `readonly` for research, planning, and review; `edit` only for coding work.

Bind the working directory once (a run refuses to start otherwise with "No deck assigned in <dir>: run `agent-deck use <deck>` there first"):
```sh
cd <dir> && agent-deck use <deck> --client <client>
```
This writes `.agent-deck/use.json` and the client's MCP config (e.g. `.mcp.json`). Leave the user's uncommitted changes alone; work in a separate git worktree or branch when the repo is dirty.

## 2. Write the brief file
Goal; context and facts you verified; what to read first; rules (scope, what not to touch); definition of done (including "commit and push branch X" when code changes); "if unclear, end your turn with the question". Keep the user's decisions, don't invent them, and mark any number you make up as an unconfirmed placeholder. No secrets.

## 3. Launch detached
```sh
agent-deck run <deck> --client <client> --cwd <dir> --prompt-file <brief-file> --tools readonly --detach
```
Output: `run <runId> detached: pid <pid> log <path>`. Keep the runId.

## 4. Monitor
```sh
agent-deck run status <runId>          # or --json: {"runId","state","sessionId","logPath",...}
agent-deck run log <runId> --tail 50   # lines: <ts> text|tool|result|end ...
agent-deck run list
```
Poll every ~30s until `state` leaves `running` (`ended|error|died`). The log ends with `result success sessionId=<id> <final text>` and `end sessionId=<id>`. Note the `sessionId`; you need it to resume. Read `text` lines for questions; answer from verified facts or ask the user, don't guess. On `error`/`died`, read the log tail and report.

## 5. Review against the goal
Open the real output yourself (files, diff, tickets, PR), not the session's summary. Check scope, the definition of done, invented numbers, and duplicates.

## 6. Resume with feedback
Write a feedback brief quoting the specific gaps, then resume the same session. Pass `--tools` again; it is not inherited.
```sh
agent-deck run <deck> --client <client> --cwd <dir> --prompt-file <feedback-file> --tools readonly --resume <sessionId> --detach
```
Repeat 4-6 until it is right; after about 3 rounds, bring the blocker to the user.

## 7. Verify it landed
For code work, confirm the result is pushed: `git ls-remote origin <branch>` matches the local `git rev-parse HEAD`, and the PR (if any) exists. Then report what was produced (ids, links, SHA), what you changed in review, and decisions only the user can make.
