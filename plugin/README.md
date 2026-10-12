# Agent Deck Delegation plugin

One skill, **Delegate to a local coding agent**, that teaches an orchestrating agent to hand work to a local Claude Code, Codex, Cursor, or muse session via `agent-deck run`, monitor it, review the real output, and resume with feedback until done.

## Prerequisites
- [agent-deck](https://github.com/not-so-fat/agent_deck) >= 2.1.0 on the machine that runs the coding session (`agent-deck setup`, `agent-deck doctor`).
- The client CLI you delegate to, installed and signed in.
- An orchestrator that can run shell commands on that machine.

## Install

### Cursor
Settings → Plugins → add marketplace / install from repo `not-so-fat/agent_deck` (plugin folder `plugin/`), or copy this folder to `~/.cursor/plugins/local/agent-deck-delegation` and restart Cursor. Manifest: `.cursor-plugin/plugin.json`.

### Claude Code
```
/plugin marketplace add ./plugin            # from a clone of this repo
/plugin install agent-deck-delegation@agent-deck
```
(Or point `marketplace add` at a local path to this folder.) Manifest: `.claude-plugin/plugin.json`.

### Any agent
Copy `skills/delegate-to-a-local-coding-agent/SKILL.md` into your agent's skills directory.

## Quick check
```sh
mkdir -p /tmp/ad-smoke && cd /tmp/ad-smoke
agent-deck use <deck> --client claude
echo "List the files here in one sentence. Do not modify anything." > brief.md
agent-deck run <deck> --client claude --cwd . --prompt-file brief.md --tools readonly --detach
agent-deck run status <runId>; agent-deck run log <runId> --tail 20
```
