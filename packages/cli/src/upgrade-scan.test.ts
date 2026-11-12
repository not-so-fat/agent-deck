import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatLauncherMigrationResults,
  rewriteLegacyLauncherEntries,
  rewriteScanFolders,
} from './launcher-migration';
import { runUpgrade } from './upgrade';
import { SCAN_MAX_DEPTH, findAssignedFolders, parseScanDirs } from './upgrade-scan';
import { getAgentDeckVersion } from './version';

const CLI_VERSION = getAgentDeckVersion();
const MCP_URL = 'http://127.0.0.1:1110/mcp';

const CLAUDE_LAUNCHER = {
  type: 'stdio',
  command: 'agent-deck',
  args: ['mcp-launch'],
  env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
};
const MUSE_LAUNCHER = {
  command: 'agent-deck',
  args: ['mcp-launch'],
  env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
};
const CURSOR_LAUNCHER = {
  command: 'agent-deck',
  args: ['mcp-launch'],
  env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
};
const MEMORY_SERVER = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] };
const CUSTOM_CURSOR_ENTRY = { command: 'npx', args: ['-y', 'custom-cursor-wrapper'] };

let fakeHome = '';
let fixtureRoot = '';
let deckHome = '';
let savedDeckHome: string | undefined;
let savedFetch: typeof globalThis.fetch | undefined;
let savedMcpPort: string | undefined;
let savedHost: string | undefined;
let savedXdg: string | undefined;
let output: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalWarn: typeof console.warn;

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function writeUseJson(folder: string): void {
  writeJson(path.join(folder, '.agent-deck', 'use.json'), {
    version: 3,
    deckId: 'deck-1',
    deckName: 'dev',
  });
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Acceptance tree: four assigned folders (Claude-shaped `.mcp.json`,
 * Codex TOML, Muse-shaped `.mcp.json`, Cursor `.cursor/mcp.json`) plus
 * one unassigned folder and one assigned folder under `node_modules`.
 */
function seedAcceptanceTree(): {
  claudeFolder: string;
  codexFolder: string;
  museFolder: string;
  cursorFolder: string;
  unassignedFolder: string;
  nodeModulesFolder: string;
} {
  const claudeFolder = path.join(fixtureRoot, 'folder-claude');
  const codexFolder = path.join(fixtureRoot, 'folder-codex');
  const museFolder = path.join(fixtureRoot, 'folder-muse');
  const cursorFolder = path.join(fixtureRoot, 'folder-cursor');
  const unassignedFolder = path.join(fixtureRoot, 'folder-unassigned');
  const nodeModulesFolder = path.join(fixtureRoot, 'node_modules', 'pkg');

  writeUseJson(claudeFolder);
  writeJson(path.join(claudeFolder, '.mcp.json'), {
    mcpServers: { memory: MEMORY_SERVER, 'agent-deck': CLAUDE_LAUNCHER },
  });

  writeUseJson(codexFolder);
  fs.mkdirSync(path.join(codexFolder, '.codex'), { recursive: true });
  fs.writeFileSync(
    path.join(codexFolder, '.codex', 'config.toml'),
    '[model]\nname = "gpt-5"\n\n[mcp_servers.agent-deck]\ncommand = "agent-deck"\nargs = ["mcp-launch"]\n',
    'utf8',
  );

  writeUseJson(museFolder);
  writeJson(path.join(museFolder, '.mcp.json'), {
    mcpServers: { memory: MEMORY_SERVER, 'agent-deck': MUSE_LAUNCHER },
  });

  writeUseJson(cursorFolder);
  writeJson(path.join(cursorFolder, '.cursor', 'mcp.json'), {
    mcpServers: { memory: MEMORY_SERVER, 'agent-deck': CURSOR_LAUNCHER },
  });

  // No use.json: must be left untouched.
  writeJson(path.join(unassignedFolder, '.mcp.json'), {
    mcpServers: { 'agent-deck': CLAUDE_LAUNCHER },
  });

  // Assigned but under node_modules: must be skipped.
  writeUseJson(nodeModulesFolder);
  writeJson(path.join(nodeModulesFolder, '.mcp.json'), {
    mcpServers: { 'agent-deck': CLAUDE_LAUNCHER },
  });

  return {
    claudeFolder,
    codexFolder,
    museFolder,
    cursorFolder,
    unassignedFolder,
    nodeModulesFolder,
  };
}

beforeEach(() => {
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-scan-home-'));
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-scan-root-'));
  deckHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-scan-deck-'));
  savedDeckHome = process.env.AGENT_DECK_HOME;
  savedFetch = globalThis.fetch;
  savedMcpPort = process.env.AGENT_DECK_MCP_PORT;
  savedHost = process.env.AGENT_DECK_HOST;
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.AGENT_DECK_HOME = deckHome;
  delete process.env.AGENT_DECK_MCP_PORT;
  delete process.env.XDG_CONFIG_HOME;
  process.env.AGENT_DECK_HOST = '127.0.0.1';
  output = [];
  originalLog = console.log;
  originalError = console.error;
  originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  };
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  vi.spyOn(process, 'cwd').mockReturnValue(fixtureRoot);
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
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
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fs.rmSync(deckHome, { recursive: true, force: true });
});

function mockAlreadyLatest(): void {
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ version: CLI_VERSION }),
  })) as typeof globalThis.fetch;
}

describe('upgrade --scan discovery (NOT-577)', () => {
  it('parses repeatable --scan and rejects a missing value', () => {
    expect(parseScanDirs(['--scan', '/a', '--scan', '/b'])).toEqual({ dirs: ['/a', '/b'] });
    expect(parseScanDirs(['--scan=/a'])).toEqual({ dirs: ['/a'] });
    expect(parseScanDirs([])).toEqual({ dirs: [] });
    expect(parseScanDirs(['--scan']).error).toMatch(/requires a directory/);
    expect(parseScanDirs(['--scan', '--check']).error).toMatch(/requires a directory/);
  });

  it('finds assigned folders, skipping unassigned and node_modules', () => {
    const folders = seedAcceptanceTree();
    const found = findAssignedFolders([fixtureRoot]);
    expect(found).toEqual(
      [folders.claudeFolder, folders.codexFolder, folders.museFolder, folders.cursorFolder]
        .map((folder) => path.resolve(folder))
        .sort(),
    );
    expect(found).not.toContain(path.resolve(folders.unassignedFolder));
    expect(found).not.toContain(path.resolve(folders.nodeModulesFolder));
  });

  it('skips .git, .next, .temporal and folders below depth 6', () => {
    expect(SCAN_MAX_DEPTH).toBe(6);
    for (const skipped of ['.git', '.next', '.temporal']) {
      const folder = path.join(fixtureRoot, skipped, 'proj');
      writeUseJson(folder);
    }
    // Depth 6 is included, depth 7 is not (root = depth 0).
    const atSix = path.join(fixtureRoot, 'a', 'b', 'c', 'd', 'e', 'f');
    const atSeven = path.join(atSix, 'g');
    writeUseJson(atSix);
    writeUseJson(atSeven);

    const found = findAssignedFolders([fixtureRoot]);
    expect(found).toContain(path.resolve(atSix));
    expect(found).not.toContain(path.resolve(atSeven));
    for (const skipped of ['.git', '.next', '.temporal']) {
      expect(found).not.toContain(path.resolve(path.join(fixtureRoot, skipped, 'proj')));
    }
  });

  it('accepts repeatable roots and deduplicates', () => {
    const folders = seedAcceptanceTree();
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-scan-extra-'));
    try {
      writeUseJson(extra);
      const found = findAssignedFolders([fixtureRoot, extra, fixtureRoot]);
      expect(found).toContain(path.resolve(extra));
      expect(found).toContain(path.resolve(folders.claudeFolder));
      expect(new Set(found).size).toBe(found.length);
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });
});

describe('upgrade --scan migration (NOT-577)', { timeout: 30_000 }, () => {
  it('rewrites exactly the four assigned folders, leaving the other two untouched', async () => {
    const folders = seedAcceptanceTree();
    const unassignedBefore = hashFile(path.join(folders.unassignedFolder, '.mcp.json'));
    const nodeModulesBefore = hashFile(path.join(folders.nodeModulesFolder, '.mcp.json'));
    mockAlreadyLatest();
    let pluginCalls = 0;
    const codexRunner = async () => {
      pluginCalls += 1;
      return { code: 1, stdout: '', stderr: 'stub codex: always fails' };
    };

    await runUpgrade(['--scan', fixtureRoot], {
      performCliUpgrade: async () => ({ ok: true }),
      codexRunner,
    });

    // The four assigned folders no longer mention the launcher.
    for (const file of [
      path.join(folders.claudeFolder, '.mcp.json'),
      path.join(folders.codexFolder, '.codex', 'config.toml'),
      path.join(folders.museFolder, '.mcp.json'),
      path.join(folders.cursorFolder, '.cursor', 'mcp.json'),
    ]) {
      expect(fs.readFileSync(file, 'utf8')).not.toContain('mcp-launch');
    }
    // The other two are byte-identical.
    expect(hashFile(path.join(folders.unassignedFolder, '.mcp.json'))).toBe(unassignedBefore);
    expect(hashFile(path.join(folders.nodeModulesFolder, '.mcp.json'))).toBe(nodeModulesBefore);
    expect(fs.readFileSync(path.join(folders.unassignedFolder, '.mcp.json'), 'utf8')).toContain(
      'mcp-launch',
    );

    // Spot-check the non-Cursor shapes.
    expect(
      JSON.parse(fs.readFileSync(path.join(folders.claudeFolder, '.mcp.json'), 'utf8')),
    ).toEqual({
      mcpServers: {
        memory: MEMORY_SERVER,
        'agent-deck': {
          type: 'http',
          url: MCP_URL,
          headers: { 'x-agent-deck-workspace': path.resolve(folders.claudeFolder) },
        },
      },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(folders.museFolder, '.mcp.json'), 'utf8')),
    ).toEqual({
      mcpServers: {
        memory: MEMORY_SERVER,
        'agent-deck': {
          type: 'http',
          url: MCP_URL,
          headers: { 'x-agent-deck-workspace': path.resolve(folders.museFolder) },
        },
      },
    });
    expect(
      fs.readFileSync(path.join(folders.codexFolder, '.codex', 'config.toml'), 'utf8'),
    ).toContain(`url = "${MCP_URL}"`);

    // One line per rewritten file plus the count summary; the Codex plugin
    // step ran once for the whole invocation, not once per folder.
    const text = output.join('\n');
    expect(text).toContain('Scan complete: 4 folders, 4 rewritten');
    expect(pluginCalls).toBe(1);
  });

  it('rewrites the Cursor entry to headed HTTP and leaves a custom entry unchanged', () => {
    const folders = seedAcceptanceTree();
    // A second assigned folder whose Cursor agent-deck entry is custom.
    const customFolder = path.join(fixtureRoot, 'folder-cursor-custom');
    writeUseJson(customFolder);
    const customPath = path.join(customFolder, '.cursor', 'mcp.json');
    writeJson(customPath, { mcpServers: { 'agent-deck': CUSTOM_CURSOR_ENTRY } });
    const customBefore = hashFile(customPath);

    const results = rewriteScanFolders(findAssignedFolders([fixtureRoot]), {
      host: '127.0.0.1',
      mcpPort: 1110,
    });

    const cursorPath = path.join(folders.cursorFolder, '.cursor', 'mcp.json');
    const cursorResult = results.find((result) => result.path === cursorPath);
    expect(cursorResult?.action).toBe('rewritten');
    const rewritten = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
    const entry = rewritten.mcpServers['agent-deck'] as Record<string, unknown>;
    expect(entry.url).toBe(MCP_URL);
    expect(String(entry.url)).toMatch(/\/mcp$/);
    expect((entry.headers as Record<string, unknown>)['x-agent-deck-workspace']).toBe(
      path.resolve(folders.cursorFolder),
    );
    expect(entry).not.toHaveProperty('command');
    expect(entry).not.toHaveProperty('args');
    expect(entry).not.toHaveProperty('env');
    // Unrelated servers survive.
    expect(rewritten.mcpServers.memory).toEqual(MEMORY_SERVER);
    // The assignment is untouched.
    expect(
      JSON.parse(fs.readFileSync(path.join(folders.cursorFolder, '.agent-deck', 'use.json'), 'utf8')),
    ).toMatchObject({ deckId: 'deck-1', deckName: 'dev' });

    // Custom Cursor entry: byte-identical.
    expect(hashFile(customPath)).toBe(customBefore);
    expect(results.find((result) => result.path === customPath)?.action).toBe('unchanged');
  });

  it('--check prints planned changes, writes nothing, and a second real run prints no rewrites', async () => {
    const folders = seedAcceptanceTree();
    const tracked = [
      path.join(folders.claudeFolder, '.mcp.json'),
      path.join(folders.codexFolder, '.codex', 'config.toml'),
      path.join(folders.museFolder, '.mcp.json'),
      path.join(folders.cursorFolder, '.cursor', 'mcp.json'),
      path.join(folders.unassignedFolder, '.mcp.json'),
      path.join(folders.nodeModulesFolder, '.mcp.json'),
    ];
    const before = new Map(tracked.map((file) => [file, hashFile(file)]));

    const checkCode = await runUpgrade(['--scan', fixtureRoot, '--check']);
    expect(checkCode).toBe(0);
    const checkText = output.join('\n');
    expect(checkText).toContain('would rewrite');
    expect(checkText).toContain('Scan (check): 4 folders, 4 would rewrite');
    expect(checkText).toContain('no files changed');
    for (const file of tracked) {
      expect(hashFile(file)).toBe(before.get(file));
    }

    // Real run migrates; a second real run reports nothing to change.
    output.length = 0;
    mockAlreadyLatest();
    const failingRunner = async () => ({ code: 1, stdout: '', stderr: 'stub codex: fails' });
    await runUpgrade(['--scan', fixtureRoot], {
      performCliUpgrade: async () => ({ ok: true }),
      codexRunner: failingRunner,
    });
    expect(output.join('\n')).toContain('rewrote legacy launcher entry');

    output.length = 0;
    await runUpgrade(['--scan', fixtureRoot], {
      performCliUpgrade: async () => ({ ok: true }),
      codexRunner: failingRunner,
    });
    const secondText = output.join('\n');
    expect(secondText).not.toContain('rewrote legacy launcher entry');
    expect(secondText).not.toContain('would rewrite');
    expect(secondText).toContain('Scan complete: 4 folders, 0 rewritten');
  });

  it('plain upgrade still leaves Cursor project entries alone', () => {
    const folders = seedAcceptanceTree();
    const cursorPath = path.join(folders.cursorFolder, '.cursor', 'mcp.json');
    const cursorBefore = hashFile(cursorPath);

    const results = rewriteLegacyLauncherEntries({
      workspaceRoot: folders.cursorFolder,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(results.map((result) => result.path)).not.toContain(cursorPath);
    expect(hashFile(cursorPath)).toBe(cursorBefore);
    expect(formatLauncherMigrationResults(results).join('\n')).not.toContain(cursorPath);
  });
});
