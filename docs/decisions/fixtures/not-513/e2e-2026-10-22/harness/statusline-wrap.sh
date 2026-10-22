#!/bin/sh
# Real agent-deck statusline from this branch, logging each render.
. /tmp/not513-e2e/env.sh
IN=$(cat)
T=$(date -u +%H:%M:%S.%3N 2>/dev/null || date -u +%H:%M:%S)
T=$(node -e 'console.log(new Date().toISOString())')
SID=$(printf '%s' "$IN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).session_id||"")}catch{console.log("")}})')
OUT=$(printf '%s' "$IN" | /tmp/not513-e2e/scripts/ad statusline)
WS=$(printf '%s' "$IN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(encodeURIComponent(j.workspace?.current_dir||j.cwd))}catch{console.log("")}})')
OLD=$(curl -s "http://127.0.0.1:8513/api/scope/display?workspaceRoot=$WS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).data.displayLine)}catch{console.log("?")}})')
printf '%s\tstdin.session_id=%s\tenv.CLAUDE_CODE_SESSION_ID=%s\tSTATUSLINE=%s\tfolder-only(no id)=%s\n' "$T" "$SID" "$CLAUDE_CODE_SESSION_ID" "$OUT" "$OLD" >> /tmp/not513-e2e/logs/statusline-renders.tsv
printf '%s\n' "$OUT"
