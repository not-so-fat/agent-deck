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
import {
  reconcileCodexPluginAfterUpgrade,
  type CodexRunner,
} from './codex-plugin';
import { parseCliMcpPort } from './defaults';
import {
  formatLauncherMigrationResults,
  formatScanSummary,
  rewriteLegacyLauncherEntries,
  rewriteScanFolders,
} from './launcher-migration';
import { findAssignedFolders, parseScanDirs } from './upgrade-scan';
import { getAgentDeckVersion } from './version';

export type UpgradeDeps = {
  /** Test seam: replace the real npm/managed CLI install step. */
  performCliUpgrade?: (target: string) => Promise<{ ok: boolean; error?: string }>;
  /** Test seam: Codex CLI runner used for post-upgrade plugin reconciliation. */
  codexRunner?: CodexRunner;
};

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

/**
 * NOT-566/572/576: rewrite any legacy launcher entries in this folder's
 * and the global Codex/Claude/Muse configs to pure MCP before the plugin
 * reconcile, so a hung or failing `codex` step can never block or undo
 * the migration. Best-effort and silent when clean — it never changes
 * the upgrade result, which is still the plugin step's exit code.
 *
 * NOT-577: with `scanDirs` the same pass covers every assigned folder
 * under those roots (including Cursor project entries) and the globals
 * once; the plugin step still runs once per invocation, not per folder.
 */
async function reconcilePluginAndMigrateLauncherEntries(
  expectedVersion: string,
  codexRunner: CodexRunner | undefined,
  options: { alreadyCurrent?: boolean; scanDirs?: string[] } = {},
): Promise<number> {
  try {
    const endpoint = {
      host: process.env.AGENT_DECK_HOST ?? '127.0.0.1',
      mcpPort: parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT),
    };
    if (options.scanDirs && options.scanDirs.length > 0) {
      const folders = findAssignedFolders(options.scanDirs);
      const results = rewriteScanFolders(folders, endpoint);
      for (const line of formatLauncherMigrationResults(results)) {
        console.log(line);
      }
      console.log(formatScanSummary(folders, results));
    } else {
      const results = rewriteLegacyLauncherEntries({
        workspaceRoot: process.cwd(),
        endpoint,
      });
      for (const line of formatLauncherMigrationResults(results)) {
        console.log(line);
      }
    }
  } catch (error) {
    console.warn(
      `MCP config: legacy launcher-entry rewrite skipped (${error instanceof Error ? error.message : String(error)}). ` +
        'Re-run `agent-deck use <deck>` or `agent-deck setup --client codex|claude` to migrate by hand.',
    );
  }
  return reconcileCodexPluginAfterUpgrade(expectedVersion, codexRunner, options);
}

/**
 * NOT-577: `upgrade --scan <dir> --check` reports the planned migration
 * across every assigned folder under the roots and writes nothing — no
 * version check, no install, no plugin step.
 */
function runScanCheck(scanDirs: string[]): number {
  try {
    const endpoint = {
      host: process.env.AGENT_DECK_HOST ?? '127.0.0.1',
      mcpPort: parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT),
    };
    const folders = findAssignedFolders(scanDirs);
    const results = rewriteScanFolders(folders, endpoint, { dryRun: true });
    for (const line of formatLauncherMigrationResults(results, { check: true })) {
      console.log(line);
    }
    console.log(formatScanSummary(folders, results, { check: true }));
  } catch (error) {
    console.warn(
      `MCP config: legacy launcher-entry scan skipped (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  return 0;
}

export async function runUpgrade(args: string[], deps: UpgradeDeps = {}): Promise<number> {
  const checkOnly = args.includes('--check');
  const toVersion = parseToVersion(args);
  const { dirs: scanDirs, error: scanError } = parseScanDirs(args);
  if (scanError) {
    console.error(scanError);
    return 1;
  }
  const scanOptions = scanDirs.length > 0 ? { scanDirs } : {};

  // NOT-577: scan + check is a pure dry-run report — no version check,
  // no install, no plugin step, no writes.
  if (scanDirs.length > 0 && checkOnly) {
    return runScanCheck(scanDirs);
  }

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
      if (checkOnly) {
        return 0;
      }
      return reconcilePluginAndMigrateLauncherEntries(current, deps.codexRunner, {
        alreadyCurrent: true,
        ...scanOptions,
      });
    }

    if (checkOnly) {
      console.log('Update available. Run: agent-deck upgrade');
      return 0;
    }

    console.log(`Upgrading managed install ${PACKAGE_NAME} → ${latest} ...`);
    if (deps.performCliUpgrade) {
      const stubbed = await deps.performCliUpgrade(latest);
      if (!stubbed.ok) {
        console.error(`Upgrade failed: ${stubbed.error ?? 'unknown error'}`);
        return 1;
      }
    } else {
      const result = await installCliVersionToPrefix(latest);
      if (!result.ok) {
        console.error(`Upgrade failed: ${result.error}`);
        return 1;
      }
      activateVersion(latest);
    }
    console.log('Upgrade complete. Restart any running Agent Deck process.');
    return reconcilePluginAndMigrateLauncherEntries(latest, deps.codexRunner, scanOptions);
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
    if (checkOnly) {
      return 0;
    }
    return reconcilePluginAndMigrateLauncherEntries(result.current, deps.codexRunner, {
      alreadyCurrent: true,
      ...scanOptions,
    });
  }

  if (checkOnly) {
    console.log('Update available. Run: agent-deck upgrade');
    console.log('Tip: agent-deck install  # managed install with auto-updates (data unchanged)');
    return 0;
  }

  console.log(`Upgrading ${PACKAGE_NAME} → ${target} ...`);
  if (deps.performCliUpgrade) {
    const stubbed = await deps.performCliUpgrade(target);
    if (!stubbed.ok) {
      console.error(`Upgrade failed: ${stubbed.error ?? 'unknown error'}`);
      return 1;
    }
    console.log('Upgrade complete. Restart any running Agent Deck process.');
    return reconcilePluginAndMigrateLauncherEntries(target, deps.codexRunner, scanOptions);
  }
  const code = await runNpmInstallGlobal(target);
  if (code === 0) {
    console.log('Upgrade complete. Restart any running Agent Deck process.');
    console.log('Tip: agent-deck install  # switch CLI binary to managed auto-updates (data unchanged)');
    return reconcilePluginAndMigrateLauncherEntries(target, deps.codexRunner, scanOptions);
  }
  console.error('Upgrade failed. Try manually:');
  console.error(`  npm install -g ${PACKAGE_NAME}@${target}`);
  console.error('Or managed install:');
  console.error(`  npx ${PACKAGE_NAME}@latest install`);

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
