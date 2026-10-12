# Agent Deck Delegation plugin

One skill, **Delegate to a local coding agent**, that teaches an orchestrating agent to hand work to a local Claude Code, Codex, Cursor, or muse session via `agent-deck run`, monitor it, review the real output, and resume with feedback until done.

## Prerequisites and local setup
Two skills ship here: **Set up agent-deck locally** (checks and fixes) and **Delegate to a local coding agent** (checks prerequisites first, then delegates).

1. **Install agent-deck >= 2.1.0** (macOS; Node.js 20+ and npm). Managed install: launcher at `~/.local/bin/agent-deck`, data under `~/.agent-deck/`.
   ```sh
   npx @agent-deck/cli@latest install
   export PATH="$HOME/.local/bin:$PATH"
   ```
   Upgrade later with `agent-deck upgrade` (`agent-deck upgrade --check` to see if one is available).
2. **Check and start:** `agent-deck --version`, `agent-deck doctor` (prints any `agent-deck setup --client <client>` repairs), `agent-deck status`, and `agent-deck start --daemon` if it is not running.
3. **Install and sign in the client CLI** you delegate to:
   - Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup (check: `claude auth status`)
   - Codex: https://developers.openai.com/codex/cli (`codex login`, check: `codex login status`)
   - Cursor CLI: https://cursor.com/docs/cli/installation (`cursor-agent login`, check: `cursor-agent status`)
   - muse: install per your muse distribution, then `muse login`
4. **Create or import a deck:** `agent-deck open` → My Decks → create a deck, or `agent-deck import <file>.agent-deck.json`. List with `agent-deck deck list`.
5. **Bind each working folder:** `cd <dir> && agent-deck use <deck> --client <client>`.
6. The orchestrating agent must be able to run shell commands on that machine.

## Install

### Claude Code
```
/plugin marketplace add not-so-fat/agent-deck
/plugin install agent-deck-delegation@agent-deck
```
The repo-root `.claude-plugin/marketplace.json` lists this plugin with `source: ./plugin` (next to the main `agent-deck` plugin). From a local clone, `/plugin marketplace add ./plugin` also works.

### Cursor
Add `not-so-fat/agent-deck` as a plugin marketplace (the repo-root `.cursor-plugin/marketplace.json` points at `./plugin`) and install **agent-deck-delegation**, or copy `plugin/` to `~/.cursor/plugins/local/agent-deck-delegation` and restart Cursor.

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
