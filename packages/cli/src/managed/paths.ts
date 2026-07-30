import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function agentDeckHome(): string {
  return process.env.AGENT_DECK_HOME?.trim() || path.join(os.homedir(), '.agent-deck');
}

export function versionsDir(): string {
  return path.join(agentDeckHome(), 'versions');
}

export function versionDir(version: string): string {
  return path.join(versionsDir(), version);
}

export function partialVersionDir(version: string): string {
  return path.join(versionsDir(), `.partial-${version}`);
}

export function currentLinkPath(): string {
  return path.join(agentDeckHome(), 'current');
}

export function updateStatePath(): string {
  return path.join(agentDeckHome(), 'update-state.json');
}

/** Override with AGENT_DECK_LOCAL_BIN for tests. */
export function localBinDir(): string {
  const override = process.env.AGENT_DECK_LOCAL_BIN?.trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), '.local', 'bin');
}

export function localBinLauncherPath(): string {
  return path.join(localBinDir(), 'agent-deck');
}

export function cliEntryInVersionDir(dir: string): string {
  return path.join(dir, 'node_modules', '@agent-deck', 'cli', 'dist', 'bin.js');
}

export function resolveCurrentVersionDir(): string | null {
  const link = currentLinkPath();
  try {
    if (!fs.existsSync(link)) {
      return null;
    }
    return fs.realpathSync(link);
  } catch {
    return null;
  }
}
