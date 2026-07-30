import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  activateVersion,
  compareSemver,
  detectInstallKind,
  fetchLatestVersion as fetchLatestManaged,
  installCliVersionToPrefix,
  readCurrentManagedVersion,
  runManagedCliEntryHooks,
} from './managed';
import { getAgentDeckVersion } from './version';

const PACKAGE_NAME = '@agent-deck/cli';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface VersionCache {
  checkedAt: string;
  latest: string;
}

export interface UpgradeCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  fromCache: boolean;
}

function agentDeckHome(): string {
  return process.env.AGENT_DECK_HOME ?? path.join(os.homedir(), '.agent-deck');
}

function cachePath(): string {
  return path.join(agentDeckHome(), 'version-check.json');
}

function readCache(): VersionCache | null {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    return JSON.parse(raw) as VersionCache;
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  fs.mkdirSync(agentDeckHome(), { recursive: true });
  const payload: VersionCache = {
    checkedAt: new Date().toISOString(),
    latest,
  };
  fs.writeFileSync(cachePath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export { compareSemver };

export async function fetchLatestVersion(): Promise<string | null> {
  return fetchLatestManaged();
}

export async function checkForUpgrade(options: { force?: boolean } = {}): Promise<UpgradeCheckResult> {
  const current =
    detectInstallKind() === 'managed'
      ? (readCurrentManagedVersion() ?? getAgentDeckVersion())
      : getAgentDeckVersion();
  const cache = readCache();

  if (!options.force && cache?.latest) {
    const age = Date.now() - Date.parse(cache.checkedAt);
    if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
      return {
        current,
        latest: cache.latest,
        updateAvailable: compareSemver(cache.latest, current) > 0,
        fromCache: true,
      };
    }
  }

  const latest = await fetchLatestVersion();
  if (latest) {
    writeCache(latest);
  }

  return {
    current,
    latest,
    updateAvailable: latest ? compareSemver(latest, current) > 0 : false,
    fromCache: false,
  };
}

function runNpmInstallGlobal(version: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', `${PACKAGE_NAME}@${version}`], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function parseToVersion(args: string[]): string | undefined {
  const idx = args.indexOf('--to');
  if (idx >= 0) {
    return args[idx + 1];
  }
  return undefined;
}

export async function runUpgrade(args: string[]): Promise<number> {
  const checkOnly = args.includes('--check');
  const toVersion = parseToVersion(args);

  if (detectInstallKind() === 'managed') {
    const current = readCurrentManagedVersion() ?? getAgentDeckVersion();
    const latest = toVersion ?? (await fetchLatestVersion());
    if (!latest) {
      console.error('Could not reach npm registry to check for updates.');
      return 1;
    }

    console.log(`Current: ${current}`);
    console.log(`Latest:  ${latest}`);
    console.log('Install: managed');

    if (!toVersion && compareSemver(latest, current) <= 0) {
      console.log('Already on the latest version.');
      return 0;
    }

    if (checkOnly) {
      console.log('Update available. Run: agent-deck upgrade');
      return 0;
    }

    console.log(`Upgrading managed install ${PACKAGE_NAME} → ${latest} ...`);
    const result = await installCliVersionToPrefix(latest);
    if (!result.ok) {
      console.error(`Upgrade failed: ${result.error}`);
      return 1;
    }
    activateVersion(latest);
    console.log('Upgrade complete. Restart any running Agent Deck process.');
    return 0;
  }

  const result = await checkForUpgrade({ force: true });
  const target = toVersion ?? result.latest;

  if (!target) {
    console.error('Could not reach npm registry to check for updates.');
    return 1;
  }

  console.log(`Current: ${result.current}`);
  console.log(`Latest:  ${target}`);
  console.log('Install: npm-global (or unknown)');

  if (!toVersion && !result.updateAvailable) {
    console.log('Already on the latest version.');
    return 0;
  }

  if (checkOnly) {
    console.log('Update available. Run: agent-deck upgrade');
    console.log('Tip: agent-deck install  # managed install with auto-updates (data unchanged)');
    return 0;
  }

  console.log(`Upgrading ${PACKAGE_NAME} → ${target} ...`);
  const code = await runNpmInstallGlobal(target);
  if (code === 0) {
    console.log('Upgrade complete. Restart any running Agent Deck process.');
    console.log('Tip: agent-deck install  # switch CLI binary to managed auto-updates (data unchanged)');
  } else {
    console.error('Upgrade failed. Try manually:');
    console.error(`  npm install -g ${PACKAGE_NAME}@${target}`);
    console.error('Or managed install:');
    console.error(`  npx ${PACKAGE_NAME}@latest install`);
  }

  return code;
}

export async function maybeAutoUpgradeOnStart(): Promise<void> {
  if (detectInstallKind() === 'managed') {
    const { activated } = runManagedCliEntryHooks({ allowActivate: true });
    if (activated) {
      console.log(`[agent-deck] Activated managed version ${activated}`);
    }
    return;
  }

  const enabled =
    process.env.AGENT_DECK_AUTO_UPGRADE === '1' ||
    process.env.AGENT_DECK_AUTO_UPGRADE === 'true';

  if (!enabled) {
    return;
  }

  const result = await checkForUpgrade();
  if (!result.updateAvailable || !result.latest) {
    return;
  }

  console.log(`[agent-deck] Update available: ${result.current} → ${result.latest}`);
  const code = await runNpmInstallGlobal(result.latest);
  if (code !== 0) {
    console.warn('[agent-deck] Auto-upgrade failed; continuing with current version.');
  }
}

export async function notifyIfUpdateAvailable(): Promise<void> {
  if (detectInstallKind() === 'managed') {
    return;
  }

  if (
    process.env.AGENT_DECK_AUTO_UPGRADE === '1' ||
    process.env.AGENT_DECK_AUTO_UPGRADE === 'true' ||
    process.env.AGENT_DECK_NO_UPDATE_CHECK === '1' ||
    process.env.AGENT_DECK_NO_UPDATE_CHECK === 'true'
  ) {
    return;
  }

  const result = await checkForUpgrade();
  if (!result.updateAvailable || !result.latest) {
    return;
  }

  console.log(
    `[agent-deck] Update available: ${result.current} → ${result.latest}  (agent-deck upgrade, or agent-deck install)`,
  );
}
