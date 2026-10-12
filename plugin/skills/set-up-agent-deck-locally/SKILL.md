---
name: Set up agent-deck locally
description: >-
  Use when agent-deck or a client CLI (claude, codex, cursor-agent, muse) is
  missing, outdated, stopped, or signed out on the machine you want to delegate
  to, or before the first delegation on a new machine.
---
# Set up agent-deck locally

Check first, then tell the human exactly what is missing. Run read-only checks yourself; the human runs installs and sign-ins (they are interactive or change their machine). Never reinstall over a working install.

## 1. Check (read-only)
```sh
agent-deck --version        # need >= 2.1.0
agent-deck upgrade --check  # "Install: managed" / "Already on the latest version."
agent-deck status           # "Status: running", MCP http://127.0.0.1:1110/mcp
agent-deck doctor           # "Issues: none"; lists harness repairs with the exact command
agent-deck deck list        # <uuid>  <name> per deck
claude --version;  claude auth status        # "loggedIn": true
codex --version;   codex login status        # "Logged in ..."
cursor-agent --version; cursor-agent status  # "Logged in as ..."
muse --version
```
Only the client you will delegate to needs to pass.

## 2. Fix what is missing (tell the human to run)
- **agent-deck not installed** (macOS, Node.js 20+ and npm required). This is the managed install: a launcher in `~/.local/bin/agent-deck` and versions under `~/.agent-deck/`.
  ```sh
  npx @agent-deck/cli@latest install
  export PATH="$HOME/.local/bin:$PATH"
  ```
- **Older than 2.1.0:** `agent-deck upgrade` (or `agent-deck upgrade --to <version>`).
- **Daemon not running:** `agent-deck start --daemon`.
- **doctor reports harness repairs:** run the `agent-deck setup --client <client>` line it prints, then restart that host.
- **Client CLI missing or signed out:** install it and sign in with its own flow:
  - Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup, then run `claude` and log in.
  - Codex: https://developers.openai.com/codex/cli, then `codex login`.
  - Cursor CLI: https://cursor.com/docs/cli/installation, then `cursor-agent login`.
  - muse: install per your muse distribution, then `muse login`.
- **No deck:** create one in the dashboard (`agent-deck open` → My Decks → create a deck → drag cards from My Collection), or import an export: `agent-deck import <file>.agent-deck.json`.

## 3. Bind each working folder
```sh
cd <dir> && agent-deck use <deck> --client <client>
```
Writes `.agent-deck/use.json` and the client's MCP config. `agent-deck run` refuses to start in an unbound folder.

Re-run step 1 and report what passed.
