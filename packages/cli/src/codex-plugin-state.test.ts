import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectCodexPlugin, runCodexPluginDoctor } from './codex-plugin';
import { runDoctor } from './start';
import { getAgentDeckVersion } from './version';

const CLI_VERSION = getAgentDeckVersion();
const SELECTOR = 'agent-deck@agent-deck';

const LIST_STUB = `#!/bin/bash
echo "codex $*" >> "$CODEX_HOME/calls.log"
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  cat "$CODEX_HOME/plugin-list.json"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "marketplace" ] && [ "$3" = "list" ]; then
  cat "$CODEX_HOME/marketplace-list.json"
  exit 0
fi
echo "stub codex: unexpected invocation: $*" >&2
exit 1
`;

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

function startCapture() {
  output = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
}

function stopCapture() {
  console.log = originalLog;
  console.error = originalError;
}

function seedCodexHome(pluginVersion: string, mcp: unknown): void {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-home-'));
  pluginRoot = path.join(codexHome, 'roots', 'agent-deck');
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
  fs.writeFileSync(
    path.join(codexHome, 'plugin-list.json'),
    `${JSON.stringify(
      {
        plugins: [
          {
            name: 'agent-deck',
            version: pluginVersion,
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
    `${JSON.stringify(
      { marketplaces: [{ name: 'agent-deck', root: pluginRoot, source: 'local' }] },
      null,
      2,
    )}\n`,
  );
  const stub = path.join(codexHome, 'codex');
  fs.writeFileSync(stub, LIST_STUB.replaceAll('$CODEX_HOME', codexHome));
  fs.chmodSync(stub, 0o755);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_BIN = stub;
}

function hashFixtures(): string {
  const hash = crypto.createHash('sha256');
  for (const relative of ['plugin-list.json', 'marketplace-list.json', path.join('roots', 'agent-deck', '.mcp.json')]) {
    hash.update(fs.readFileSync(path.join(codexHome, relative)));
  }
  return hash.digest('hex');
}

beforeEach(() => {
  savedCodexBin = process.env.CODEX_BIN;
  savedCodexHome = process.env.CODEX_HOME;
  startCapture();
});

afterEach(() => {
  stopCapture();
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

describe('doctor codex plugin state (NOT-188)', () => {
  it('fails read-only on a legacy direct-HTTP 1.4.4 plugin', async () => {
    seedCodexHome('1.4.4', LEGACY_MCP);
    // Isolated fixture home: never the developer's real ~/.codex.
    expect(process.env.CODEX_HOME).toBe(codexHome);
    expect(path.dirname(codexHome)).toBe(path.resolve(os.tmpdir()));
    const before = hashFixtures();

    const code = await runDoctor();
    const text = output.join('\n');

    // The Codex section itself diagnoses the stale plugin...
    expect(await runCodexPluginDoctor(CLI_VERSION)).toBe(1);
    // ...and the full doctor run surfaces it too.
    expect(code).toBe(1);
    expect(text).toContain(`installed 1.4.4`);
    expect(text).toContain(`expected ${CLI_VERSION}`);
    expect(text).toContain(SELECTOR);
    expect(text).toContain('legacy-http');
    expect(text).toContain(`codex plugin remove ${SELECTOR}`);

    // Read-only: no fixture file changed and no mutating Codex command ran.
    expect(hashFixtures()).toBe(before);
    const calls = fs.readFileSync(path.join(codexHome, 'calls.log'), 'utf8');
    expect(calls).toContain('codex plugin list --available --json');
    expect(calls).not.toContain('plugin remove');
    expect(calls).not.toContain('plugin add');
    expect(calls).not.toContain('marketplace upgrade');
  });

  it('fails when the version matches but the transport is unverifiable', async () => {
    seedCodexHome(CLI_VERSION, { mcpServers: {} });
    const before = hashFixtures();

    // A matching version with an unreadable/missing/unrecognised .mcp.json
    // is never "compatible": compatible requires a verified mcp-launch.
    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.classification).toBe('unknown-transport');

    output.length = 0;
    const code = await runCodexPluginDoctor(CLI_VERSION);
    const text = output.join('\n');

    expect(code).toBe(1);
    expect(text).toContain('unknown-transport');
    expect(text).toContain('Transport: unknown');
    expect(text).toContain(`codex plugin remove ${SELECTOR}`);
    expect(text).not.toContain('Codex plugin: OK (');

    // Read-only: no fixture file changed and no mutating Codex command ran.
    expect(hashFixtures()).toBe(before);
    const calls = fs.readFileSync(path.join(codexHome, 'calls.log'), 'utf8');
    expect(calls).not.toContain('plugin remove');
    expect(calls).not.toContain('plugin add');
  });

  it('reports one OK line for a current mcp-launch plugin', async () => {
    seedCodexHome(CLI_VERSION, LAUNCH_MCP);
    const before = hashFixtures();

    const sectionCode = await runCodexPluginDoctor(CLI_VERSION);
    expect(sectionCode).toBe(0);

    output.length = 0;
    await runDoctor();
    const lines = output.join('\n').split('\n');
    // NOTE: full `doctor` exit 0 additionally requires host checks (sqlite
    // native, backend entry) that a bare checkout may not satisfy, so the
    // exit code is asserted on the Codex section above; here we assert what
    // doctor prints for a healthy plugin.
    expect(lines).toContain(`Codex plugin: OK (${CLI_VERSION}, mcp-launch)`);

    expect(hashFixtures()).toBe(before);
  });
});

describe('current Codex plugin-list contract (NOT-301)', () => {
  /**
   * Sanitized capture matching `codex plugin list --available --json` from
   * Codex CLI 0.157.1: `installed[]` carries pluginId / marketplaceName /
   * installed / enabled / nested source.path, while `available[]` is
   * discovery-only. Fixture home is isolated temp; never the real CODEX_HOME.
   */
  function seedCurrentShapeHome(opts: {
    installedVersion?: string;
    enabled?: boolean;
    installedFlag?: boolean;
    includeInstalledEntry?: boolean;
    mcp?: unknown;
  }): void {
    const {
      installedVersion = '1.11.7',
      enabled = true,
      installedFlag = true,
      includeInstalledEntry = true,
      mcp = LAUNCH_MCP,
    } = opts;
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-current-'));
    pluginRoot = path.join(codexHome, 'roots', 'agent-deck');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
    const installed = includeInstalledEntry
      ? [
          {
            pluginId: SELECTOR,
            name: 'agent-deck',
            marketplaceName: 'agent-deck',
            version: installedVersion,
            installed: installedFlag,
            enabled,
            source: { source: 'local', path: pluginRoot },
            marketplaceSource: { sourceType: 'local', source: pluginRoot },
          },
        ]
      : [];
    fs.writeFileSync(
      path.join(codexHome, 'plugin-list.json'),
      `${JSON.stringify(
        {
          installed,
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
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(codexHome, 'marketplace-list.json'),
      `${JSON.stringify(
        { marketplaces: [{ name: 'agent-deck', root: pluginRoot, source: 'local' }] },
        null,
        2,
      )}\n`,
    );
    const stub = path.join(codexHome, 'codex');
    fs.writeFileSync(stub, LIST_STUB.replaceAll('$CODEX_HOME', codexHome));
    fs.chmodSync(stub, 0o755);
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_BIN = stub;
  }

  it('classifies installed[] agent-deck@agent-deck 1.11.7 as version-mismatch, not missing', async () => {
    seedCurrentShapeHome({});
    // Isolated fixture home: never the developer's real ~/.codex.
    expect(process.env.CODEX_HOME).toBe(codexHome);
    expect(path.dirname(codexHome)).toBe(path.resolve(os.tmpdir()));
    const before = hashFixtures();

    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.classification).toBe('version-mismatch');
    expect(state.selector).toBe(SELECTOR);
    expect(state.installedVersion).toBe('1.11.7');
    expect(state.root).toBe(pluginRoot);

    output.length = 0;
    expect(await runCodexPluginDoctor(CLI_VERSION)).toBe(1);
    expect(output.join('\n')).toContain(SELECTOR);

    // Read-only: no fixture file changed and no mutating Codex command ran.
    expect(hashFixtures()).toBe(before);
    const calls = fs.readFileSync(path.join(codexHome, 'calls.log'), 'utf8');
    expect(calls).not.toContain('plugin remove');
    expect(calls).not.toContain('plugin add');
  });

  it('ignores an available[]-only stale agent-deck@agent-deck-dev entry', async () => {
    seedCurrentShapeHome({ includeInstalledEntry: false });
    const before = hashFixtures();

    const state = await inspectCodexPlugin(CLI_VERSION);
    // Discovery-only rows must never classify as installed or ambiguous.
    expect(state.classification).toBe('missing');

    expect(hashFixtures()).toBe(before);
  });

  it('leaves an installed[] entry with enabled:false untouched', async () => {
    seedCurrentShapeHome({ enabled: false });
    const before = hashFixtures();

    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.classification).toBe('disabled');
    expect(state.selector).toBe(SELECTOR);

    output.length = 0;
    expect(await runCodexPluginDoctor(CLI_VERSION)).toBe(1);

    expect(hashFixtures()).toBe(before);
    const calls = fs.readFileSync(path.join(codexHome, 'calls.log'), 'utf8');
    expect(calls).not.toContain('plugin remove');
    expect(calls).not.toContain('plugin add');
  });

  it('treats an installed[] entry with installed:false as not installed', async () => {
    seedCurrentShapeHome({ installedFlag: false });
    const before = hashFixtures();

    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.classification).toBe('missing');

    expect(hashFixtures()).toBe(before);
    const calls = fs.readFileSync(path.join(codexHome, 'calls.log'), 'utf8');
    expect(calls).not.toContain('plugin remove');
    expect(calls).not.toContain('plugin add');
  });
});

describe('sticky versioned cache (NOT-360)', () => {
  const STALE_VERSION = '1.11.7';

  /**
   * Live failure shape: the local marketplace workspace already carries the
   * new `plugin.json`, Codex lists the workspace as the source path, but the
   * served version is stale because a versioned copy survives under
   * `<CODEX_HOME>/plugins/cache/agent-deck/agent-deck/<old>/`. Fixture home
   * is isolated temp; never the developer's real CODEX_HOME.
   */
  function seedStickyCacheHome(sourcePath: 'marketplace' | 'cache'): {
    marketplaceRoot: string;
    installedCacheRoot: string;
  } {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-sticky-'));
    const marketplaceRoot = path.join(codexHome, 'marketplace', 'agent-deck');
    fs.mkdirSync(path.join(marketplaceRoot, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceRoot, '.codex-plugin', 'plugin.json'),
      `${JSON.stringify({ name: 'agent-deck', version: CLI_VERSION }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(marketplaceRoot, '.mcp.json'),
      `${JSON.stringify(LAUNCH_MCP, null, 2)}\n`,
    );
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
    pluginRoot = marketplaceRoot;
    const listedPath = sourcePath === 'cache' ? installedCacheRoot : marketplaceRoot;
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
              source: { source: 'local', path: listedPath },
              marketplaceSource: { sourceType: 'local', source: marketplaceRoot },
            },
          ],
          available: [],
        },
        null,
        2,
      )}\n`,
    );
    fs.writeFileSync(
      path.join(codexHome, 'marketplace-list.json'),
      `${JSON.stringify(
        { marketplaces: [{ name: 'agent-deck', root: marketplaceRoot, source: 'local' }] },
        null,
        2,
      )}\n`,
    );
    const stub = path.join(codexHome, 'codex');
    fs.writeFileSync(stub, LIST_STUB.replaceAll('$CODEX_HOME', codexHome));
    fs.chmodSync(stub, 0o755);
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_BIN = stub;
    return { marketplaceRoot, installedCacheRoot };
  }

  it('classifies version-mismatch with the installed cache root, not the marketplace path', async () => {
    const { marketplaceRoot, installedCacheRoot } = seedStickyCacheHome('marketplace');
    expect(process.env.CODEX_HOME).toBe(codexHome);
    expect(path.dirname(codexHome)).toBe(path.resolve(os.tmpdir()));

    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.classification).toBe('version-mismatch');
    expect(state.installedVersion).toBe(STALE_VERSION);
    expect(state.marketplaceRoot).toBe(marketplaceRoot);
    expect(state.installedRoot).toBe(installedCacheRoot);

    output.length = 0;
    expect(await runCodexPluginDoctor(CLI_VERSION)).toBe(1);
    const text = output.join('\n');
    expect(text).toContain(`Marketplace root: ${marketplaceRoot} (local)`);
    expect(text).toContain(`Installed root: ${installedCacheRoot}`);
    expect(text).toContain(`rm -rf "${installedCacheRoot}"`);
    expect(text).toContain(`codex plugin add ${SELECTOR}`);
    // The marketplace workspace checkout itself is never an rm target.
    expect(text).not.toContain(`rm -rf "${marketplaceRoot}"`);

    const calls = fs.readFileSync(path.join(codexHome, 'calls.log'), 'utf8');
    expect(calls).not.toContain('plugin remove');
    expect(calls).not.toContain('plugin add');
  });

  it('reports the cache root when plugin list already points at it', async () => {
    const { installedCacheRoot } = seedStickyCacheHome('cache');

    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.classification).toBe('version-mismatch');
    expect(state.installedRoot).toBe(installedCacheRoot);

    output.length = 0;
    expect(await runCodexPluginDoctor(CLI_VERSION)).toBe(1);
    expect(output.join('\n')).toContain(`rm -rf "${installedCacheRoot}"`);
  });

  it('never suggests rm -rf for a non-cache installed root', async () => {
    const { marketplaceRoot } = seedStickyCacheHome('marketplace');
    // Remove the versioned cache: the installed root falls back to the
    // listed workspace path, which must never be an rm target.
    fs.rmSync(
      path.join(codexHome, 'plugins', 'cache', 'agent-deck', 'agent-deck', STALE_VERSION),
      { recursive: true, force: true },
    );

    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.classification).toBe('version-mismatch');
    expect(state.installedRoot).toBe(marketplaceRoot);

    output.length = 0;
    expect(await runCodexPluginDoctor(CLI_VERSION)).toBe(1);
    expect(output.join('\n')).not.toContain('rm -rf');
  });
});

describe('pre-publish release sync (NOT-188)', () => {
  const script = path.join(__dirname, '..', '..', '..', 'scripts', 'pre-publish-check.mjs');

  function makeFixture(opts: { version?: string; mcp?: unknown }): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-sync-'));
    const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify({ name: 'agent-deck', version: rootPkg.version }, null, 2)}\n`,
    );
    for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
      fs.mkdirSync(path.join(dir, path.dirname(manifest)), { recursive: true });
      fs.writeFileSync(
        path.join(dir, manifest),
        `${JSON.stringify({ name: 'agent-deck', version: opts.version ?? rootPkg.version }, null, 2)}\n`,
      );
    }
    fs.writeFileSync(path.join(dir, '.mcp.json'), `${JSON.stringify(opts.mcp ?? LAUNCH_MCP, null, 2)}\n`);
    return dir;
  }

  it('passes for the synchronized fixture', () => {
    const dir = makeFixture({});
    try {
      execFileSync(process.execPath, [script, '--root', dir, '--sync-only'], { stdio: 'pipe' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a plugin manifest version drifts', () => {
    const dir = makeFixture({ version: '1.4.4' });
    try {
      expect(() =>
        execFileSync(process.execPath, [script, '--root', dir, '--sync-only'], { stdio: 'pipe' }),
      ).toThrow(/plugin\.json/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when .mcp.json does not invoke agent-deck mcp-launch', () => {
    const dir = makeFixture({ mcp: LEGACY_MCP });
    try {
      expect(() =>
        execFileSync(process.execPath, [script, '--root', dir, '--sync-only'], { stdio: 'pipe' }),
      ).toThrow(/mcp-launch/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
