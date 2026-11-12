import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reconcileCodexPluginAfterUpgrade, runCodexPluginDoctor } from './codex-plugin';
import {
  formatLauncherMigrationResults,
  rewriteLegacyLauncherEntries,
} from './launcher-migration';
import { isLegacyMuseLaunchEntry, isMcpLaunchEntry } from './mcp-config';
import { runUpgrade } from './upgrade';
import { getAgentDeckVersion } from './version';

const CLI_VERSION = getAgentDeckVersion();
const SELECTOR = 'agent-deck@agent-deck';

// Headerless HTTP bytes: the pre-upgrade shape and the current global
// fallback shape are identical — legacy only by installed version.
const HTTP_MCP = {
  mcpServers: { 'agent-deck': { type: 'http', url: 'http://127.0.0.1:1110/mcp' } },
};

const LAUNCH_MCP = {
  mcpServers: { 'agent-deck': { type: 'stdio', command: 'agent-deck', args: ['mcp-launch'] } },
};

// The current skills-only shape: the plugin declares no MCP server.
const NO_SERVER_MCP = {
  mcpServers: {},
};

let codexHome: string;
let pluginRoot: string;
let savedCodexBin: string | undefined;
let savedCodexHome: string | undefined;
let output: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

interface StubFlags {
  failMarketplaceList?: boolean;
  failMarketplaceUpgrade?: boolean;
  failRemove?: boolean;
  failAdd?: boolean;
}

function writeStub(flags: StubFlags = {}): void {
  const stub = path.join(codexHome, 'codex');
  const marketplaceListBody = flags.failMarketplaceList
    ? 'echo "stub codex: marketplace list unavailable" >&2\nexit 1'
    : `cat "${codexHome}/marketplace-list.json"\nexit 0`;
  const marketplaceUpgradeBody = flags.failMarketplaceUpgrade
    ? 'echo "stub codex: marketplace upgrade failed" >&2\nexit 1'
    : 'exit 0';
  const removeBody = flags.failRemove ? 'echo "stub codex: remove failed" >&2\nexit 1' : 'exit 0';
  const addBody = flags.failAdd
    ? 'echo "stub codex: add failed" >&2\nexit 1'
    : `cp "${codexHome}/after/plugin-list.json" "${codexHome}/plugin-list.json"\ncp "${codexHome}/after/mcp.json" "${pluginRoot}/.mcp.json"\nexit 0`;
  const script = `#!/bin/bash
echo "codex $*" >> "${codexHome}/calls.log"
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  cat "${codexHome}/plugin-list.json"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "list" ]; then
  ${marketplaceListBody}
fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "upgrade" ]; then
  ${marketplaceUpgradeBody}
fi
if [ "$1" = "plugin" ] && [ "$2" = "remove" ]; then
  ${removeBody}
fi
if [ "$1" = "plugin" ] && [ "$2" = "add" ]; then
  ${addBody}
fi
echo "stub codex: unexpected invocation: $*" >&2
exit 1
`;
  fs.writeFileSync(stub, script);
  fs.chmodSync(stub, 0o755);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_BIN = stub;
}

/**
 * One installed plugin at 1.4.4 with direct-HTTP transport; the stub
 * promotes it to the post-upgrade state (current version, no
 * plugin-declared server) on `plugin add`. Each test writes its own
 * marketplace-list.json via writeMarketplaces().
 */
function seedUpgradeHome(): void {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-up-'));
  pluginRoot = path.join(codexHome, 'roots', 'agent-deck');
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify(HTTP_MCP, null, 2)}\n`);
  fs.writeFileSync(
    path.join(codexHome, 'plugin-list.json'),
    `${JSON.stringify(
      {
        plugins: [
          {
            name: 'agent-deck',
            version: '1.4.4',
            selector: SELECTOR,
            enabled: true,
            marketplace: 'agent-deck',
            install_root: pluginRoot,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(codexHome, 'marketplace-list.json'),
    `${JSON.stringify({ marketplaces: [] }, null, 2)}\n`,
  );
  const after = path.join(codexHome, 'after');
  fs.mkdirSync(after, { recursive: true });
  fs.writeFileSync(
    path.join(after, 'plugin-list.json'),
    `${JSON.stringify(
      {
        plugins: [
          {
            name: 'agent-deck',
            version: CLI_VERSION,
            selector: SELECTOR,
            enabled: true,
            marketplace: 'agent-deck',
            install_root: pluginRoot,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(path.join(after, 'mcp.json'), `${JSON.stringify(NO_SERVER_MCP, null, 2)}\n`);
  writeStub();
}

function writeMarketplaces(marketplaces: Array<{ name: string; root: string; source: string }>): void {
  fs.writeFileSync(
    path.join(codexHome, 'marketplace-list.json'),
    `${JSON.stringify({ marketplaces }, null, 2)}\n`,
  );
}

function readCalls(): string[] {
  const log = path.join(codexHome, 'calls.log');
  if (!fs.existsSync(log)) {
    return [];
  }
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

function hashLiveFixtures(extraRoots: string[] = []): string {
  const hash = crypto.createHash('sha256');
  const files = ['plugin-list.json', 'marketplace-list.json', path.join('roots', 'agent-deck', '.mcp.json')];
  for (const root of extraRoots) {
    files.push(path.join(root, '.mcp.json'));
  }
  for (const relative of files) {
    const full = path.join(codexHome, relative);
    if (fs.existsSync(full)) {
      hash.update(fs.readFileSync(full));
    }
  }
  return hash.digest('hex');
}

beforeEach(() => {
  savedCodexBin = process.env.CODEX_BIN;
  savedCodexHome = process.env.CODEX_HOME;
  output = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  if (savedCodexBin === undefined) {
    delete process.env.CODEX_BIN;
  } else {
    process.env.CODEX_BIN = savedCodexBin;
  }
  if (savedCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = savedCodexHome;
  }
  if (codexHome) {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

// Each case below shells out to a stub `codex` binary several times; allow
// headroom under loaded CI runners (default 5s proved flaky there).
describe('upgrade codex plugin reconciliation (NOT-188)', { timeout: 30_000 }, () => {
  it('reinstalls through remove/add for one unambiguous local source', async () => {
    seedUpgradeHome();
    // Single local marketplace root supplying the installed plugin.
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    expect(process.env.CODEX_HOME).toBe(codexHome);

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(0);
    const removeIdx = calls.findIndex((line) => line === `codex plugin remove ${SELECTOR}`);
    const addIdx = calls.findIndex((line) => line === `codex plugin add ${SELECTOR}`);
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(removeIdx);
    expect(calls.some((line) => line.includes('marketplace upgrade'))).toBe(false);
    expect(text).toContain(
      `Codex plugin manifest: OK (${CLI_VERSION}, none) (manifest-only, connection not verified)`,
    );
    expect(text).not.toContain('Codex plugin: OK (');
  });

  it('refreshes a git marketplace before remove/add', async () => {
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'git' }]);

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const calls = readCalls();

    expect(code).toBe(0);
    const upgradeIdx = calls.findIndex((line) => line === 'codex plugin marketplace upgrade agent-deck');
    const removeIdx = calls.findIndex((line) => line === `codex plugin remove ${SELECTOR}`);
    const addIdx = calls.findIndex((line) => line === `codex plugin add ${SELECTOR}`);
    expect(upgradeIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(upgradeIdx);
    expect(addIdx).toBeGreaterThan(removeIdx);
  });

  it('leaves duplicate source roots untouched with manual commands', async () => {
    seedUpgradeHome();
    const rootA = path.join(codexHome, 'roots', 'a');
    const rootB = path.join(codexHome, 'roots', 'b');
    for (const root of [rootA, rootB]) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, '.mcp.json'), `${JSON.stringify(HTTP_MCP, null, 2)}\n`);
    }
    writeMarketplaces([
      { name: 'agent-deck', root: rootA, source: 'local' },
      { name: 'agent-deck', root: rootB, source: 'local' },
    ]);
    const before = hashLiveFixtures(['roots/a', 'roots/b']);

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('CLI upgrade complete; Codex plugin unchanged');
    expect(text).toContain(`codex plugin remove ${SELECTOR}`);
    expect(text).toContain(`codex plugin add ${SELECTOR}`);
    expect(hashLiveFixtures(['roots/a', 'roots/b'])).toBe(before);
  });

  it('leaves malformed codex JSON untouched with manual commands', async () => {
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    fs.writeFileSync(path.join(codexHome, 'plugin-list.json'), '{"plugins": [');
    const before = hashLiveFixtures();

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('CLI upgrade complete; Codex plugin unchanged');
    expect(text).toContain(`codex plugin remove ${SELECTOR}`);
    expect(text).toContain(`codex plugin add ${SELECTOR}`);
    expect(hashLiveFixtures()).toBe(before);
  });

  it('reports removal (not "unchanged") when add fails after remove succeeded', async () => {
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'git' }]);
    writeStub({ failAdd: true });
    const before = hashLiveFixtures();

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(calls).toContain(`codex plugin remove ${SELECTOR}`);
    expect(calls).toContain(`codex plugin add ${SELECTOR}`);
    expect(text).toContain('Codex plugin removed but reinstall failed');
    expect(text).not.toContain('Codex plugin unchanged');
    // Recovery prints the add command (plus the git marketplace refresh),
    // not a repeated remove: the plugin is already uninstalled.
    expect(text).toContain('codex plugin marketplace upgrade agent-deck');
    expect(text).toContain(`codex plugin add ${SELECTOR}`);
    // The failed add left the pre-upgrade fixtures in place.
    expect(hashLiveFixtures()).toBe(before);
  });

  it('does not reinstall when the marketplace list fails', async () => {
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    writeStub({ failMarketplaceList: true });
    const before = hashLiveFixtures();

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('CLI upgrade complete; Codex plugin unchanged');
    expect(text).toContain('marketplace list failed');
    expect(text).toContain(`codex plugin remove ${SELECTOR}`);
    expect(text).toContain(`codex plugin add ${SELECTOR}`);
    expect(hashLiveFixtures()).toBe(before);
  });

  it('does not reinstall when no marketplace source resolves', async () => {
    seedUpgradeHome();
    // Default seed fixture: an empty marketplace list, so the installed
    // plugin's source root cannot be resolved to exactly one marketplace.
    const before = hashLiveFixtures();

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('CLI upgrade complete; Codex plugin unchanged');
    expect(text).toContain('could not resolve a single marketplace source');
    expect(text).toContain(`codex plugin remove ${SELECTOR}`);
    expect(text).toContain(`codex plugin add ${SELECTOR}`);
    expect(hashLiveFixtures()).toBe(before);
  });

  it('leaves a disabled plugin installed without remove/add', async () => {
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    fs.writeFileSync(
      path.join(codexHome, 'plugin-list.json'),
      `${JSON.stringify(
        {
          plugins: [
            {
              name: 'agent-deck',
              version: '1.4.4',
              selector: SELECTOR,
              enabled: false,
              marketplace: 'agent-deck',
              install_root: pluginRoot,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const before = hashLiveFixtures();

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('CLI upgrade complete; Codex plugin unchanged');
    expect(text).toContain('disabled');
    expect(hashLiveFixtures()).toBe(before);
  });

  it('fails the re-read when the reinstalled plugin has an unverifiable transport', async () => {
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    // The reinstall "succeeds" but leaves an unrecognised entry shape: no
    // declared server would verify, a custom wrapper does not.
    fs.writeFileSync(
      path.join(codexHome, 'after', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { 'agent-deck': { command: 'custom-wrapper', args: [] } } }, null, 2)}\n`,
    );

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(calls).toContain(`codex plugin remove ${SELECTOR}`);
    expect(calls).toContain(`codex plugin add ${SELECTOR}`);
    expect(text).not.toContain('Codex plugin manifest: OK (');
    expect(text).not.toContain('Codex plugin: OK (');
    expect(text).toContain('still unknown-transport');
    expect(text).toContain(`codex plugin add ${SELECTOR}`);
  });
});

describe('current-contract reconciliation (NOT-301)', { timeout: 30_000 }, () => {
  /**
   * Sanitized Codex 0.157.1 shape: `installed[]` carries pluginId /
   * marketplaceName / installed / enabled / nested source.path, with a stale
   * discovery-only `available[]` row. The stub promotes to the post-upgrade
   * current shape on `plugin add`. Fixture home is isolated temp.
   */
  function seedCurrentShapeUpgradeHome(opts: { enabled?: boolean; installedFlag?: boolean } = {}): void {
    const { enabled = true, installedFlag = true } = opts;
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-cur-up-'));
    pluginRoot = path.join(codexHome, 'roots', 'agent-deck');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify(HTTP_MCP, null, 2)}\n`);
    const pluginList = {
      installed: [
        {
          pluginId: SELECTOR,
          name: 'agent-deck',
          marketplaceName: 'agent-deck',
          version: '1.11.7',
          installed: installedFlag,
          enabled,
          source: { source: 'local', path: pluginRoot },
          marketplaceSource: { sourceType: 'local', source: pluginRoot },
        },
      ],
      available: [
        {
          pluginId: 'agent-deck@agent-deck-dev',
          name: 'agent-deck',
          marketplaceName: 'agent-deck-dev',
          version: '1.4.4',
          installed: false,
          enabled: false,
        },
      ],
    };
    fs.writeFileSync(path.join(codexHome, 'plugin-list.json'), `${JSON.stringify(pluginList, null, 2)}\n`);
    fs.writeFileSync(
      path.join(codexHome, 'marketplace-list.json'),
      `${JSON.stringify({ marketplaces: [] }, null, 2)}\n`,
    );
    const after = path.join(codexHome, 'after');
    fs.mkdirSync(after, { recursive: true });
    fs.writeFileSync(
      path.join(after, 'plugin-list.json'),
      `${JSON.stringify(
        {
          installed: [
            {
              pluginId: SELECTOR,
              name: 'agent-deck',
              marketplaceName: 'agent-deck',
              version: CLI_VERSION,
              installed: true,
              enabled: true,
              source: { source: 'local', path: pluginRoot },
              marketplaceSource: { sourceType: 'local', source: pluginRoot },
            },
          ],
          available: [],
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(path.join(after, 'mcp.json'), `${JSON.stringify(NO_SERVER_MCP, null, 2)}\n`);
    writeStub();
  }

  it('reconciles installed[] 1.11.7 through remove/add and verifies current plus no-server', async () => {
    seedCurrentShapeUpgradeHome();
    // One unambiguous local marketplace; the stale available[] dev row
    // must not create source ambiguity.
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    expect(process.env.CODEX_HOME).toBe(codexHome);

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(0);
    const removeIdx = calls.findIndex((line) => line === `codex plugin remove ${SELECTOR}`);
    const addIdx = calls.findIndex((line) => line === `codex plugin add ${SELECTOR}`);
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(removeIdx);
    expect(text).toContain(
      `Codex plugin manifest: OK (${CLI_VERSION}, none) (manifest-only, connection not verified)`,
    );
    expect(text).not.toContain('Codex plugin: OK (');
  });

  it('leaves an installed[] entry with enabled:false without remove/add', async () => {
    seedCurrentShapeUpgradeHome({ enabled: false });
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    const before = hashLiveFixtures();

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('CLI upgrade complete; Codex plugin unchanged');
    expect(text).toContain('disabled');
    expect(hashLiveFixtures()).toBe(before);
  });

  it('treats an installed[] entry with installed:false as not installed without remove/add', async () => {
    seedCurrentShapeUpgradeHome({ installedFlag: false });
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    const before = hashLiveFixtures();

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('CLI upgrade complete; Codex plugin unchanged');
    expect(text).toContain('plugin not installed');
    expect(hashLiveFixtures()).toBe(before);
  });
});

describe('sticky versioned cache reconciliation (NOT-360)', { timeout: 30_000 }, () => {
  const STALE_VERSION = '1.11.7';

  /**
   * Stub Codex with a sticky versioned cache: `plugin remove` + `plugin add`
   * succeed but leave the installed version at 1.11.7 until the versioned
   * cache path itself is cleared. The marketplace workspace already carries
   * the new `plugin.json`; live Codex lists the workspace as the source
   * path. Fixture home is isolated temp; never the real CODEX_HOME.
   */
  function seedStickyCacheUpgradeHome(): { marketplaceRoot: string; installedCacheRoot: string } {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-sticky-up-'));
    const marketplaceRoot = path.join(codexHome, 'marketplace', 'agent-deck');
    fs.mkdirSync(path.join(marketplaceRoot, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceRoot, '.codex-plugin', 'plugin.json'),
      `${JSON.stringify({ name: 'agent-deck', version: CLI_VERSION }, null, 2)}\n`,
    );
    // Legacy launcher transport on purpose: the sticky-cache mechanics
    // are transport-agnostic, and this keeps the legacy path covered.
    fs.writeFileSync(
      path.join(marketplaceRoot, '.mcp.json'),
      `${JSON.stringify(LAUNCH_MCP, null, 2)}\n`,
    );
    pluginRoot = marketplaceRoot;
    const installedCacheRoot = path.join(
      codexHome,
      'plugins',
      'cache',
      'agent-deck',
      'agent-deck',
      STALE_VERSION,
    );
    fs.mkdirSync(installedCacheRoot, { recursive: true });
    fs.writeFileSync(
      path.join(installedCacheRoot, '.mcp.json'),
      `${JSON.stringify(LAUNCH_MCP, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(codexHome, 'plugin-list.json'),
      `${JSON.stringify(
        {
          installed: [
            {
              pluginId: SELECTOR,
              name: 'agent-deck',
              marketplaceName: 'agent-deck',
              version: STALE_VERSION,
              installed: true,
              enabled: true,
              source: { source: 'local', path: marketplaceRoot },
              marketplaceSource: { sourceType: 'local', source: marketplaceRoot },
            },
          ],
          available: [],
        },
        null,
        2,
      )}\n`,
    );
    writeMarketplaces([{ name: 'agent-deck', root: marketplaceRoot, source: 'local' }]);
    // remove/add report success but never refresh the installed version:
    // the stale cache survives until the operator clears it manually.
    const stub = path.join(codexHome, 'codex');
    fs.writeFileSync(
      stub,
      `#!/bin/bash
echo "codex $*" >> "${codexHome}/calls.log"
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  cat "${codexHome}/plugin-list.json"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "list" ]; then
  cat "${codexHome}/marketplace-list.json"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "remove" ]; then
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "add" ]; then
  exit 0
fi
echo "stub codex: unexpected invocation: $*" >&2
exit 1
`,
    );
    fs.chmodSync(stub, 0o755);
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_BIN = stub;
    return { marketplaceRoot, installedCacheRoot };
  }

  function promoteToCurrent(): void {
    fs.writeFileSync(
      path.join(codexHome, 'plugin-list.json'),
      `${JSON.stringify(
        {
          installed: [
            {
              pluginId: SELECTOR,
              name: 'agent-deck',
              marketplaceName: 'agent-deck',
              version: CLI_VERSION,
              installed: true,
              enabled: true,
              source: { source: 'local', path: pluginRoot },
              marketplaceSource: { sourceType: 'local', source: pluginRoot },
            },
          ],
          available: [],
        },
        null,
        2,
      )}\n`,
    );
  }

  it('exits 1 with cache-clear remediation when remove/add leave the old version', async () => {
    const { installedCacheRoot } = seedStickyCacheUpgradeHome();
    expect(process.env.CODEX_HOME).toBe(codexHome);

    const code = await reconcileCodexPluginAfterUpgrade(CLI_VERSION);
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    // Reconciliation still goes through the supported commands ...
    expect(calls).toContain(`codex plugin remove ${SELECTOR}`);
    expect(calls).toContain(`codex plugin add ${SELECTOR}`);
    // ... but the re-read still sees the stale version, so remediation must
    // name the observed installed (cache) root and how to clear it — not
    // only remove/add against the marketplace selector.
    expect(text).toContain(`still version-mismatch`);
    expect(text).toContain(`installed ${STALE_VERSION}`);
    expect(text).toContain(`Installed root: ${installedCacheRoot}`);
    expect(text).toContain(`rm -rf "${installedCacheRoot}"`);
    expect(text).toContain(`codex plugin add ${SELECTOR}`);
    // Safety: Agent Deck never clears the cache itself and never edits
    // Codex state files directly — the stale copy is still on disk.
    expect(fs.existsSync(installedCacheRoot)).toBe(true);
    expect(calls.some((line) => line.includes('rm '))).toBe(false);
  });

  it('reaches OK once the operator clears the cache and re-adds', async () => {
    const { installedCacheRoot } = seedStickyCacheUpgradeHome();

    expect(await reconcileCodexPluginAfterUpgrade(CLI_VERSION)).toBe(1);

    // Operator follows the printed remediation: clear the sticky cache,
    // re-add (which serves the marketplace workspace at CLI_VERSION).
    fs.rmSync(installedCacheRoot, { recursive: true, force: true });
    promoteToCurrent();

    output.length = 0;
    expect(
      await runCodexPluginDoctor(CLI_VERSION, undefined, { probeDaemon: async () => false }),
    ).toBe(0);
    expect(output.join('\n')).toContain(
      `Codex plugin manifest: OK (${CLI_VERSION}, mcp-launch) (manifest-only, connection not verified)`,
    );
    expect(output.join('\n')).toContain('daemon is not reachable');
    expect(output.join('\n')).not.toContain('Codex plugin: OK (');
  });
});

describe('upgrade no-op reconciliation (NOT-291)', { timeout: 30_000 }, () => {
  let deckHome = '';
  let savedDeckHome: string | undefined;
  let savedFetch: typeof globalThis.fetch | undefined;
  let cliInstalls = 0;

  beforeEach(() => {
    savedDeckHome = process.env.AGENT_DECK_HOME;
    savedFetch = globalThis.fetch;
    cliInstalls = 0;
  });

  afterEach(() => {
    if (savedDeckHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = savedDeckHome;
    }
    globalThis.fetch = savedFetch as typeof globalThis.fetch;
    if (deckHome) {
      fs.rmSync(deckHome, { recursive: true, force: true });
      deckHome = '';
    }
  });

  function stubFetchLatest(version: string): void {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ version }),
    })) as typeof globalThis.fetch;
  }

  function trackInstall(): Promise<{ ok: boolean }> {
    cliInstalls += 1;
    return Promise.resolve({ ok: true });
  }

  /** npm-global/unknown kind: no `current` symlink under AGENT_DECK_HOME. */
  function seedNpmHome(): void {
    deckHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-deck-npm-'));
    process.env.AGENT_DECK_HOME = deckHome;
    stubFetchLatest(CLI_VERSION);
  }

  /** Managed kind pinned at the current CLI version. */
  function seedManagedHome(): void {
    deckHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-deck-managed-'));
    const target = path.join(deckHome, 'versions', CLI_VERSION);
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, path.join(deckHome, 'current'));
    process.env.AGENT_DECK_HOME = deckHome;
    stubFetchLatest(CLI_VERSION);
  }

  // Legacy launcher transport on purpose: already-installed plugins
  // keep verifying as compatible without a reinstall.
  function seedCompatiblePlugin(): void {
    fs.writeFileSync(
      path.join(codexHome, 'plugin-list.json'),
      `${JSON.stringify(
        {
          plugins: [
            {
              name: 'agent-deck',
              version: CLI_VERSION,
              selector: SELECTOR,
              enabled: true,
              marketplace: 'agent-deck',
              install_root: pluginRoot,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify(LAUNCH_MCP, null, 2)}\n`);
  }

  it('managed no-op reconciles a stale local plugin without a CLI install', async () => {
    seedManagedHome();
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);

    const code = await runUpgrade([], { performCliUpgrade: trackInstall });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(0);
    expect(cliInstalls).toBe(0);
    const removeIdx = calls.findIndex((line) => line === `codex plugin remove ${SELECTOR}`);
    const addIdx = calls.findIndex((line) => line === `codex plugin add ${SELECTOR}`);
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(removeIdx);
    expect(text).toContain('Already on the latest version.');
    expect(text).toContain(
      `Codex plugin manifest: OK (${CLI_VERSION}, none) (manifest-only, connection not verified)`,
    );
    expect(text).not.toContain('Codex plugin: OK (');
    expect(text).not.toContain('Upgrade complete');
    expect(text).not.toContain('CLI upgrade complete');
  });

  it('npm-global no-op reconciles a stale local plugin without npm install', async () => {
    seedNpmHome();
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);

    const code = await runUpgrade([], { performCliUpgrade: trackInstall });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(0);
    expect(cliInstalls).toBe(0);
    const removeIdx = calls.findIndex((line) => line === `codex plugin remove ${SELECTOR}`);
    const addIdx = calls.findIndex((line) => line === `codex plugin add ${SELECTOR}`);
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThan(removeIdx);
    expect(text).toContain('Already on the latest version.');
    expect(text).toContain(
      `Codex plugin manifest: OK (${CLI_VERSION}, none) (manifest-only, connection not verified)`,
    );
    expect(text).not.toContain('Codex plugin: OK (');
    expect(text).not.toContain('Upgrade complete');
    expect(text).not.toContain('CLI upgrade complete');
  });

  it('no-op with a compatible plugin performs no remove/add', async () => {
    seedNpmHome();
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    seedCompatiblePlugin();

    const code = await runUpgrade([], { performCliUpgrade: trackInstall });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(0);
    expect(cliInstalls).toBe(0);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('Already on the latest version.');
    expect(output.filter((line) => line.includes('Codex plugin manifest: OK (')).length).toBe(1);
    expect(text).toContain(
      `Codex plugin manifest: OK (${CLI_VERSION}, mcp-launch) (manifest-only, connection not verified)`,
    );
    expect(text).not.toContain('Codex plugin: OK (');
  });

  it('no-op refreshes a git marketplace before remove/add', async () => {
    seedManagedHome();
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'git' }]);

    const code = await runUpgrade([], { performCliUpgrade: trackInstall });
    const calls = readCalls();

    expect(code).toBe(0);
    expect(cliInstalls).toBe(0);
    const upgradeIdx = calls.findIndex((line) => line === 'codex plugin marketplace upgrade agent-deck');
    const removeIdx = calls.findIndex((line) => line === `codex plugin remove ${SELECTOR}`);
    const addIdx = calls.findIndex((line) => line === `codex plugin add ${SELECTOR}`);
    expect(upgradeIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(upgradeIdx);
    expect(addIdx).toBeGreaterThan(removeIdx);
  });

  it('no-op with duplicate sources leaves the CLI untouched and exits 1', async () => {
    seedNpmHome();
    seedUpgradeHome();
    const rootA = path.join(codexHome, 'roots', 'a');
    const rootB = path.join(codexHome, 'roots', 'b');
    for (const root of [rootA, rootB]) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, '.mcp.json'), `${JSON.stringify(HTTP_MCP, null, 2)}\n`);
    }
    writeMarketplaces([
      { name: 'agent-deck', root: rootA, source: 'local' },
      { name: 'agent-deck', root: rootB, source: 'local' },
    ]);
    const before = hashLiveFixtures(['roots/a', 'roots/b']);

    const code = await runUpgrade([], { performCliUpgrade: trackInstall });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(cliInstalls).toBe(0);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('Already on the latest version.');
    expect(text).toContain('CLI already current');
    expect(text).not.toContain('CLI upgrade complete');
    expect(text).toContain(`codex plugin remove ${SELECTOR}`);
    expect(text).toContain(`codex plugin add ${SELECTOR}`);
    expect(hashLiveFixtures(['roots/a', 'roots/b'])).toBe(before);
  });

  it('no-op leaves a disabled plugin installed and exits 1', async () => {
    seedManagedHome();
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    fs.writeFileSync(
      path.join(codexHome, 'plugin-list.json'),
      `${JSON.stringify(
        {
          plugins: [
            {
              name: 'agent-deck',
              version: '1.4.4',
              selector: SELECTOR,
              enabled: false,
              marketplace: 'agent-deck',
              install_root: pluginRoot,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const before = hashLiveFixtures();

    const code = await runUpgrade([], { performCliUpgrade: trackInstall });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(cliInstalls).toBe(0);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('Already on the latest version.');
    expect(text).toContain('CLI already current');
    expect(text).toContain('disabled');
    expect(hashLiveFixtures()).toBe(before);
  });

  it('--check with a stale plugin runs no mutating codex command', async () => {
    seedNpmHome();
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'git' }]);
    const before = hashLiveFixtures();

    const code = await runUpgrade(['--check'], { performCliUpgrade: trackInstall });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(0);
    expect(cliInstalls).toBe(0);
    expect(calls.some((line) => line.includes('marketplace upgrade'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin remove'))).toBe(false);
    expect(calls.some((line) => line.includes('plugin add'))).toBe(false);
    expect(text).toContain('Already on the latest version.');
    expect(text).not.toContain('Codex plugin manifest: OK (');
    expect(text).not.toContain('Codex plugin: OK (');
    expect(hashLiveFixtures()).toBe(before);
  });
});

describe('upgrade legacy launcher-entry rewrite (NOT-566)', { timeout: 30_000 }, () => {
  const ENDPOINT = { host: '127.0.0.1', mcpPort: 1110 };
  const MCP_URL = 'http://127.0.0.1:1110/mcp';

  let fakeHome = '';
  let workspace = '';
  let deckHome = '';
  let savedDeckHome: string | undefined;
  let savedFetch: typeof globalThis.fetch | undefined;
  let savedMcpPort: string | undefined;
  let savedHost: string | undefined;
  let savedXdg: string | undefined;

  const LAUNCHER_JSON = {
    type: 'stdio',
    command: 'agent-deck',
    args: ['mcp-launch'],
    env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
  };
  // The retired NOT-387 Muse launcher shape: no type, no workspace pin.
  const MUSE_LAUNCHER_JSON = {
    command: 'agent-deck',
    args: ['mcp-launch'],
    env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
  };
  const MEMORY_SERVER = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] };

  /** Muse user settings path under the mocked home (XDG unset in these tests). */
  function museGlobalPath(): string {
    return path.join(fakeHome, '.config', 'muse', 'settings.json');
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-migrate-home-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-migrate-ws-'));
    savedDeckHome = process.env.AGENT_DECK_HOME;
    savedFetch = globalThis.fetch;
    savedMcpPort = process.env.AGENT_DECK_MCP_PORT;
    savedHost = process.env.AGENT_DECK_HOST;
    savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.AGENT_DECK_MCP_PORT;
    delete process.env.XDG_CONFIG_HOME;
    process.env.AGENT_DECK_HOST = '127.0.0.1';
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedDeckHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = savedDeckHome;
    }
    globalThis.fetch = savedFetch as typeof globalThis.fetch;
    if (savedMcpPort === undefined) {
      delete process.env.AGENT_DECK_MCP_PORT;
    } else {
      process.env.AGENT_DECK_MCP_PORT = savedMcpPort;
    }
    if (savedHost === undefined) {
      delete process.env.AGENT_DECK_HOST;
    } else {
      process.env.AGENT_DECK_HOST = savedHost;
    }
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    if (deckHome) {
      fs.rmSync(deckHome, { recursive: true, force: true });
      deckHome = '';
    }
  });

  function seedLegacyInstall(): void {
    fs.writeFileSync(
      path.join(workspace, '.mcp.json'),
      `${JSON.stringify({ mcpServers: { memory: MEMORY_SERVER, 'agent-deck': LAUNCHER_JSON } }, null, 2)}\n`,
    );
    fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.codex', 'config.toml'),
      '[model]\nname = "gpt-5"\n\n[mcp_servers.agent-deck]\ncommand = "agent-deck"\nargs = ["mcp-launch"]\n',
    );
    fs.writeFileSync(
      path.join(fakeHome, '.claude.json'),
      `${JSON.stringify({ theme: 'dark', mcpServers: { 'agent-deck': LAUNCHER_JSON } }, null, 2)}\n`,
    );
    fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.codex', 'config.toml'),
      '[mcp_servers.agent-deck]\ncommand = "agent-deck"\nargs = ["mcp-launch"]\n',
    );
    // Hosts that keep the launcher must never be rewritten.
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { 'agent-deck': LAUNCHER_JSON } }, null, 2)}\n`,
    );
  }

  it('rewrites legacy launcher entries to pure MCP and preserves unrelated content', () => {
    seedLegacyInstall();

    const results = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });

    expect(results).toEqual([
      { path: path.join(workspace, '.mcp.json'), action: 'rewritten' },
      { path: path.join(workspace, '.codex', 'config.toml'), action: 'rewritten' },
      { path: path.join(fakeHome, '.claude.json'), action: 'rewritten' },
      { path: path.join(fakeHome, '.codex', 'config.toml'), action: 'rewritten' },
      // No Muse settings file in this fixture: nothing to rewrite.
      { path: museGlobalPath(), action: 'unchanged' },
    ]);

    const projectMcp = JSON.parse(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8'));
    expect(projectMcp).toEqual({
      mcpServers: {
        memory: MEMORY_SERVER,
        'agent-deck': {
          type: 'http',
          url: MCP_URL,
          headers: { 'x-agent-deck-workspace': workspace },
        },
      },
    });
    expect(fs.readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8')).toBe(
      `[model]\nname = "gpt-5"\n\n[mcp_servers.agent-deck]\nurl = "${MCP_URL}"\nhttp_headers = { "x-agent-deck-workspace" = "${workspace}" }\n`,
    );
    const userClaude = JSON.parse(fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8'));
    expect(userClaude).toEqual({
      theme: 'dark',
      mcpServers: { 'agent-deck': { type: 'http', url: MCP_URL } },
    });
    expect(fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8')).toBe(
      `[mcp_servers.agent-deck]\nurl = "${MCP_URL}"\n`,
    );
    // Cursor keeps the launcher: byte-identical.
    expect(
      JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8')),
    ).toEqual({ mcpServers: { 'agent-deck': LAUNCHER_JSON } });

    const lines = formatLauncherMigrationResults(results);
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).toContain('rewrote legacy launcher entry to pure MCP');
  });

  it('is idempotent: a second run changes nothing', () => {
    seedLegacyInstall();

    const first = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });
    expect(first.slice(0, 4).every((result) => result.action === 'rewritten')).toBe(true);
    expect(first[4].action).toBe('unchanged');
    const bytes = [
      fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8'),
      fs.readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8'),
      fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8'),
      fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8'),
    ];

    const second = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });
    expect(second.every((result) => result.action === 'unchanged')).toBe(true);
    expect(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8')).toBe(bytes[0]);
    expect(fs.readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8')).toBe(bytes[1]);
    expect(fs.readFileSync(path.join(fakeHome, '.claude.json'), 'utf8')).toBe(bytes[2]);
    expect(fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8')).toBe(bytes[3]);
    expect(formatLauncherMigrationResults(second)).toEqual([]);
  });

  it('leaves custom and pure-HTTP entries alone, and skips corrupt files with a reason', () => {
    fs.writeFileSync(
      path.join(workspace, '.mcp.json'),
      `${JSON.stringify({ mcpServers: { 'agent-deck': { command: 'npx', args: ['-y', 'custom'] } } }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(fakeHome, '.claude.json'), '{ not json');
    fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.codex', 'config.toml'),
      `[mcp_servers.agent-deck]\nurl = "${MCP_URL}"\nhttp_headers = { "x-agent-deck-workspace" = "${workspace}" }\n`,
    );

    const results = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });

    expect(results[0].action).toBe('unchanged');
    expect(results[1].action).toBe('unchanged');
    expect(results[2].action).toBe('skipped');
    expect(results[2].reason).toBeTruthy();
    expect(results[3].action).toBe('unchanged');
    expect(results[4].action).toBe('unchanged');
    // Custom entry byte-identical.
    expect(JSON.parse(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: { 'agent-deck': { command: 'npx', args: ['-y', 'custom'] } },
    });
    const lines = formatLauncherMigrationResults(results);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(path.join(fakeHome, '.claude.json'));
  });

  it('agent-deck upgrade rewrites a legacy fixture install', async () => {
    seedLegacyInstall();
    // npm-global kind at the current version: upgrade is a no-op that still
    // runs the plugin reconcile and the launcher-entry migration.
    deckHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-deck-npm-'));
    process.env.AGENT_DECK_HOME = deckHome;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ version: CLI_VERSION }),
    })) as typeof globalThis.fetch;
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    fs.writeFileSync(
      path.join(codexHome, 'plugin-list.json'),
      `${JSON.stringify({ plugins: [{ name: 'agent-deck', version: CLI_VERSION, selector: SELECTOR, enabled: true, marketplace: 'agent-deck', install_root: pluginRoot }] }, null, 2)}\n`,
    );
    // Current version, skills-only manifest: compatible, no remove/add.
    fs.writeFileSync(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify(NO_SERVER_MCP, null, 2)}\n`);

    const code = await runUpgrade([], { performCliUpgrade: async () => ({ ok: true }) });
    const text = output.join('\n');

    expect(code).toBe(0);
    expect(text).toContain('Already on the latest version.');
    const projectMcp = JSON.parse(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8'));
    expect(projectMcp.mcpServers['agent-deck']).toEqual({
      type: 'http',
      url: MCP_URL,
      headers: { 'x-agent-deck-workspace': workspace },
    });
    expect(fs.readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8')).toContain(
      `url = "${MCP_URL}"`,
    );
    expect(fs.readFileSync(path.join(workspace, '.codex', 'config.toml'), 'utf8')).not.toContain(
      'mcp-launch',
    );
    expect(text).toContain('rewrote legacy launcher entry to pure MCP');
    // Cursor untouched by the documented upgrade path too.
    expect(
      JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8')),
    ).toEqual({ mcpServers: { 'agent-deck': LAUNCHER_JSON } });
  });

  it('agent-deck upgrade --check never rewrites launcher entries', async () => {
    seedLegacyInstall();
    deckHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-deck-npm-'));
    process.env.AGENT_DECK_HOME = deckHome;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ version: CLI_VERSION }),
    })) as typeof globalThis.fetch;

    const code = await runUpgrade(['--check'], { performCliUpgrade: async () => ({ ok: true }) });

    expect(code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(workspace, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: { memory: MEMORY_SERVER, 'agent-deck': LAUNCHER_JSON },
    });
    expect(output.join('\n')).not.toContain('rewrote legacy launcher entry');
  });

  it('NOT-572: rewrites a Muse launcher project entry to the per-folder HTTP entry when assigned', () => {
    expect(isMcpLaunchEntry(MUSE_LAUNCHER_JSON)).toBe(true);
    expect(isLegacyMuseLaunchEntry(MUSE_LAUNCHER_JSON)).toBe(true);
    const configPath = path.join(workspace, '.mcp.json');
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ mcpServers: { memory: MEMORY_SERVER, 'agent-deck': MUSE_LAUNCHER_JSON } }, null, 2)}\n`,
    );
    // The folder has a deck assignment, so the per-folder HTTP entry applies.
    fs.mkdirSync(path.join(workspace, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.agent-deck', 'use.json'),
      `${JSON.stringify({ version: 3, deckId: 'deck-1', deckName: 'dev' }, null, 2)}\n`,
    );

    const results = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });

    expect(results[0]).toEqual({ path: configPath, action: 'rewritten' });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: {
        memory: MEMORY_SERVER,
        'agent-deck': {
          type: 'http',
          url: MCP_URL,
          headers: { 'x-agent-deck-workspace': workspace },
        },
      },
    });
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('mcp-launch');
    // Second run is byte-identical.
    const beforeSecond = fs.readFileSync(configPath, 'utf8');
    const second = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });
    expect(second[0].action).toBe('unchanged');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(beforeSecond);
  });

  it('NOT-572: removes a Muse launcher project entry with a notice when the folder has no assignment', () => {
    const configPath = path.join(workspace, '.mcp.json');
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ mcpServers: { memory: MEMORY_SERVER, 'agent-deck': MUSE_LAUNCHER_JSON } }, null, 2)}\n`,
    );
    // No .agent-deck/use.json: the global fallback applies instead.

    const results = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });

    expect(results[0]).toEqual({ path: configPath, action: 'removed' });
    // The launcher entry is gone; the unrelated server survives.
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: { memory: MEMORY_SERVER },
    });
    expect(fs.readFileSync(configPath, 'utf8')).not.toContain('mcp-launch');
    const lines = formatLauncherMigrationResults(results);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('removed legacy launcher entry with no folder assignment');
    expect(lines[0]).toContain(configPath);
    expect(lines[0]).toContain('agent-deck use <deck>');
    // Second run changes nothing.
    const second = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });
    expect(second[0].action).toBe('unchanged');
    expect(formatLauncherMigrationResults(second)).toEqual([]);
  });

  it('NOT-572: rewrites a Muse launcher user-settings entry to the headerless global entry', () => {
    const settingsPath = museGlobalPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          theme: 'dark',
          schema_version: 1,
          mcpServers: { memory: MEMORY_SERVER, 'agent-deck': MUSE_LAUNCHER_JSON },
        },
        null,
        2,
      )}\n`,
    );

    const results = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });

    expect(results[4]).toEqual({ path: settingsPath, action: 'rewritten' });
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // Exact fallback fields only — toEqual fails on any leftover field.
    expect(written).toEqual({
      theme: 'dark',
      schema_version: 1,
      mcpServers: { memory: MEMORY_SERVER, 'agent-deck': { type: 'http', url: MCP_URL } },
    });
    expect(fs.readFileSync(settingsPath, 'utf8')).not.toContain('mcp-launch');
    const lines = formatLauncherMigrationResults(results);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('rewrote legacy launcher entry to pure MCP');
    // Second run is byte-identical.
    const beforeSecond = fs.readFileSync(settingsPath, 'utf8');
    const second = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });
    expect(second[4].action).toBe('unchanged');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(beforeSecond);
  });

  it('NOT-572: leaves custom Muse entries alone and skips an incompatible schema_version with a reason', () => {
    // Custom project entry: byte-identical.
    const configPath = path.join(workspace, '.mcp.json');
    const custom = {
      mcpServers: { 'agent-deck': { command: 'npx', args: ['-y', 'custom-wrapper'] } },
    };
    const customOriginal = `${JSON.stringify(custom, null, 2)}\n`;
    fs.writeFileSync(configPath, customOriginal);
    // Custom user-settings entry: byte-identical.
    const customSettingsPath = museGlobalPath();
    fs.mkdirSync(path.dirname(customSettingsPath), { recursive: true });
    const customSettings = {
      schema_version: 1,
      mcpServers: { 'agent-deck': { command: 'npx', args: ['-y', 'custom-wrapper'] } },
    };
    const customSettingsOriginal = `${JSON.stringify(customSettings, null, 2)}\n`;
    fs.writeFileSync(customSettingsPath, customSettingsOriginal);

    const results = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });

    expect(results[0].action).toBe('unchanged');
    expect(results[4].action).toBe('unchanged');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(customOriginal);
    expect(fs.readFileSync(customSettingsPath, 'utf8')).toBe(customSettingsOriginal);

    // Incompatible schema_version with a launcher entry: skipped, untouched.
    const badSettings = {
      schema_version: 2,
      mcpServers: { 'agent-deck': MUSE_LAUNCHER_JSON },
    };
    const badOriginal = `${JSON.stringify(badSettings, null, 2)}\n`;
    fs.writeFileSync(customSettingsPath, badOriginal);
    const skipped = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });
    expect(skipped[4].action).toBe('skipped');
    expect(skipped[4].reason).toContain('schema_version');
    expect(fs.readFileSync(customSettingsPath, 'utf8')).toBe(badOriginal);
    const lines = formatLauncherMigrationResults(skipped);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(customSettingsPath);
  });

  it('rewrites a legacy Claude project entry pinned by workspace env without the stdio type', () => {
    const configPath = path.join(workspace, '.mcp.json');
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          mcpServers: {
            'agent-deck': {
              command: 'agent-deck',
              args: ['mcp-launch'],
              env: {
                AGENT_DECK_MCP_PORT: '1110',
                AGENT_DECK_HOST: '127.0.0.1',
                AGENT_DECK_WORKSPACE: workspace,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const results = rewriteLegacyLauncherEntries({ workspaceRoot: workspace, endpoint: ENDPOINT });

    expect(results[0].action).toBe('rewritten');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: {
        'agent-deck': {
          type: 'http',
          url: MCP_URL,
          headers: { 'x-agent-deck-workspace': workspace },
        },
      },
    });
  });
});

describe('upgrade migration-first, codex timeout, add-failure recovery (NOT-576)', { timeout: 30_000 }, () => {
  const MCP_URL = 'http://127.0.0.1:1110/mcp';
  const STALE_VERSION = '1.11.7';
  const LAUNCHER_ENTRY = {
    type: 'stdio',
    command: 'agent-deck',
    args: ['mcp-launch'],
    env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
  };

  let fakeHome = '';
  let workspace = '';
  let stickyCodexHome = '';
  let savedTimeout: string | undefined;
  let savedHost: string | undefined;
  let savedMcpPort: string | undefined;
  let savedXdg: string | undefined;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-576-home-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-576-ws-'));
    savedTimeout = process.env.AGENT_DECK_CODEX_TIMEOUT_MS;
    savedHost = process.env.AGENT_DECK_HOST;
    savedMcpPort = process.env.AGENT_DECK_MCP_PORT;
    savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.AGENT_DECK_MCP_PORT;
    delete process.env.XDG_CONFIG_HOME;
    process.env.AGENT_DECK_HOST = '127.0.0.1';
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedTimeout === undefined) {
      delete process.env.AGENT_DECK_CODEX_TIMEOUT_MS;
    } else {
      process.env.AGENT_DECK_CODEX_TIMEOUT_MS = savedTimeout;
    }
    if (savedHost === undefined) {
      delete process.env.AGENT_DECK_HOST;
    } else {
      process.env.AGENT_DECK_HOST = savedHost;
    }
    if (savedMcpPort === undefined) {
      delete process.env.AGENT_DECK_MCP_PORT;
    } else {
      process.env.AGENT_DECK_MCP_PORT = savedMcpPort;
    }
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    if (stickyCodexHome) {
      fs.rmSync(stickyCodexHome, { recursive: true, force: true });
      stickyCodexHome = '';
    }
    fakeHome = '';
    workspace = '';
  });

  function seedLegacyProjectEntry(): string {
    const configPath = path.join(workspace, '.mcp.json');
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ mcpServers: { 'agent-deck': LAUNCHER_ENTRY } }, null, 2)}\n`,
    );
    return configPath;
  }

  function firstPluginLineIndex(): number {
    return output.findIndex((line) => line.includes('Codex plugin'));
  }

  it('migrates the legacy entry before the plugin step even when every codex call fails', async () => {
    const configPath = seedLegacyProjectEntry();
    const failingRunner = async () => ({ code: 1, stdout: '', stderr: 'stub codex: always fails' });

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
      codexRunner: failingRunner,
    });

    expect(code).toBe(1);
    const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(rewritten.mcpServers['agent-deck']).toEqual({
      type: 'http',
      url: MCP_URL,
      headers: { 'x-agent-deck-workspace': workspace },
    });
    const rewrittenIdx = output.findIndex((line) => line.includes('rewrote legacy launcher entry'));
    const pluginIdx = firstPluginLineIndex();
    expect(rewrittenIdx).toBeGreaterThanOrEqual(0);
    expect(pluginIdx).toBeGreaterThanOrEqual(0);
    expect(rewrittenIdx).toBeLessThan(pluginIdx);
  });

  it('kills a never-resolving runner after AGENT_DECK_CODEX_TIMEOUT_MS and still migrates', async () => {
    const configPath = seedLegacyProjectEntry();
    process.env.AGENT_DECK_CODEX_TIMEOUT_MS = '200';
    const hangingRunner = () => new Promise<never>(() => {});
    const startedAt = Date.now();

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
      codexRunner: hangingRunner,
    });
    const elapsed = Date.now() - startedAt;

    expect(code).toBe(1);
    expect(elapsed).toBeLessThan(10_000);
    const text = output.join('\n');
    expect(text).toContain('timed out after 200ms');
    expect(text).toContain('codex plugin list --available --json');
    const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(rewritten.mcpServers['agent-deck'].type).toBe('http');
    const rewrittenIdx = output.findIndex((line) => line.includes('rewrote legacy launcher entry'));
    const pluginIdx = firstPluginLineIndex();
    expect(rewrittenIdx).toBeGreaterThanOrEqual(0);
    expect(pluginIdx).toBeGreaterThanOrEqual(0);
    expect(rewrittenIdx).toBeLessThan(pluginIdx);
  });

  it('prints the cache-clearing recovery when add fails with Directory not empty after remove', async () => {
    const configPath = seedLegacyProjectEntry();
    stickyCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-576-codex-'));
    process.env.CODEX_HOME = stickyCodexHome;
    const marketplaceRoot = path.join(stickyCodexHome, 'marketplace', 'agent-deck');
    fs.mkdirSync(marketplaceRoot, { recursive: true });
    const installedCacheRoot = path.join(
      stickyCodexHome,
      'plugins',
      'cache',
      'agent-deck',
      'agent-deck',
      STALE_VERSION,
    );
    fs.mkdirSync(installedCacheRoot, { recursive: true });
    fs.writeFileSync(
      path.join(installedCacheRoot, '.mcp.json'),
      `${JSON.stringify(LAUNCH_MCP, null, 2)}\n`,
    );

    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'plugin' && args[1] === 'list') {
        return {
          code: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: SELECTOR,
                name: 'agent-deck',
                marketplaceName: 'agent-deck',
                version: STALE_VERSION,
                installed: true,
                enabled: true,
                source: { source: 'local', path: marketplaceRoot },
                marketplaceSource: { sourceType: 'local', source: marketplaceRoot },
              },
            ],
            available: [],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'list') {
        return {
          code: 0,
          stdout: JSON.stringify({
            marketplaces: [{ name: 'agent-deck', root: marketplaceRoot, source: 'local' }],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugin' && args[1] === 'remove') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'plugin' && args[1] === 'add') {
        return {
          code: 1,
          stdout: '',
          stderr: 'failed to activate plugin cache entry: Directory not empty (os error 66)',
        };
      }
      return { code: 1, stdout: '', stderr: `unexpected invocation: ${args.join(' ')}` };
    };

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
      codexRunner: runner,
    });
    const text = output.join('\n');

    expect(code).toBe(1);
    expect(text).toContain('Codex plugin removed but reinstall failed');
    expect(text).toContain('Directory not empty');
    const rmLine = `rm -rf "${installedCacheRoot}"`;
    const addLine = `codex plugin add ${SELECTOR}`;
    expect(text).toContain(rmLine);
    expect(text).toContain(addLine);
    expect(text.indexOf(rmLine)).toBeLessThan(text.indexOf(addLine));
    const mutating = calls.filter((args) => args[0] === 'plugin' && (args[1] === 'remove' || args[1] === 'add'));
    expect(mutating).toEqual([
      ['plugin', 'remove', SELECTOR],
      ['plugin', 'add', SELECTOR],
    ]);
    expect(fs.existsSync(installedCacheRoot)).toBe(true);
    const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(rewritten.mcpServers['agent-deck'].type).toBe('http');
    const rewrittenIdx = output.findIndex((line) => line.includes('rewrote legacy launcher entry'));
    const pluginIdx = firstPluginLineIndex();
    expect(rewrittenIdx).toBeGreaterThanOrEqual(0);
    expect(pluginIdx).toBeGreaterThanOrEqual(0);
    expect(rewrittenIdx).toBeLessThan(pluginIdx);
  });
});
