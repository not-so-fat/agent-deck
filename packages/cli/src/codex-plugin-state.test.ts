import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCodexPluginDoctor } from './codex-plugin';
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
