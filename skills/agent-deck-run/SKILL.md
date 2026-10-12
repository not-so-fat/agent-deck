---
name: agent-deck-run
description: Use when delegating a task to a local coding session on a named deck: brief it, launch it detached with agent-deck run, monitor it, review the result against the goal, and resume it with feedback until done.
---

# Agent Deck run (orchestrator)

You are the caller of a session, not the session. Follow the five steps below.

## Prerequisite

You must be able to run shell commands on the machine where the coding tool is signed in; otherwise stop and tell the human you cannot use this skill.

## 1. Write the brief

Write the brief to a file. It must state the goal, the constraints, the definition of done, what the session must not do, and the tool profile the brief owner chose. Never put secrets in the brief.

## 2. Launch detached

The user names the deck; the brief owner picks the tool profile: `readonly` for research, planning, and review, `edit` for coding work. When the brief owner has not said, the default is `readonly`.

```sh
agent-deck run <deck> --client <client> --cwd <dir> --prompt-file <brief-file> --tools readonly --detach
```

Supported `--client` values are `claude`, `codex`, `cursor`, `muse`; `agent-deck run --help` lists the clients. The examples use `claude`; substitute your client. Read the `runId`, pid, and log path from the `run <runId> detached: pid <pid> log <path>` line. If the launch fails closed on a deck binding mismatch, stop and report to the human instead of rebinding.

## 3. Monitor

Poll until the state leaves `running`. Suggested poll interval: 30 seconds (unconfirmed).

```sh
agent-deck run status <runId>
agent-deck run status <runId> --json
agent-deck run log <runId> --follow
agent-deck run log <runId> --tail 50
agent-deck run list
```

Read the `state` field (`running|ended|error|died`), the `sessionId`, and the log path. Stop rule: on `died` or `error`, stop polling, read the tail of the log for the failure, and report to the human.

## 4. Review

Judge the session's output against the goal and definition of done from step 1, not against the session's own summary. If it meets the goal, report to the human and stop.

## 5. Resume with feedback

Resume the same session with a feedback brief that quotes the gap found in step 4. Pass `--tools` again with the same profile: the profile is not inherited on resume.

```sh
agent-deck run <deck> --client <client> --cwd <dir> --prompt-file <feedback-file> --tools readonly --resume <sessionId> --detach
```

Repeat steps 3-5 until the goal is met or a round cap is hit (placeholder: 3 feedback rounds, unconfirmed), then report to the human.

## Hard rules

- Never pick or change the deck on your own; the user names it.
- Never raise the tool profile from `readonly` to `edit` on your own; only the brief owner does.
- No secrets in briefs or logs.
- Report the `runId`, `sessionId`, tool profile, and log path back to the human.
