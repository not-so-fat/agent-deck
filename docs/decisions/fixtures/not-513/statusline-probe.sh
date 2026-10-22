#!/bin/bash
# Throwaway status line command: logs env + stdin, prints dummy line.
LOG=/tmp/not513-probe/statusline-probe.log
STDIN_DATA=$(cat)
{
  echo "=== $(date -u +%FT%TZ) pid=$$ ==="
  echo "--- stdin ---"
  echo "$STDIN_DATA"
  echo "--- session-like env ---"
  env | grep -iE 'session|claude|mcp|task|workspace|transcript|run|agent' | sort
  echo "--- all env names ---"
  env | cut -d= -f1 | sort
} >> "$LOG" 2>&1
echo "◆ probe line"
