#!/bin/bash
# NOT-135 manual smoke: four stop methods + a failed start, in an isolated home.
set -u
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CLI="node $REPO/packages/cli/dist/bin.js"
export AGENT_DECK_HOME=/tmp/not135-home
export AGENT_DECK_BACKEND_PORT=18111
export AGENT_DECK_MCP_PORT=18112
rm -rf "$AGENT_DECK_HOME"
mkdir -p "$AGENT_DECK_HOME"
LOG="$AGENT_DECK_HOME/logs/supervisor.log"

banner() { printf '\n========== %s ==========\n' "$1"; }

banner "1. start --daemon, then agent-deck stop"
$CLI start --daemon --no-open >/dev/null 2>&1
sleep 1
$CLI stop >/dev/null 2>&1
grep "shutting down" "$LOG" | tail -1

banner "2. start --daemon, then kill -TERM <supervisor pid>"
$CLI start --daemon --no-open >/dev/null 2>&1
sleep 1
PID=$(node -e "process.stdout.write(String(require('$AGENT_DECK_HOME/run.json').cliPid))")
kill -TERM "$PID"
sleep 2
grep "shutting down" "$LOG" | tail -1

banner "3. foreground start (inherit mode), then SIGINT (Ctrl-C)"
$CLI start --no-open > /tmp/not135-fg.log 2>&1 &
FG=$!
sleep 8
kill -INT "$FG"
sleep 2
grep -E "shutting down" /tmp/not135-fg.log | tail -1

banner "4. start --daemon, then a menubar-style stop"
$CLI start --daemon --no-open >/dev/null 2>&1
sleep 1
AGENT_DECK_STOP_SOURCE=menubar AGENT_DECK_STOP_DETAIL="Quit Agent Deck" $CLI stop >/dev/null 2>&1
grep "shutting down" "$LOG" | tail -1

banner "5. agent-deck status (last stop reason)"
$CLI status 2>/dev/null | sed -n '/Last stop/,+4p'

banner "6. failed start: backend cannot open its database"
mkdir -p "$AGENT_DECK_HOME/broken.db"
AGENT_DECK_DB_PATH="$AGENT_DECK_HOME/broken.db" $CLI start --daemon --no-open 2>&1 | tail -20
banner "6b. supervisor.log tail after the failed start"
tail -20 "$LOG"
banner "6c. backend.log tail after the failed start"
tail -8 "$AGENT_DECK_HOME/logs/backend.log"
banner "6d. agent-deck status after the failed start (stop vs failed start)"
$CLI status 2>/dev/null | sed -n '/Last stop/,+9p'

banner "7. stop that lands mid-startup (before run.json exists)"
# run.json only exists once the deck is up, so a daemon start gives this script
# no pid it can trust. Start in the foreground instead: that process *is* the
# supervisor, so $! is exactly the pid to signal and nothing else can match.
#
# Never discover the target by argv. `pgrep -f -- "--_supervisor"` scans every
# process on the host, and on 2026-09-17 that sweep stopped the developer's own
# Agent Deck three times, parking every other issue on the machine. A port
# filter layered on top is not a fix: it fails open the moment it is wrong.
$CLI start --no-open --port "$AGENT_DECK_BACKEND_PORT" --mcp-port "$AGENT_DECK_MCP_PORT" >/dev/null 2>&1 &
SUPERVISOR=$!
sleep 0.2
kill -TERM "$SUPERVISOR" 2>/dev/null
wait "$SUPERVISOR" 2>/dev/null
sleep 1
grep -E "shutting down|start failed" "$LOG" | tail -2
$CLI stop >/dev/null 2>&1

banner "cleanup"
$CLI stop >/dev/null 2>&1
echo done
