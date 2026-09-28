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
agent-deck setup --client claude   # or: --client cursor (once per machine)
cd /path/to/a/sample/repo
agent-deck use friend
```

Restart the host after `setup` so it picks up the Agent Deck connection.
Verify: open a session in that workspace and confirm the terminal footer shows `◆ friend · …`.

## 5. Install and open Dealer, configure agents

Install Agent Dealer following [its README](https://github.com/not-so-fat/agent-dealer), then:

```bash
agent-dealer setup
```

In Dealer, connect the **developer** and **reviewer** agents and choose a GitHub repository.
A fresh Dealer home shows a compact **First issue** strip that points at whichever of these is still missing — follow it until it stops pointing at Agents.
Verify: Dealer shows its developer/reviewer agents as connected.

## 6. Authenticate `gh`, create one small issue

```bash
gh auth status
```

Then in Dealer: **New issue**, pick the repository, and write one small task.
Verify: the issue appears in the Dealer queue — open it to see it in the timeline.

## If you get stuck (two notes, nothing more)

- **Typed `http://127.0.0.1:1111` and see “Open your dashboard securely”?**
  Nothing is broken — that address alone can never sign anyone in.
  Click **Open dashboard**, or run `agent-deck open` in your terminal.
- **Dealer asks about a worktree or policy gate?**
  Read the short question and take the primary action (e.g. **Resume safely**).
  Open **Details** only when you need the paths, exact commands, or logs.
