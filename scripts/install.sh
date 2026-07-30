#!/usr/bin/env bash
# Managed install for Agent Deck — does not migrate decks/credentials (same ~/.agent-deck data home).
set -euo pipefail

export AGENT_DECK_HOME="${AGENT_DECK_HOME:-$HOME/.agent-deck}"
mkdir -p "$HOME/.local/bin"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install from https://nodejs.org/ then re-run." >&2
  exit 1
fi

echo "Installing Agent Deck into $AGENT_DECK_HOME (existing data kept) ..."
npx --yes @agent-deck/cli@latest install "$@"

echo ""
echo "Ensure ~/.local/bin is on your PATH, then:"
echo "  agent-deck doctor"
echo "  agent-deck setup --client cursor --start   # or: --client claude"
