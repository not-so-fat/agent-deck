import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Headerless HTTP bytes: the 1.4.4-era shape and the current global
// fallback shape are identical — legacy only by installed version.
const HTTP_MCP = {
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

function seedCodexHome(pluginVersion: string, mcp: unknown, opts: { skipMcp?: boolean } = {}): void {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-home-'));
  pluginRoot = path.join(codexHome, 'roots', 'agent-deck');
  fs.mkdirSync(pluginRoot, { recursive: true });
  if (!opts.skipMcp) {
    fs.writeFileSync(path.join(pluginRoot, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
  }
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

function seedEmptyCodexHome(): void {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-home-'));
  pluginRoot = path.join(codexHome, 'roots', 'agent-deck');
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'plugin-list.json'),
    `${JSON.stringify({ plugins: [] }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(codexHome, 'marketplace-list.json'),
    `${JSON.stringify({ marketplaces: [] }, null, 2)}\n`,
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
  vi.restoreAllMocks();
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
    seedCodexHome('1.4.4', HTTP_MCP);
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
    // An unrecognised entry shape (not the legacy launcher, not HTTP, not
    // absent) is unverifiable. A missing .mcp.json or an empty mcpServers
    // map is the current skills-only shape — valid, covered below.
    seedCodexHome(CLI_VERSION, {
      mcpServers: { 'agent-deck': { command: 'custom-wrapper', args: ['serve'] } },
    });
    const before = hashFixtures();

    // A matching version with an unreadable/unrecognised entry is never
    // "compatible": compatible requires a verified transport.
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

  it('reports a manifest-only line for a current mcp-launch plugin', async () => {
    seedCodexHome(CLI_VERSION, LAUNCH_MCP);
    const before = hashFixtures();

    const sectionCode = await runCodexPluginDoctor(CLI_VERSION);
    expect(sectionCode).toBe(0);
    expect(output.join('\n')).toContain(
      `Codex plugin manifest: OK (${CLI_VERSION}, mcp-launch) (manifest-only, connection not verified)`,
    );
    expect(output.join('\n')).not.toContain('Codex plugin: OK (');

    output.length = 0;
    await runDoctor({ daemonHealth: { up: false, liveSessions: 0 } });
    const lines = output.join('\n').split('\n');
    // NOTE: full `doctor` exit 0 additionally requires host checks (sqlite
    // native, backend entry) that a bare checkout may not satisfy, so the
    // exit code is asserted on the Codex section above; here we assert what
    // doctor prints for a healthy plugin.
    expect(lines).toContain(
      `Codex plugin manifest: OK (${CLI_VERSION}, mcp-launch) (manifest-only, connection not verified)`,
    );
    expect(output.join('\n')).not.toContain('Codex plugin: OK (');

    expect(hashFixtures()).toBe(before);
  });
});

describe('honest host connection state (NOT-564, classifier NOT-574)', () => {
  const MANIFEST_LINE =
    `Codex plugin manifest: OK (${CLI_VERSION}, mcp-launch) (manifest-only, connection not verified)`;

  function readCallsLog(): string {
    return fs.readFileSync(path.join(codexHome, 'calls.log'), 'utf8');
  }

  it('plugin doctor prints manifest health only, never a connection line', async () => {
    seedCodexHome(CLI_VERSION, LAUNCH_MCP);
    expect(await runCodexPluginDoctor(CLI_VERSION)).toBe(0);
    const text = output.join('\n');
    expect(text).toContain(MANIFEST_LINE);
    expect(text).not.toContain('connection:');
    expect(text).not.toContain('Codex plugin: OK (');

    const calls = readCallsLog();
    expect(calls).not.toContain('plugin remove');
    expect(calls).not.toContain('plugin add');
  });

  it('doctor reports the classifier no-entry state for Codex with no TOML entries', async () => {
    seedEmptyCodexHome();
    expect(process.env.CODEX_HOME).toBe(codexHome);

    expect(await runCodexPluginDoctor(CLI_VERSION)).toBe(0);
    expect(output.join('\n')).toContain('WARN: Codex plugin not installed');
    expect(output.join('\n')).not.toContain('connection:');

    output.length = 0;
    await runDoctor({ daemonHealth: { up: true, liveSessions: 2 } });
    const text = output.join('\n');
    expect(text).toContain('Host connections (pure MCP, read-only):');
    expect(text).toContain('Codex connection: no-entry');
    expect(text).toContain('agent-deck setup --client codex');
    expect(text).not.toContain('Codex plugin: OK (');

    const calls = readCallsLog();
    expect(calls).not.toContain('plugin remove');
    expect(calls).not.toContain('plugin add');
  });

  it('doctor reports entry-daemon-down for Codex with an entry and a stopped daemon', async () => {
    seedCodexHome(CLI_VERSION, LAUNCH_MCP);
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      ['[mcp_servers.agent-deck]', 'url = "http://127.0.0.1:1110/mcp"', ''].join('\n'),
    );

    await runDoctor({ daemonHealth: { up: false, liveSessions: 0 } });
    const text = output.join('\n');
    expect(text).toContain(MANIFEST_LINE);
    expect(text).toContain('Codex connection: entry-daemon-down');
    expect(text).toContain('agent-deck start');
    expect(text).not.toContain('Codex plugin: OK (');

    const calls = readCallsLog();
    expect(calls).not.toContain('plugin remove');
    expect(calls).not.toContain('plugin add');
  });

  it('doctor reports connected for Codex with an entry and a live session', async () => {
    seedCodexHome(CLI_VERSION, LAUNCH_MCP);
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      ['[mcp_servers.agent-deck]', 'url = "http://127.0.0.1:1110/mcp"', ''].join('\n'),
    );

    await runDoctor({ daemonHealth: { up: true, liveSessions: 1 } });
    const text = output.join('\n');
    expect(text).toContain('Codex connection: connected');
    expect(text).toContain('No action needed');
    expect(text).not.toContain('Codex plugin: OK (');

    const calls = readCallsLog();
    expect(calls).not.toContain('plugin remove');
    expect(calls).not.toContain('plugin add');
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

describe('launcher-free plugin connection (NOT-565)', () => {
  it('ships Codex and Claude plugin manifests with no MCP server at all', () => {
    const repositoryRoot = path.join(__dirname, '..', '..', '..');
    for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
      const raw = fs.readFileSync(path.join(repositoryRoot, manifest), 'utf8');
      expect(raw).not.toContain('mcp-launch');
      expect(raw).not.toContain('"command"');
      expect(raw).not.toContain('mcpServers');
      const shipped = JSON.parse(raw) as { mcpServers?: unknown };
      expect(shipped.mcpServers).toBeUndefined();
    }
    // No plugin-shipped connection file: the Codex/Claude connection is
    // plain host MCP config (global fallback + per-folder entry).
    expect(fs.existsSync(path.join(repositoryRoot, '.mcp.json'))).toBe(false);
  });

  it('still recognises the legacy bare agent-deck mcp-launch shape', async () => {
    seedCodexHome(CLI_VERSION, LAUNCH_MCP);
    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.transport).toBe('mcp-launch');
    expect(state.classification).toBe('compatible');
  });

  it('classifies the earlier headerless HTTP shape as direct-http, not unknown', async () => {
    seedCodexHome(CLI_VERSION, HTTP_MCP);
    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.transport).toBe('direct-http');
    expect(state.classification).toBe('compatible');
  });

  it('treats a missing plugin .mcp.json as no declared server, not unknown', async () => {
    seedCodexHome(CLI_VERSION, HTTP_MCP, { skipMcp: true });
    expect(fs.existsSync(path.join(pluginRoot, '.mcp.json'))).toBe(false);
    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.transport).toBe('none');
    expect(state.classification).toBe('compatible');
  });

  it('treats an empty plugin mcpServers map as no declared server, not unknown', async () => {
    seedCodexHome(CLI_VERSION, { mcpServers: {} });
    const state = await inspectCodexPlugin(CLI_VERSION);
    expect(state.transport).toBe('none');
    expect(state.classification).toBe('compatible');
  });

  it('reports the no-server transport on the manifest-only doctor line', async () => {
    seedCodexHome(CLI_VERSION, { mcpServers: {} });
    expect(await runCodexPluginDoctor(CLI_VERSION)).toBe(0);
    expect(output.join('\n')).toContain(
      `Codex plugin manifest: OK (${CLI_VERSION}, none) (manifest-only, connection not verified)`,
    );
    expect(output.join('\n')).not.toContain('Codex plugin: OK (');
  });
});

describe('pre-publish release sync (NOT-188)', () => {
  const script = path.join(__dirname, '..', '..', '..', 'scripts', 'pre-publish-check.mjs');

  function makeFixture(opts: { version?: string; mcp?: unknown; mcpServers?: unknown }): string {
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
      const body: Record<string, unknown> = {
        name: 'agent-deck',
        version: opts.version ?? rootPkg.version,
      };
      if (opts.mcpServers !== undefined) {
        body.mcpServers = opts.mcpServers;
      }
      fs.writeFileSync(path.join(dir, manifest), `${JSON.stringify(body, null, 2)}\n`);
    }
    // No shipped .mcp.json by default: the plugins declare no MCP server.
    if (opts.mcp !== undefined) {
      fs.writeFileSync(path.join(dir, '.mcp.json'), `${JSON.stringify(opts.mcp, null, 2)}\n`);
    }
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

  it('NOT-565: fails when a plugin manifest declares an MCP server', () => {
    const dir = makeFixture({ mcpServers: './.mcp.json' });
    try {
      expect(() =>
        execFileSync(process.execPath, [script, '--root', dir, '--sync-only'], { stdio: 'pipe' }),
      ).toThrow(/declares an MCP server/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NOT-565: fails when a shipped .mcp.json carries an agent-deck server', () => {
    const dir = makeFixture({ mcp: HTTP_MCP });
    try {
      expect(() =>
        execFileSync(process.execPath, [script, '--root', dir, '--sync-only'], { stdio: 'pipe' }),
      ).toThrow(/carries an agent-deck server/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
