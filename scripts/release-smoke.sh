#!/usr/bin/env bash
# Release integration smoke — simulates fresh npm install + setup user path.
# Catches "command shipped, installer/docs not" regressions (see 1.2.3 statusline).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.temporal/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/release-smoke.log"
: >"$LOG"

SMOKE_HOME=""
PACK_DIR=""
cleanup() {
  [[ -n "$SMOKE_HOME" ]] && rm -rf "$SMOKE_HOME"
  [[ -n "$PACK_DIR" ]] && rm -rf "$PACK_DIR"
}
trap cleanup EXIT

fail() {
  echo "[release-smoke] FAIL: $*" | tee -a "$LOG" >&2
  exit 1
}

pass() {
  echo "[release-smoke] $*" | tee -a "$LOG"
}

CLI_DIST="$ROOT_DIR/packages/cli/dist"
if [[ ! -f "$CLI_DIST/bin.js" ]]; then
  fail "CLI not built — run npm run build first ($CLI_DIST/bin.js missing)"
fi

# --- 1. Tarball must include installer modules ---
for required in bin.js statusline.js statusline-setup.js setup.js install.js muse-skills.js agent-harness.js; do
  if [[ ! -f "$CLI_DIST/$required" ]]; then
    fail "dist/$required missing from CLI build (would not ship on npm)"
  fi
done
for required in managed/paths.js managed/activate.js managed/updater.js managed/npm-prefix-install.js; do
  if [[ ! -f "$CLI_DIST/$required" ]]; then
    fail "dist/$required missing from CLI build (managed install)"
  fi
done
for skill in agent-deck-session agent-deck-playbooks agent-deck-setup; do
  if [[ ! -f "$CLI_DIST/muse-skills/$skill/SKILL.md" ]]; then
    fail "dist/muse-skills/$skill/SKILL.md missing from CLI build (run npm run build)"
  fi
done
pass "CLI dist contains statusline + setup + managed install modules + muse skills"

# --- 2. npm pack fidelity ---
PACK_DIR="$(mktemp -d)"
SMOKE_HOME="$(mktemp -d)"
export HOME="$SMOKE_HOME"
export NO_COLOR=1

cd "$ROOT_DIR/packages/cli"
TGZ_NAME="$(npm pack --pack-destination "$PACK_DIR" 2>>"$LOG" | tail -1)"
TGZ_PATH="$PACK_DIR/$TGZ_NAME"
[[ -f "$TGZ_PATH" ]] || fail "npm pack failed — $TGZ_PATH"
tar -xzf "$TGZ_PATH" -C "$PACK_DIR"
PKG_ROOT="$PACK_DIR/package"
[[ -f "$PKG_ROOT/dist/statusline-setup.js" ]] || fail "packed tarball missing dist/statusline-setup.js"
pass "npm pack includes statusline-setup.js"

# --- 2b. Packed tarball ships Muse skills byte-identical to canonical sources ---
for skill in agent-deck-session agent-deck-playbooks agent-deck-setup; do
  PACKED_SKILL="$PKG_ROOT/dist/muse-skills/$skill/SKILL.md"
  CANONICAL_SKILL="$ROOT_DIR/skills/$skill/SKILL.md"
  [[ -f "$PACKED_SKILL" ]] || fail "packed tarball missing dist/muse-skills/$skill/SKILL.md"
  if ! cmp -s "$PACKED_SKILL" "$CANONICAL_SKILL"; then
    fail "packed dist/muse-skills/$skill/SKILL.md differs from canonical skills/$skill/SKILL.md"
  fi
done
pass "packed tarball muse skills match canonical sources"

# --- 3. setup --client claude in clean HOME (built dist = tarball payload) ---
SETUP_OUT="$LOG_DIR/release-smoke-setup.log"
if ! node "$CLI_DIST/bin.js" setup --client claude --no-menubar >"$SETUP_OUT" 2>&1; then
  # claude mcp add may fail in CI — status line install must still run
  if ! grep -qE 'Status line|status line' "$SETUP_OUT"; then
    cat "$SETUP_OUT" >>"$LOG"
    fail "setup --client claude did not install status line (see $SETUP_OUT)"
  fi
fi
pass "setup --client claude ran (see $SETUP_OUT)"

SCRIPT_PATH="$SMOKE_HOME/.agent-deck/bin/statusline.sh"
SETTINGS_PATH="$SMOKE_HOME/.claude/settings.json"

[[ -x "$SCRIPT_PATH" ]] || fail "statusline.sh not created or not executable: $SCRIPT_PATH"
pass "statusline.sh exists: $SCRIPT_PATH"

[[ -f "$SETTINGS_PATH" ]] || fail "Claude settings not written: $SETTINGS_PATH"
if ! grep -q '"statusLine"' "$SETTINGS_PATH"; then
  fail "settings.json missing statusLine block"
fi
if ! grep -q "$SCRIPT_PATH" "$SETTINGS_PATH"; then
  fail "settings.json statusLine.command does not point at $SCRIPT_PATH"
fi
pass "settings.json wires statusLine → script"

# --- 4. Wrapper script contract ---
SCRIPT_BODY="$(<"$SCRIPT_PATH")"
if ! grep -q 'NO_COLOR=1' <<<"$SCRIPT_BODY"; then
  fail "statusline.sh missing NO_COLOR=1 (npm warnings can break Claude footer)"
fi
if ! grep -q '2>/dev/null' <<<"$SCRIPT_BODY"; then
  fail "statusline.sh npx fallback must redirect stderr (npm warn on stdout)"
fi
pass "wrapper script has NO_COLOR + stderr redirect"

# --- 5. Stdout contract (single line, no npm noise) ---
STATUS_OUT="$LOG_DIR/release-smoke-statusline.out"
echo '{"cwd":"/tmp/smoke-workspace"}' | "$SCRIPT_PATH" >"$STATUS_OUT" 2>>"$LOG" || true
LINE_COUNT="$(grep -c . "$STATUS_OUT" || true)"
[[ "$LINE_COUNT" -eq 1 ]] || fail "statusline must print exactly one line on stdout (got $LINE_COUNT)"
if grep -qi 'npm warn' "$STATUS_OUT"; then
  fail "npm warning leaked to stdout — host apps may show blank status"
fi
if ! grep -q '^◆' "$STATUS_OUT"; then
  fail "statusline output must start with ◆ (got: $(cat "$STATUS_OUT"))"
fi
pass "statusline stdout (closed stdin): $(cat "$STATUS_OUT")"

# --- 5b. Claude host POC: stdin left open (must not hang) ---
OPEN_OUT="$LOG_DIR/release-smoke-statusline-open-stdin.out"
OPEN_ERR="$LOG_DIR/release-smoke-statusline-open-stdin.err"
if ! node -e "
const { spawn } = require('child_process');
const fs = require('fs');
const script = process.argv[1];
const outPath = process.argv[2];
const errPath = process.argv[3];
const budgetMs = 1500;
const hardMs = 2000;
const start = Date.now();
const child = spawn(script, [], {
  env: {
    ...process.env,
    NO_COLOR: '1',
    AGENT_DECK_PORT: '59999',
    AGENT_DECK_STATUSLINE_TIMEOUT_MS: '50',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
child.stdin.write('{\"cwd\":\"/tmp/smoke-open-stdin\"}');
const timer = setTimeout(() => {
  child.kill('SIGKILL');
  process.exit(2);
}, hardMs);
child.on('close', (code) => {
  clearTimeout(timer);
  fs.writeFileSync(outPath, stdout);
  if (stderr) fs.writeFileSync(errPath, stderr);
  const ms = Date.now() - start;
  if (code !== 0 || ms > budgetMs) process.exit(1);
  process.exit(0);
});
" "$SCRIPT_PATH" "$OPEN_OUT" "$OPEN_ERR" 2>>"$LOG"; then
  fail "statusline hung with open stdin (Claude POC) — see $OPEN_ERR"
fi
OPEN_LINES="$(grep -c . "$OPEN_OUT" || true)"
[[ "$OPEN_LINES" -eq 1 ]] || fail "open-stdin POC must print one line (got $OPEN_LINES)"
pass "statusline stdout (open stdin POC): $(cat "$OPEN_OUT")"

# --- 5c. Harness uses 1.3.0+ MCP tool names (S1) ---
HARNESS_OUT="$LOG_DIR/release-smoke-harness.log"
if ! node "$CLI_DIST/bin.js" setup --client cursor --no-menubar --no-statusline >"$HARNESS_OUT" 2>&1; then
  # setup may warn on mcp add; harness file must still be written
  if ! grep -qE 'harness|agent-deck.mdc|Harness' "$HARNESS_OUT"; then
    cat "$HARNESS_OUT" >>"$LOG"
    fail "setup --client cursor did not install harness (see $HARNESS_OUT)"
  fi
fi
CURSOR_RULE="$SMOKE_HOME/.cursor/rules/agent-deck.mdc"
[[ -f "$CURSOR_RULE" ]] || fail "Cursor harness missing: $CURSOR_RULE"
if ! grep -q 'get_bound_deck' "$CURSOR_RULE"; then
  fail "Cursor harness must mention get_bound_deck (got outdated tool names)"
fi
if grep -qE 'list_playbooks|list_bound_deck_services|add_service_to_bound_deck|setup_repo_deck' "$CURSOR_RULE"; then
  fail "Cursor harness still names removed MCP tools — refresh agent-harness.ts"
fi
pass "Cursor harness uses get_bound_deck (no removed tool names)"

# --- 5d. Muse setup in clean HOME installs skills + MCP settings (NOT-388) ---
unset XDG_CONFIG_HOME
MUSE_SETUP_OUT="$LOG_DIR/release-smoke-muse-setup.log"
if ! node "$CLI_DIST/bin.js" setup --client muse --no-menubar >"$MUSE_SETUP_OUT" 2>&1; then
  cat "$MUSE_SETUP_OUT" >>"$LOG"
  fail "setup --client muse failed (see $MUSE_SETUP_OUT)"
fi
pass "setup --client muse ran (see $MUSE_SETUP_OUT)"

MUSE_SETTINGS="$SMOKE_HOME/.config/muse/settings.json"
[[ -f "$MUSE_SETTINGS" ]] || fail "Muse settings not written: $MUSE_SETTINGS"
if ! grep -q '"schema_version": 1' "$MUSE_SETTINGS"; then
  fail "Muse settings.json missing schema_version 1"
fi
if ! grep -q 'mcp-launch' "$MUSE_SETTINGS"; then
  fail "Muse settings.json missing agent-deck mcp-launch entry"
fi
pass "Muse settings wire agent-deck mcp-launch"

for skill in agent-deck-session agent-deck-playbooks agent-deck-setup; do
  SKILL_PATH="$SMOKE_HOME/.config/muse/skills/$skill/SKILL.md"
  [[ -f "$SKILL_PATH" ]] || fail "Muse skill missing: $SKILL_PATH"
  if ! grep -q "name: $skill" "$SKILL_PATH"; then
    fail "Muse skill $skill missing frontmatter name"
  fi
  if ! grep -q 'agent-deck:managed-skill' "$SKILL_PATH"; then
    fail "Muse skill $skill missing managed stamp"
  fi
done
pass "Muse bootstrap skills installed under .config/muse/skills"

if ! grep -q 'agent-deck use <deck> --client muse' "$MUSE_SETUP_OUT"; then
  fail "muse next steps must mention agent-deck use <deck> --client muse"
fi
if ! grep -q '/mcp' "$MUSE_SETUP_OUT"; then
  fail "muse next steps must mention /mcp verification"
fi
if ! grep -qi 'workspace trust' "$MUSE_SETUP_OUT"; then
  fail "muse next steps must mention workspace trust"
fi
if ! grep -q 'new Muse process' "$MUSE_SETUP_OUT"; then
  fail "muse next steps must mention starting a new Muse process"
fi
if ! grep -q 'get_session_context' "$MUSE_SETUP_OUT"; then
  fail "muse next steps must mention the first-turn get_session_context receipt"
fi
pass "muse next steps cover use, trust, reload, /mcp, and receipt"

# Idempotent: second run changes no Muse bytes.
MUSE_BEFORE="$LOG_DIR/release-smoke-muse-before.sha"
(find "$SMOKE_HOME/.config/muse" -type f -exec sha256sum {} + | sort) >"$MUSE_BEFORE"
if ! node "$CLI_DIST/bin.js" setup --client muse --no-menubar >"$MUSE_SETUP_OUT" 2>&1; then
  cat "$MUSE_SETUP_OUT" >>"$LOG"
  fail "second setup --client muse failed (see $MUSE_SETUP_OUT)"
fi
MUSE_AFTER="$LOG_DIR/release-smoke-muse-after.sha"
(find "$SMOKE_HOME/.config/muse" -type f -exec sha256sum {} + | sort) >"$MUSE_AFTER"
if ! cmp -s "$MUSE_BEFORE" "$MUSE_AFTER"; then
  fail "second setup --client muse changed Muse files (must be idempotent)"
fi
pass "second muse setup changed no bytes"

# --- 5e. CLI help + docs show the Muse flow and deny a status line/plugin ---
HELP_OUT="$LOG_DIR/release-smoke-help.log"
node "$CLI_DIST/bin.js" setup --help >"$HELP_OUT" 2>&1 || fail "setup --help failed"
if ! grep -q 'agent-deck setup --client muse' "$HELP_OUT"; then
  fail "CLI help must show agent-deck setup --client muse"
fi
if ! grep -q 'No Muse status line' "$HELP_OUT"; then
  fail "CLI help must state there is no Muse status line"
fi
if grep -qE 'Muse status line installed|install the Muse plugin|Muse plugin marketplace' "$HELP_OUT"; then
  fail "CLI help must not claim a Muse status line or plugin install"
fi
pass "CLI help shows muse setup and denies status line/plugin"

README="$ROOT_DIR/README.md"
HARNESS_DOC="$ROOT_DIR/docs/AGENT_HARNESS.md"
for doc in "$README" "$HARNESS_DOC"; do
  if ! grep -q 'agent-deck setup --client muse' "$doc"; then
    fail "$doc must show agent-deck setup --client muse"
  fi
  if ! grep -q 'agent-deck use.*--client muse' "$doc"; then
    fail "$doc must show agent-deck use <deck> --client muse"
  fi
  if ! grep -q '/mcp' "$doc"; then
    fail "$doc must mention /mcp verification"
  fi
  if ! grep -q 'get_session_context' "$doc"; then
    fail "$doc must mention the first-turn get_session_context receipt"
  fi
  if ! grep -qi 'no .*muse status line\|muse has no .*status line\|there is no muse status line' "$doc"; then
    fail "$doc must state there is no Muse status line"
  fi
  if grep -qE 'Muse status line installed|install the Muse plugin|Muse plugin marketplace' "$doc"; then
    fail "$doc must not claim a Muse status line or plugin install"
  fi
done
if ! grep -q -- '--scope project' "$README"; then
  fail "README must show optional --scope project for muse"
fi
pass "README + AGENT_HARNESS show the muse flow without status line/plugin claims"

# --- 5f. Menubar plugin script contract (any OS; setup skips non-macOS) ---
MENUBAR_DIR="$SMOKE_HOME/swiftbar-plugins"
mkdir -p "$MENUBAR_DIR"
export AGENT_DECK_SWIFTBAR_DIR="$MENUBAR_DIR"
PLUGIN_PATH="$(
  node -e "
    const { installMenubarPlugin } = require('$CLI_DIST/menubar-setup.js');
    const result = installMenubarPlugin();
    if (!result.pluginPath) process.exit(1);
    process.stdout.write(result.pluginPath);
  "
)" || fail "installMenubarPlugin failed"
[[ -f "$PLUGIN_PATH" ]] || fail "menubar plugin missing: $PLUGIN_PATH"
[[ -x "$PLUGIN_PATH" ]] || fail "menubar plugin not executable: $PLUGIN_PATH"
grep -q 'menubar' "$PLUGIN_PATH" || fail "menubar plugin must invoke agent-deck menubar"
if grep -q 'statusline' "$PLUGIN_PATH"; then
  fail "menubar plugin must not call statusline"
fi
pass "menubar plugin installed: $PLUGIN_PATH"

# --- 6. CHANGELOG honesty — fail if current version still has Pending publish for statusline ---
CHANGELOG="$ROOT_DIR/CHANGELOG.md"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
if [[ -f "$CHANGELOG" ]]; then
  awk -v ver="$VERSION" '
    /^## / {
      in_section = ($0 ~ "^## " ver "([ —-]|$)")
      if (!in_section) pending = 0
    }
    in_section && /^### Pending publish/ { pending = 1 }
    in_section && pending && /setup.*status/i { found = 1 }
    END { if (found) exit 1; exit 0 }
  ' "$CHANGELOG" || fail "CHANGELOG $VERSION still lists setup/statusline under Pending publish — ship or move to pending"
fi
pass "CHANGELOG pending section check passed"

# --- 7. Managed install activate (offline; no data wipe) ---
export AGENT_DECK_HOME="$SMOKE_HOME/.agent-deck-managed"
export AGENT_DECK_LOCAL_BIN="$SMOKE_HOME/.local/bin"
mkdir -p "$AGENT_DECK_HOME"
echo 'keep-me' >"$AGENT_DECK_HOME/agent_deck.db"
SMOKE_VER="0.0.0-smoke"
SEED_BIN="$AGENT_DECK_HOME/versions/$SMOKE_VER/node_modules/@agent-deck/cli/dist/bin.js"
mkdir -p "$(dirname "$SEED_BIN")"
echo '#!/usr/bin/env node
console.log("managed-ok")
' >"$SEED_BIN"
node -e "
const { activateVersion } = require('$CLI_DIST/managed/activate.js');
activateVersion('$SMOKE_VER');
" || fail "activateVersion failed"
[[ -L "$AGENT_DECK_HOME/current" ]] || fail "managed current symlink missing"
[[ -x "$AGENT_DECK_LOCAL_BIN/agent-deck" ]] || fail "managed launcher missing"
[[ "$(cat "$AGENT_DECK_HOME/agent_deck.db")" == "keep-me" ]] || fail "managed activate wiped data home"
if ! grep -q 'node_modules/@agent-deck/cli/dist/bin.js' "$AGENT_DECK_LOCAL_BIN/agent-deck"; then
  fail "managed launcher body unexpected"
fi
if ! grep -q '\.local/bin/agent-deck' "$SCRIPT_PATH"; then
  fail "statusline.sh must prefer managed launcher at ~/.local/bin/agent-deck"
fi
pass "managed install activate + statusline prefers launcher"

pass "PASS — release integration smoke (log: $LOG)"
