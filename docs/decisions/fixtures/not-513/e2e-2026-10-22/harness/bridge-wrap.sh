#!/bin/sh
. /tmp/not513-e2e/env.sh
echo "$(node -e 'console.log(new Date().toISOString())') bridge spawn CLAUDE_CODE_SESSION_ID=$CLAUDE_CODE_SESSION_ID cwd=$(pwd)" >> /tmp/not513-e2e/logs/claude-bridge.log
exec /tmp/not513-e2e/scripts/ad mcp-launch 2>> /tmp/not513-e2e/logs/claude-bridge.log
