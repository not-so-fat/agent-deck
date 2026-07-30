import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MENUBAR_PLUGIN_NAME = 'agent-deck.3s.sh';

export const SWIFTBAR_FALLBACK_PLUGIN_DIR = path.join(
  os.homedir(),
  '.agent-deck',
  'swiftbar-plugins',
);

export type MenubarInstallResult = {
  installed: true;
  pluginPath: string;
  action: 'created' | 'updated' | 'unchanged';
  message: string;
  hints: string[];
  swiftbar?: {
    installed: boolean;
    pluginDirSource: 'env' | 'swiftbar-config' | 'fallback';
    pluginDirConfigured?: boolean;
  };
};

export function isDarwinPlatform(): boolean {
  return process.platform === 'darwin';
}

export function isSwiftBarInstalled(): boolean {
  return (
    fs.existsSync('/Applications/SwiftBar.app') ||
    fs.existsSync(path.join(os.homedir(), 'Applications', 'SwiftBar.app'))
  );
}

export function isBrewAvailable(): boolean {
  try {
    execFileSync('brew', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** Write SwiftBar's PluginDirectory so the app loads our plugin folder without manual prefs. */
export function configureSwiftBarPluginDir(dir: string): boolean {
  if (!isDarwinPlatform()) {
    return false;
  }
  try {
    execFileSync('defaults', ['write', 'com.ameba.SwiftBar', 'PluginDirectory', dir], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveSwiftBarPluginDir(): {
  dir: string;
  source: 'env' | 'swiftbar-config' | 'fallback';
} {
  const envDir = process.env.AGENT_DECK_SWIFTBAR_DIR?.trim();
  if (envDir) {
    return { dir: envDir, source: 'env' };
  }

  try {
    const configured = execFileSync(
      'defaults',
      ['read', 'com.ameba.SwiftBar', 'PluginDirectory'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (configured) {
      return { dir: configured, source: 'swiftbar-config' };
    }
  } catch {
    // SwiftBar not installed or not configured yet.
  }

  return { dir: SWIFTBAR_FALLBACK_PLUGIN_DIR, source: 'fallback' };
}

/** Install SwiftBar via Homebrew when missing (interactive dev/setup only). */
export function ensureSwiftBarViaBrew(): { ok: boolean; message: string } {
  if (!isDarwinPlatform()) {
    return { ok: false, message: 'SwiftBar is macOS-only' };
  }
  if (isSwiftBarInstalled()) {
    return { ok: true, message: 'SwiftBar already installed' };
  }
  if (!isBrewAvailable()) {
    return {
      ok: false,
      message: 'Homebrew not found — install SwiftBar: brew install --cask swiftbar',
    };
  }

  const result = spawnSync('brew', ['install', '--cask', 'swiftbar'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      message: 'brew install --cask swiftbar failed — install SwiftBar from https://swiftbar.app',
    };
  }
  if (!isSwiftBarInstalled()) {
    return {
      ok: true,
      message: 'SwiftBar installed — open SwiftBar.app from Applications if the menu bar icon does not appear',
    };
  }
  return { ok: true, message: 'Installed SwiftBar via Homebrew' };
}

export function shouldTryInstallSwiftBar(options?: { tryInstallSwiftBar?: boolean }): boolean {
  if (options?.tryInstallSwiftBar === false) {
    return false;
  }
  if (options?.tryInstallSwiftBar === true) {
    return true;
  }
  if (!isDarwinPlatform() || process.env.CI === 'true' || process.env.CI === '1') {
    return false;
  }
  if (process.env.AGENT_DECK_SETUP_NO_BREW === '1') {
    return false;
  }
  return Boolean(process.stdin.isTTY);
}

function resolveSetupCliBin(): string {
  const candidates = [
    path.join(__dirname, 'bin.js'),
    path.join(__dirname, '..', 'dist', 'bin.js'),
    path.join(__dirname, 'bin.ts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return '';
}

function buildMenubarScript(setupCliBin: string): string {
  const bakedSetupCli = setupCliBin
    ? `
SETUP_CLI="${setupCliBin.replace(/"/g, '\\"')}"
run_setup_cli() {
  if [ ! -f "$SETUP_CLI" ]; then
    return 1
  fi
  if [[ "$SETUP_CLI" == *.ts ]]; then
    if command -v tsx >/dev/null 2>&1; then
      exec tsx "$SETUP_CLI" menubar
    fi
    if [ -x /opt/homebrew/bin/npx ]; then
      exec /opt/homebrew/bin/npx tsx "$SETUP_CLI" menubar
    fi
    exec npx tsx "$SETUP_CLI" menubar
  fi
  exec "$NODE_BIN" "$SETUP_CLI" menubar
}
`
    : '';

  return `#!/usr/bin/env bash
# <xbar.title>Agent Deck</xbar.title>
# <xbar.desc>Live deck binds per MCP session (badge = join key to the chat opener)</xbar.desc>
# Agent Deck menu bar plugin — installed by agent-deck setup --menubar
set -euo pipefail

export NO_COLOR=1
export FORCE_COLOR=0
export NPM_CONFIG_COLOR=false

# Prefer dev backend when npm run dev:all is up (:8000 before :1111)
if curl -sf --max-time 0.4 http://127.0.0.1:8000/health >/dev/null 2>&1; then
  export AGENT_DECK_DEV=1
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
${bakedSetupCli}
if [ -n "\${SETUP_CLI:-}" ]; then
  run_setup_cli || true
fi

MANAGED_LAUNCHER="\${HOME}/.local/bin/agent-deck"
if [ -x "$MANAGED_LAUNCHER" ]; then
  exec "$MANAGED_LAUNCHER" menubar
fi

MANAGED_BIN="\${AGENT_DECK_HOME:-$HOME/.agent-deck}/current/node_modules/@agent-deck/cli/dist/bin.js"
if [ -f "$MANAGED_BIN" ]; then
  exec "$NODE_BIN" "$MANAGED_BIN" menubar
fi

GLOBAL_CLI="$(npm root -g 2>/dev/null)/@agent-deck/cli/dist/bin.js"
if [ -f "$GLOBAL_CLI" ]; then
  exec "$NODE_BIN" "$GLOBAL_CLI" menubar
fi

if command -v agent-deck >/dev/null 2>&1; then
  exec agent-deck menubar
fi

echo "◆ off | color=gray"
echo "---"
echo "Update CLI (menubar needs @agent-deck/cli with menubar support) | color=gray"
echo "Dev: npm link -w @agent-deck/cli  then re-run setup --menubar"
`;
}

export function installMenubarPlugin(): MenubarInstallResult {
  const { dir, source } = resolveSwiftBarPluginDir();
  const pluginPath = path.join(dir, MENUBAR_PLUGIN_NAME);
  const next = buildMenubarScript(resolveSetupCliBin());
  const existing = fs.existsSync(pluginPath) ? fs.readFileSync(pluginPath, 'utf8') : '';

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pluginPath, next, { encoding: 'utf8', mode: 0o755 });

  const action: MenubarInstallResult['action'] =
    existing === next ? 'unchanged' : existing ? 'updated' : 'created';

  const hints: string[] = [];
  if (!isSwiftBarInstalled()) {
    hints.push('Install SwiftBar: brew install --cask swiftbar (or re-run setup in a terminal)');
  } else if (source === 'fallback') {
    hints.push('Restart SwiftBar if the menu bar item does not appear after setup.');
  }

  return {
    installed: true,
    pluginPath,
    action,
    message:
      action === 'unchanged'
        ? `Menu bar plugin already installed → ${pluginPath}`
        : `Installed SwiftBar menu bar plugin → ${pluginPath} (refreshes every 3s)`,
    hints,
    swiftbar: {
      installed: isSwiftBarInstalled(),
      pluginDirSource: source,
    },
  };
}

/** SwiftBar app (optional brew) + plugin dir + plugin script — one setup call. */
export function setupMenubar(options?: { tryInstallSwiftBar?: boolean }): MenubarInstallResult {
  if (!isDarwinPlatform()) {
    return {
      installed: true,
      pluginPath: '',
      action: 'unchanged',
      message: 'Menu bar deck status is macOS-only — skipped',
      hints: [],
    };
  }

  if (shouldTryInstallSwiftBar(options)) {
    const brew = ensureSwiftBarViaBrew();
    console.log(`  ${brew.message}`);
  }

  let { dir, source } = resolveSwiftBarPluginDir();
  let pluginDirConfigured = false;
  if (source === 'fallback') {
    pluginDirConfigured = configureSwiftBarPluginDir(dir);
    if (pluginDirConfigured) {
      const resolved = resolveSwiftBarPluginDir();
      dir = resolved.dir;
      source = resolved.source;
    }
  }

  const result = installMenubarPlugin();
  result.swiftbar = {
    installed: isSwiftBarInstalled(),
    pluginDirSource: source,
    pluginDirConfigured,
  };

  if (pluginDirConfigured) {
    result.hints = result.hints.filter((hint) => !hint.includes('Preferences → Plugin Folder'));
    if (isSwiftBarInstalled()) {
      result.hints.unshift('SwiftBar plugin folder configured — restart SwiftBar if needed');
    }
  }

  if (!isSwiftBarInstalled() && !result.hints.some((h) => h.includes('brew install'))) {
    result.hints.push('Install SwiftBar: brew install --cask swiftbar');
  }

  return result;
}
