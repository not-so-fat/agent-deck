#!/bin/bash
LOG=/tmp/not513-probe/hook-probe.log
{
  echo "=== $(date -u +%FT%TZ) pid=$$ ==="
  echo "--- stdin ---"
  cat
  echo "--- session env ---"
  env | grep -E '^(CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_CHILD_SESSION|CLAUDECODE|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|MUSE_SESSION_ID)=' | sort
} >> "$LOG" 2>&1
exit 0
