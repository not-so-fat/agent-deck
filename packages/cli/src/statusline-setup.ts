import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readJsonFile, writeJsonFile } from './mcp-config';
import { sanitizeJsonText } from './strip-ansi';

export const STATUSLINE_SCRIPT_NAME = 'statusline.sh';

export type StatuslineClient = 'cursor' | 'claude';

export type StatuslineInstallResult = {
  installed: boolean;
  configPath: string;
  scriptPath: string;
  action: 'created' | 'updated' | 'unchanged';
  message: string;
};

function resolveStatuslineScriptPath(): string {
  return path.join(os.homedir(), '.agent-deck', 'bin', STATUSLINE_SCRIPT_NAME);
}

function resolveSetupCliBin(): string {
  const candidates = [
    path.join(__dirname, 'bin.js'),
    path.join(__dirname, '..', 'dist', 'bin.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

function buildStatuslineScript(setupCliBin: string): string {
  const bakedSetupCli = setupCliBin
    ? `
SETUP_CLI="${setupCliBin}"
if [ -f "$SETUP_CLI" ]; then
  exec "$NODE_BIN" "$SETUP_CLI" statusline "$@"
fi
`
    : '';

  return `#!/usr/bin/env bash
# Agent Deck status line — installed by agent-deck setup
set -euo pipefail

export NO_COLOR=1
export FORCE_COLOR=0
export NPM_CONFIG_COLOR=false

MANAGED_LAUNCHER="\${HOME}/.local/bin/agent-deck"
if [ -x "$MANAGED_LAUNCHER" ]; then
  exec "$MANAGED_LAUNCHER" statusline "$@"
fi

MANAGED_BIN="\${AGENT_DECK_HOME:-$HOME/.agent-deck}/current/node_modules/@agent-deck/cli/dist/bin.js"
if [ -f "$MANAGED_BIN" ]; then
  NODE_BIN="\${NODE_BIN:-}"
  if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  fi
  exec "\${NODE_BIN:-node}" "$MANAGED_BIN" statusline "$@"
fi

NODE_BIN="\${NODE_BIN:-}"
if [ -z "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi
if [ -z "$NODE_BIN" ] && [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN=/opt/homebrew/bin/node
fi
if [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node ]; then
  NODE_BIN=/usr/local/bin/node
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN=node
fi
# Prefer the CLI that installed this script before PATH agent-deck.
# PATH often has an absolute ~/.local/bin/agent-deck from another HOME; with a
# fresh HOME (release-smoke / tests) that launcher prints nothing useful.
${bakedSetupCli}
if command -v agent-deck >/dev/null 2>&1; then
  exec agent-deck statusline "$@"
fi

# npm root can fail (missing npm, broken prefix) — must not abort under set -e
NPM_ROOT="$(npm root -g 2>/dev/null || true)"
GLOBAL_CLI="\${NPM_ROOT}/@agent-deck/cli/dist/bin.js"
if [ -n "$NPM_ROOT" ] && [ -f "$GLOBAL_CLI" ]; then
  exec "$NODE_BIN" "$GLOBAL_CLI" statusline "$@"
fi

export NPM_CONFIG_FETCH_TIMEOUT=10000
export NPM_CONFIG_FETCH_RETRIES=1
if command -v npx >/dev/null 2>&1; then
  exec npx -y @agent-deck/cli@latest statusline "$@" 2>/dev/null
fi

# Host contract: always one ◆ line, exit 0 (never fail the IDE statusline).
printf '%s\\n' '◆ Agent Deck offline'
exit 0
`;
}

export function installStatuslineScript(): { scriptPath: string; action: 'created' | 'updated' | 'unchanged' } {
  const scriptPath = resolveStatuslineScriptPath();
  const next = buildStatuslineScript(resolveSetupCliBin());
  const existing = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, next, { encoding: 'utf8', mode: 0o755 });

  return {
    scriptPath,
    action: existing === next ? 'unchanged' : existing ? 'updated' : 'created',
  };
}

function resolveStatuslineConfigPath(client: StatuslineClient): string {
  const home = os.homedir();
  if (client === 'cursor') {
    return path.join(home, '.cursor', 'cli-config.json');
  }
  return path.join(home, '.claude', 'settings.json');
}

function buildStatuslineConfig(scriptPath: string, client: StatuslineClient): Record<string, unknown> {
  const base = {
    type: 'command',
    command: scriptPath,
    padding: 2,
  };

  if (client === 'cursor') {
    return {
      ...base,
      timeoutMs: 1500,
    };
  }

  return base;
}

function mergeStatuslineConfig(
  existing: Record<string, unknown>,
  scriptPath: string,
  client: StatuslineClient,
): { config: Record<string, unknown>; changed: boolean } {
  const nextStatusLine = buildStatuslineConfig(scriptPath, client);
  const current = existing.statusLine;
  const currentRecord =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : undefined;
  const hasStaleRefresh = typeof currentRecord?.refreshInterval === 'number';
  const unchanged =
    !hasStaleRefresh &&
    currentRecord &&
    currentRecord.command === nextStatusLine.command &&
    currentRecord.type === nextStatusLine.type;

  if (unchanged) {
    return { config: existing, changed: false };
  }

  return {
    config: {
      ...existing,
      statusLine: nextStatusLine,
    },
    changed: true,
  };
}

export function installStatusline(client: StatuslineClient): StatuslineInstallResult {
  const { scriptPath, action: scriptAction } = installStatuslineScript();
  const configPath = resolveStatuslineConfigPath(client);
  const existing = readJsonFile(configPath);
  const { config, changed } = mergeStatuslineConfig(existing, scriptPath, client);

  if (changed) {
    writeJsonFile(configPath, config);
  }

  const configAction = changed ? (Object.keys(existing).length ? 'updated' : 'created') : 'unchanged';

  const finalAction: StatuslineInstallResult['action'] =
    scriptAction === 'created' || configAction === 'created'
      ? 'created'
      : scriptAction === 'unchanged' && configAction === 'unchanged'
        ? 'unchanged'
        : 'updated';

  const hostLabel = client === 'cursor' ? 'Cursor CLI' : 'Claude Code';

  return {
    installed: true,
    configPath,
    scriptPath,
    action: finalAction,
    message:
      finalAction === 'unchanged'
        ? `Status line already configured for ${hostLabel} → ${configPath}`
        : `Installed deck status line for ${hostLabel} → ${configPath} (command: ${scriptPath})`,
  };
}
