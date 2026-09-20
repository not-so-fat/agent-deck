import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runUpgrade } from './upgrade';
import { getAgentDeckVersion } from './version';

const CLI_VERSION = getAgentDeckVersion();
const SELECTOR = 'agent-deck@agent-deck';

const LEGACY_MCP = {
  mcpServers: { 'agent-deck': { type: 'http', url: 'http://127.0.0.1:1110/mcp' } },
};

const LAUNCH_MCP = {
  mcpServers: { 'agent-deck': { type: 'stdio', command: 'agent-deck', args: ['mcp-launch'] } },
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
 * One installed plugin at 1.4.4 with legacy direct-HTTP transport; the stub
 * promotes it to the post-upgrade state on `plugin add`. Each test writes its
 * own marketplace-list.json via writeMarketplaces().
 */
function seedUpgradeHome(): void {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-up-'));
  pluginRoot = path.join(codexHome, 'roots', 'agent-deck');
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify(LEGACY_MCP, null, 2)}\n`);
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
  fs.writeFileSync(path.join(after, 'mcp.json'), `${JSON.stringify(LAUNCH_MCP, null, 2)}\n`);
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

describe('upgrade codex plugin reconciliation (NOT-188)', () => {
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
    expect(text).toContain(`Codex plugin: OK (${CLI_VERSION}, mcp-launch)`);
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
      fs.writeFileSync(path.join(root, '.mcp.json'), `${JSON.stringify(LEGACY_MCP, null, 2)}\n`);
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

  it('fails the re-read when the reinstalled plugin still lacks mcp-launch', async () => {
    seedUpgradeHome();
    writeMarketplaces([{ name: 'agent-deck', root: pluginRoot, source: 'local' }]);
    // The reinstall "succeeds" but leaves the legacy direct-HTTP transport.
    fs.writeFileSync(path.join(codexHome, 'after', 'mcp.json'), `${JSON.stringify(LEGACY_MCP, null, 2)}\n`);

    const code = await runUpgrade(['--to', CLI_VERSION], {
      performCliUpgrade: async () => ({ ok: true }),
    });
    const text = output.join('\n');
    const calls = readCalls();

    expect(code).toBe(1);
    expect(calls).toContain(`codex plugin remove ${SELECTOR}`);
    expect(calls).toContain(`codex plugin add ${SELECTOR}`);
    expect(text).not.toContain('Codex plugin: OK (');
    expect(text).toContain('still legacy-http');
    expect(text).toContain(`codex plugin add ${SELECTOR}`);
  });
});
