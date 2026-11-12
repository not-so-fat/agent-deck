import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MUSE_SCHEMA_VERSION,
  buildAgentDeckEntry,
  buildCodexAgentDeckEntry,
  ensureGlobalCursorMcpLaunch,
  formatCodexMcpSection,
  formatCursorGlobalMcpEnsureMessage,
  isLegacyBareHttpAgentDeckEntry,
  isMcpLaunchEntry,
  mergeCodexTomlConfig,
  mergeMcpServerConfig,
  mergeMuseServerConfig,
  readCursorWorkspaceRoot,
  resolveConfigPath,
} from './mcp-config';
import { compareSemver } from './upgrade';

describe('mergeMcpServerConfig', () => {
  it('adds agent-deck without removing other servers', () => {
    const merged = mergeMcpServerConfig(
      {
        mcpServers: {
          memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        },
      },
      { command: 'agent-deck', args: ['mcp-launch'] },
    );

    expect(merged.mcpServers).toEqual({
      memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      'agent-deck': { command: 'agent-deck', args: ['mcp-launch'] },
    });
  });
});

describe('buildAgentDeckEntry', () => {
  it('uses stdio launcher for claude', () => {
    expect(buildAgentDeckEntry('claude', { host: '127.0.0.2', mcpPort: 3001 })).toEqual({
      type: 'stdio',
      command: 'agent-deck',
      args: ['mcp-launch'],
      env: {
        AGENT_DECK_MCP_PORT: '3001',
        AGENT_DECK_HOST: '127.0.0.2',
      },
    });
  });

  it('uses agent-deck launcher for claude-desktop', () => {
    expect(buildAgentDeckEntry('claude-desktop', { host: '127.0.0.1', mcpPort: 3001 })).toEqual({
      command: 'agent-deck',
      args: ['mcp-launch'],
    });
  });

  it('uses agent-deck launcher for cursor with endpoint env', () => {
    expect(buildAgentDeckEntry('cursor', { host: '127.0.0.1', mcpPort: 3001 })).toEqual({
      command: 'agent-deck',
      args: ['mcp-launch'],
      env: {
        AGENT_DECK_MCP_PORT: '3001',
        AGENT_DECK_HOST: '127.0.0.1',
      },
    });
  });

  it('NOT-563: writes a pure-HTTP entry for claude project folders', () => {
    // toEqual fails on any extra field: no deck id, no launcher keys.
    expect(
      buildAgentDeckEntry(
        'claude',
        { host: '127.0.0.1', mcpPort: 1110 },
        { workspaceRoot: '/tmp/ws' },
      ),
    ).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:1110/mcp',
      headers: { 'x-agent-deck-workspace': '/tmp/ws' },
    });
  });

  it('NOT-563: writes a URL-plus-header entry for codex project folders', () => {
    const expected = {
      url: 'http://127.0.0.1:1110/mcp',
      http_headers: { 'x-agent-deck-workspace': '/tmp/ws' },
    };
    expect(
      buildCodexAgentDeckEntry({ host: '127.0.0.1', mcpPort: 1110 }, { workspaceRoot: '/tmp/ws' }),
    ).toEqual(expected);
    expect(
      buildAgentDeckEntry(
        'codex',
        { host: '127.0.0.1', mcpPort: 1110 },
        { workspaceRoot: '/tmp/ws' },
      ),
    ).toEqual(expected);
  });

  it('NOT-563: codex requires a workspace root for the header', () => {
    expect(() => buildAgentDeckEntry('codex', { host: '127.0.0.1', mcpPort: 1110 })).toThrow(
      /workspaceRoot/,
    );
  });

  it('NOT-563: keeps the cursor project launcher byte-identical to the pre-change fixture', () => {
    expect(
      buildAgentDeckEntry(
        'cursor',
        { host: '127.0.0.1', mcpPort: 1110 },
        { workspaceRoot: '/tmp/ws' },
      ),
    ).toEqual({
      command: 'agent-deck',
      args: ['mcp-launch'],
      env: {
        AGENT_DECK_MCP_PORT: '1110',
        AGENT_DECK_HOST: '127.0.0.1',
        AGENT_DECK_WORKSPACE: '/tmp/ws',
      },
    });
  });

  it('pins AGENT_DECK_WORKSPACE for project cursor entries', () => {
    expect(
      buildAgentDeckEntry('cursor', { host: '127.0.0.1', mcpPort: 1110 }, { workspaceRoot: '/tmp/ws' }),
    ).toEqual({
      command: 'agent-deck',
      args: ['mcp-launch'],
      env: {
        AGENT_DECK_MCP_PORT: '1110',
        AGENT_DECK_HOST: '127.0.0.1',
        AGENT_DECK_WORKSPACE: '/tmp/ws',
      },
    });
  });

  it('NOT-387: writes the exact supported launcher fields for muse', () => {
    // toEqual fails on any extra field: no AGENT_DECK_WORKSPACE, cwd,
    // required, timeout, or redundant type — Muse preserves command/args/env.
    expect(buildAgentDeckEntry('muse', { host: '127.0.0.1', mcpPort: 1110 })).toEqual({
      command: 'agent-deck',
      args: ['mcp-launch'],
      env: {
        AGENT_DECK_MCP_PORT: '1110',
        AGENT_DECK_HOST: '127.0.0.1',
      },
    });
  });

  it('NOT-387: ignores a workspace pin for muse so selection stays dynamic', () => {
    const entry = buildAgentDeckEntry(
      'muse',
      { host: '127.0.0.1', mcpPort: 1110 },
      { workspaceRoot: '/tmp/ws' },
    );
    expect(entry).not.toHaveProperty('cwd');
    expect(entry).not.toHaveProperty('type');
    expect(entry.env).toEqual({
      AGENT_DECK_MCP_PORT: '1110',
      AGENT_DECK_HOST: '127.0.0.1',
    });
  });

  it.each([
    ['cursor', 'global'],
    ['cursor', 'project'],
    ['claude', 'global'],
    ['claude', 'project'],
    ['claude-desktop', 'global'],
    ['muse', 'global'],
    ['muse', 'project'],
  ] as const)('every client entry uses the mcp-launch launcher (%s/%s)', (client, _scope) => {
    expect(isMcpLaunchEntry(buildAgentDeckEntry(client, { host: '127.0.0.1', mcpPort: 1110 }))).toBe(
      true,
    );
  });
});

describe('NOT-563 codex config paths', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves codex project scope to .codex/config.toml and global to ~/.codex/config.toml', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-codex-workspace-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      expect(resolveConfigPath('codex', 'project', workspace)).toBe(
        path.join(workspace, '.codex', 'config.toml'),
      );
      expect(resolveConfigPath('codex', 'global')).toBe(
        path.join(home, '.codex', 'config.toml'),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('NOT-563 codex TOML section', () => {
  const entry = buildCodexAgentDeckEntry(
    { host: '127.0.0.1', mcpPort: 1110 },
    { workspaceRoot: '/tmp/ws' },
  );
  const section = [
    '[mcp_servers.agent-deck]',
    'url = "http://127.0.0.1:1110/mcp"',
    'http_headers = { "x-agent-deck-workspace" = "/tmp/ws" }',
  ].join('\n');

  it('formats the canonical section from the entry', () => {
    expect(formatCodexMcpSection(entry)).toBe(section);
  });

  it('escapes backslashes and quotes in values', () => {
    expect(
      formatCodexMcpSection({
        url: 'http://127.0.0.1:1110/mcp',
        http_headers: { 'x-agent-deck-workspace': 'C:\\ws\\"quoted"' },
      }),
    ).toBe(
      [
        '[mcp_servers.agent-deck]',
        'url = "http://127.0.0.1:1110/mcp"',
        'http_headers = { "x-agent-deck-workspace" = "C:\\\\ws\\\\\\"quoted\\"" }',
      ].join('\n'),
    );
  });

  it('writes the section alone for a missing file', () => {
    expect(mergeCodexTomlConfig('', section)).toBe(`${section}\n`);
  });

  it('appends after unrelated content with a blank separator, preserving every byte', () => {
    const existing = '[model]\nname = "gpt-5"\n\n[mcp_servers.other]\nurl = "http://example.com/mcp"\n';
    expect(mergeCodexTomlConfig(existing, section)).toBe(`${existing}\n${section}\n`);
  });

  it('appends after a file with no trailing newline', () => {
    expect(mergeCodexTomlConfig('[model]\nname = "gpt-5"', section)).toBe(
      `[model]\nname = "gpt-5"\n\n${section}\n`,
    );
  });

  it('replaces a stale agent-deck section in place, keeping the blank separator', () => {
    const existing = [
      '[model]',
      'name = "gpt-5"',
      '',
      '[mcp_servers.agent-deck]',
      'url = "http://127.0.0.1:9999/mcp"',
      '',
      '[mcp_servers.other]',
      'url = "http://example.com/mcp"',
      '',
    ].join('\n');
    const merged = mergeCodexTomlConfig(existing, section);
    expect(merged).toBe(
      [
        '[model]',
        'name = "gpt-5"',
        '',
        section,
        '',
        '[mcp_servers.other]',
        'url = "http://example.com/mcp"',
        '',
      ].join('\n'),
    );
    expect(merged).not.toContain('9999');
    expect(mergeCodexTomlConfig(merged, section)).toBe(merged);
  });

  it('removes a stale env sub-table adjoining the parent section', () => {
    // The layout `codex mcp add --env` writes: a stale launcher parent plus
    // an env sub-table that must not survive next to the pure-HTTP entry.
    const existing = [
      '[mcp_servers.agent-deck]',
      'command = "agent-deck"',
      '',
      '[mcp_servers.agent-deck.env]',
      'AGENT_DECK_WORKSPACE = "/stale/ws"',
      '',
      '[mcp_servers.other]',
      'url = "http://example.com/mcp"',
      '',
    ].join('\n');
    const merged = mergeCodexTomlConfig(existing, section);
    expect(merged).toBe(
      [section, '', '[mcp_servers.other]', 'url = "http://example.com/mcp"', ''].join('\n'),
    );
    expect(merged).not.toContain('AGENT_DECK_WORKSPACE');
    expect(merged).not.toContain('command = ');
    expect(mergeCodexTomlConfig(merged, section)).toBe(merged);
  });

  it('removes a non-adjacent sub-table elsewhere in the file', () => {
    const existing = [
      '[mcp_servers.agent-deck]',
      'url = "http://127.0.0.1:9999/mcp"',
      '',
      '[mcp_servers.other]',
      'url = "http://example.com/mcp"',
      '',
      '[mcp_servers.agent-deck.env]',
      'FOO = "bar"',
      '',
      '[model]',
      'name = "gpt-5"',
      '',
    ].join('\n');
    const merged = mergeCodexTomlConfig(existing, section);
    expect(merged).toBe(
      [
        section,
        '',
        '[mcp_servers.other]',
        'url = "http://example.com/mcp"',
        '',
        '[model]',
        'name = "gpt-5"',
        '',
      ].join('\n'),
    );
    expect(merged).not.toContain('FOO');
    expect(mergeCodexTomlConfig(merged, section)).toBe(merged);
  });

  it('removes an http_headers sub-table that would redefine the inline headers', () => {
    const merged = mergeCodexTomlConfig(
      [
        '[mcp_servers.agent-deck]',
        'url = "http://127.0.0.1:9999/mcp"',
        '[mcp_servers.agent-deck.http_headers]',
        'x-agent-deck-workspace = "/stale/ws"',
        '',
      ].join('\n'),
      section,
    );
    expect(merged).toBe(`${section}\n`);
    expect(merged).not.toContain('/stale/ws');
  });

  it('removes quoted and whitespace-padded sub-table headers', () => {
    const merged = mergeCodexTomlConfig(
      '[mcp_servers."agent-deck"]\nurl = "http://127.0.0.1:9999/mcp"\n\n[mcp_servers."agent-deck".env]\nFOO = "bar"\n',
      section,
    );
    expect(merged).toBe(`${section}\n`);
    const padded = mergeCodexTomlConfig(
      '[ mcp_servers . agent-deck ]\nurl = "http://127.0.0.1:9999/mcp"\n',
      section,
    );
    expect(padded).toBe(`${section}\n`);
  });

  it('leaves a merely prefixed sibling section alone', () => {
    const existing = '[mcp_servers.agent-deck-env]\nurl = "http://example.com/mcp"\n';
    expect(mergeCodexTomlConfig(existing, section)).toBe(`${existing}\n${section}\n`);
  });

  it('replaces a single-line inline table under [mcp_servers]', () => {
    const existing = [
      '[mcp_servers]',
      'agent-deck = { url = "http://127.0.0.1:9999/mcp" }',
      'other = { url = "http://example.com/mcp" }',
      '',
    ].join('\n');
    const merged = mergeCodexTomlConfig(existing, section);
    expect(merged).toBe(
      ['[mcp_servers]', 'other = { url = "http://example.com/mcp" }', '', section, ''].join('\n'),
    );
    expect(merged).not.toContain('9999');
    expect(mergeCodexTomlConfig(merged, section)).toBe(merged);
  });

  it('replaces dotted keys under [mcp_servers]', () => {
    const existing = [
      '[mcp_servers]',
      'other = { url = "http://example.com/mcp" }',
      'agent-deck.url = "http://127.0.0.1:9999/mcp"',
      'agent-deck.token = "stale"',
      '',
    ].join('\n');
    const merged = mergeCodexTomlConfig(existing, section);
    expect(merged).toBe(
      ['[mcp_servers]', 'other = { url = "http://example.com/mcp" }', '', section, ''].join('\n'),
    );
    expect(merged).not.toContain('9999');
    expect(merged).not.toContain('stale');
    expect(mergeCodexTomlConfig(merged, section)).toBe(merged);
  });

  it('replaces a multi-line inline table under [mcp_servers]', () => {
    const existing = [
      '[mcp_servers]',
      'agent-deck = {',
      '  url = "http://127.0.0.1:9999/mcp", # a { brace in a comment',
      '  note = "a } brace { in a string",',
      '}',
      '',
      '[model]',
      'name = "gpt-5"',
      '',
    ].join('\n');
    const merged = mergeCodexTomlConfig(existing, section);
    expect(merged).toBe(
      ['[mcp_servers]', '[model]', 'name = "gpt-5"', '', section, ''].join('\n'),
    );
    expect(merged).not.toContain('9999');
    expect(mergeCodexTomlConfig(merged, section)).toBe(merged);
  });

  it('ignores a nested agent-deck key inside another server table', () => {
    const existing = ['[mcp_servers]', 'other = {', '  agent-deck = "nested",', '}', ''].join(
      '\n',
    );
    const merged = mergeCodexTomlConfig(existing, section);
    expect(merged).toBe(`${existing}\n${section}\n`);
    expect(merged).toContain('agent-deck = "nested"');
    expect(mergeCodexTomlConfig(merged, section)).toBe(merged);
  });

  it('normalizes a quoted section header', () => {
    const merged = mergeCodexTomlConfig(
      '[mcp_servers."agent-deck"]\nurl = "http://127.0.0.1:9999/mcp"\n',
      section,
    );
    expect(merged).toBe(`${section}\n`);
  });

  it('is idempotent', () => {
    const cases = [
      '',
      '[model]\nname = "gpt-5"\n',
      '[mcp_servers."agent-deck"]\nurl = "http://127.0.0.1:9999/mcp"\n',
      '[mcp_servers.agent-deck]\nurl = "http://127.0.0.1:9999/mcp"\n\n[mcp_servers.agent-deck.env]\nFOO = "bar"\n',
      '[mcp_servers]\nagent-deck = { url = "http://127.0.0.1:9999/mcp" }\n',
      '[mcp_servers]\nagent-deck.url = "http://127.0.0.1:9999/mcp"\n',
      `${section}\n`,
    ];
    for (const existing of cases) {
      const once = mergeCodexTomlConfig(existing, section);
      expect(mergeCodexTomlConfig(once, section)).toBe(once);
    }
  });
});

describe('NOT-387 resolveConfigPath', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves muse global settings through XDG_CONFIG_HOME when set', () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-xdg-'));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      expect(resolveConfigPath('muse', 'global')).toBe(path.join(xdg, 'muse', 'settings.json'));
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      fs.rmSync(xdg, { recursive: true, force: true });
    }
  });

  it.each([{ xdg: undefined }, { xdg: '' }, { xdg: '   ' }])(
    'falls back to ~/.config/muse when XDG_CONFIG_HOME is %j',
    ({ xdg }) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-home-'));
      const previousXdg = process.env.XDG_CONFIG_HOME;
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = xdg;
      try {
        expect(resolveConfigPath('muse', 'global')).toBe(
          path.join(home, '.config', 'muse', 'settings.json'),
        );
      } finally {
        if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousXdg;
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it('resolves muse project scope to root .mcp.json', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-muse-workspace-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      expect(resolveConfigPath('muse', 'project', workspace)).toBe(
        path.join(workspace, '.mcp.json'),
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps every existing client config path unchanged', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-workspace-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      expect(resolveConfigPath('cursor', 'global')).toBe(path.join(home, '.cursor', 'mcp.json'));
      expect(resolveConfigPath('cursor', 'project', workspace)).toBe(
        path.join(workspace, '.cursor', 'mcp.json'),
      );
      expect(resolveConfigPath('claude', 'global')).toBe(path.join(home, '.claude.json'));
      expect(resolveConfigPath('claude', 'project', workspace)).toBe(
        path.join(workspace, '.mcp.json'),
      );
      expect(resolveConfigPath('claude-desktop', 'global')).toContain('claude_desktop_config.json');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('NOT-387 mergeMuseServerConfig', () => {
  const configPath = path.join('/tmp', 'xdg', 'muse', 'settings.json');
  const entry = {
    command: 'agent-deck',
    args: ['mcp-launch'],
    env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
  };

  it('sets schema_version when absent', () => {
    expect(mergeMuseServerConfig({}, entry, configPath)).toEqual({
      schema_version: MUSE_SCHEMA_VERSION,
      mcpServers: { 'agent-deck': entry },
    });
    expect(MUSE_SCHEMA_VERSION).toBe(1);
  });

  it('preserves every unrelated root key and MCP server', () => {
    const existing = {
      theme: 'dark',
      schema_version: 1,
      mcpServers: {
        memory: { command: 'npx', args: ['-y', 'memory'] },
        'agent-deck': { command: 'agent-deck', args: ['mcp-launch'], env: { STALE: 'yes' } },
      },
    };
    const merged = mergeMuseServerConfig(existing, entry, configPath);
    expect(merged).toEqual({
      theme: 'dark',
      schema_version: 1,
      mcpServers: { memory: { command: 'npx', args: ['-y', 'memory'] }, 'agent-deck': entry },
    });
    // The merge never mutates its input.
    expect(existing.mcpServers['agent-deck']).toEqual({
      command: 'agent-deck',
      args: ['mcp-launch'],
      env: { STALE: 'yes' },
    });
  });

  it.each([{ version: 2 }, { version: '1' }, { version: null }])(
    'rejects incompatible schema_version %j with path and expected version',
    ({ version }) => {
      expect(() => mergeMuseServerConfig({ schema_version: version }, entry, configPath)).toThrow(
        expect.objectContaining({
          message: expect.stringContaining(configPath),
        }),
      );
      expect(() => mergeMuseServerConfig({ schema_version: version }, entry, configPath)).toThrow(
        /expected 1/,
      );
    },
  );
});

describe('legacy bare HTTP detection', () => {
  it('flags url-only entries', () => {
    expect(isLegacyBareHttpAgentDeckEntry({ url: 'http://127.0.0.1:1110/mcp' })).toBe(true);
    expect(isMcpLaunchEntry({ url: 'http://127.0.0.1:1110/mcp' })).toBe(false);
  });

  it('recognizes mcp-launch entries', () => {
    expect(isMcpLaunchEntry({ command: 'agent-deck', args: ['mcp-launch'] })).toBe(true);
    expect(
      isMcpLaunchEntry({ command: '/opt/homebrew/bin/agent-deck', args: ['mcp-launch'] }),
    ).toBe(true);
    expect(
      isMcpLaunchEntry({ command: 'C:\\tools\\agent-deck.cmd', args: ['mcp-launch'] }),
    ).toBe(true);
    expect(isMcpLaunchEntry({ command: 'agent-deck', args: ['other', 'mcp-launch'] })).toBe(false);
    expect(isLegacyBareHttpAgentDeckEntry({ command: 'agent-deck', args: ['mcp-launch'] })).toBe(false);
  });

  it('reads a pinned workspace only from agent-deck launchers', () => {
    expect(
      readCursorWorkspaceRoot({
        command: 'agent-deck',
        args: ['mcp-launch'],
        env: { AGENT_DECK_WORKSPACE: '/tmp/ws' },
      }),
    ).toBe(path.resolve('/tmp/ws'));
    expect(
      readCursorWorkspaceRoot({
        command: 'custom-wrapper',
        args: ['mcp-launch'],
        env: { AGENT_DECK_WORKSPACE: '/tmp/ws' },
      }),
    ).toBeUndefined();
  });
});

describe('ensureGlobalCursorMcpLaunch', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('diagnoses a bare url without writing when no workspace is explicit', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    tmpDirs.push(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const original = `${JSON.stringify({ mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } } }, null, 2)}\n`;
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      original,
    );

    const result = ensureGlobalCursorMcpLaunch({ host: '127.0.0.1', mcpPort: 1110 });
    expect(result).toMatchObject({ action: 'diagnostic', reason: 'bare-url' });
    const message = formatCursorGlobalMcpEnsureMessage(result);
    expect(message).toContain('No changes made');
    expect(message).toContain('mcp_auth');
    expect(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(original);
  });

  it('diagnoses missing and custom global entries without writing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    tmpDirs.push(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    expect(ensureGlobalCursorMcpLaunch({ host: '127.0.0.1', mcpPort: 1110 })).toMatchObject({
      action: 'diagnostic',
      reason: 'missing',
    });
    expect(fs.existsSync(path.join(home, '.cursor', 'mcp.json'))).toBe(false);

    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const custom = {
      mcpServers: {
        'agent-deck': { command: 'npx', args: ['-y', 'custom-wrapper'] },
      },
    };
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), `${JSON.stringify(custom, null, 2)}\n`);

    expect(ensureGlobalCursorMcpLaunch({ host: '127.0.0.1', mcpPort: 1110 })).toMatchObject({
      action: 'diagnostic',
      reason: 'custom-entry',
    });
    const written = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(written).toEqual(custom);
  });

  it('creates a workspace-pinned user launcher for explicit use', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-workspace-'));
    tmpDirs.push(home, workspace);
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    expect(
      ensureGlobalCursorMcpLaunch(
        { host: '127.0.0.1', mcpPort: 1110 },
        { workspaceRoot: workspace },
      ),
    ).toMatchObject({ action: 'created', reason: 'missing', workspaceRoot: workspace });

    const written = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(written.mcpServers['agent-deck']?.env).toMatchObject({
      AGENT_DECK_HOST: '127.0.0.1',
      AGENT_DECK_MCP_PORT: '1110',
      AGENT_DECK_WORKSPACE: workspace,
    });
  });

  it('repairs a v1.7.2 launcher that has no workspace pin', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-workspace-'));
    tmpDirs.push(home, workspace);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': {
            command: 'agent-deck',
            args: ['mcp-launch'],
            env: { AGENT_DECK_HOST: '127.0.0.1', AGENT_DECK_MCP_PORT: '1110' },
          },
        },
      }, null, 2)}\n`,
    );

    const result = ensureGlobalCursorMcpLaunch(
      { host: '127.0.0.1', mcpPort: 1110 },
      { workspaceRoot: workspace },
    );
    expect(result).toMatchObject({
      action: 'updated',
      reason: 'missing-workspace',
      workspaceRoot: workspace,
    });

    const written = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(written.mcpServers['agent-deck']?.env?.AGENT_DECK_WORKSPACE).toBe(workspace);
  });

  it('reports the previous workspace when the last explicit use changes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    const previousWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-workspace-a-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-workspace-b-'));
    tmpDirs.push(home, previousWorkspace, workspace);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': buildAgentDeckEntry(
            'cursor',
            { host: '127.0.0.1', mcpPort: 1110 },
            { workspaceRoot: previousWorkspace },
          ),
        },
      }, null, 2)}\n`,
    );

    const result = ensureGlobalCursorMcpLaunch(
      { host: '127.0.0.1', mcpPort: 1110 },
      { workspaceRoot: workspace },
    );
    expect(result).toMatchObject({
      action: 'updated',
      reason: 'workspace-changed',
      previousWorkspaceRoot: previousWorkspace,
      workspaceRoot: workspace,
    });
    const message = formatCursorGlobalMcpEnsureMessage(result);
    expect(message).toContain(previousWorkspace);
    expect(message).toContain(workspace);
    expect(message).toContain('last explicit');
  });

  it('updates a stale endpoint while preserving managed entry extensions', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-workspace-'));
    tmpDirs.push(home, workspace);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': {
            ...buildAgentDeckEntry(
              'cursor',
              { host: '127.0.0.1', mcpPort: 1110 },
              { workspaceRoot: workspace },
            ),
            disabled: true,
            env: {
              AGENT_DECK_HOST: '127.0.0.1',
              AGENT_DECK_MCP_PORT: '1110',
              AGENT_DECK_WORKSPACE: workspace,
              KEEP_ME: 'yes',
            },
          },
        },
      }, null, 2)}\n`,
    );

    const result = ensureGlobalCursorMcpLaunch(
      { host: 'localhost', mcpPort: 2220 },
      { workspaceRoot: workspace },
    );
    expect(result).toMatchObject({ action: 'updated', reason: 'endpoint-changed' });
    const written = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { disabled?: boolean; env?: Record<string, string> }>;
    };
    expect(written.mcpServers['agent-deck']).toMatchObject({ disabled: true });
    expect(written.mcpServers['agent-deck']?.env).toMatchObject({
      AGENT_DECK_HOST: 'localhost',
      AGENT_DECK_MCP_PORT: '2220',
      AGENT_DECK_WORKSPACE: workspace,
      KEEP_ME: 'yes',
    });
  });

  it('returns ok and does not rewrite an already-correct launcher', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-workspace-'));
    tmpDirs.push(home, workspace);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const original = `${JSON.stringify({
      mcpServers: {
        'agent-deck': buildAgentDeckEntry(
          'cursor',
          { host: '127.0.0.1', mcpPort: 1110 },
          { workspaceRoot: workspace },
        ),
      },
    })}\n`;
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), original);

    expect(
      ensureGlobalCursorMcpLaunch(
        { host: '127.0.0.1', mcpPort: 1110 },
        { workspaceRoot: workspace },
      ),
    ).toMatchObject({ action: 'ok', workspaceRoot: workspace });
    expect(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(original);
  });

  it('does not overwrite a custom wrapper during explicit use', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-workspace-'));
    tmpDirs.push(home, workspace);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const custom = {
      mcpServers: {
        'agent-deck': { command: 'npx', args: ['-y', 'custom-wrapper'] },
      },
    };
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), `${JSON.stringify(custom, null, 2)}\n`);

    const result = ensureGlobalCursorMcpLaunch(
      { host: '127.0.0.1', mcpPort: 1110 },
      { workspaceRoot: workspace },
    );
    expect(result).toMatchObject({ action: 'skipped', reason: 'custom-entry' });
    expect(formatCursorGlobalMcpEnsureMessage(result)).toContain('left custom');
    const written = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(written).toEqual(custom);
  });
});

describe('compareSemver', () => {
  it('detects newer patch versions', () => {
    expect(compareSemver('1.1.1', '1.1.0')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0', '1.1.1')).toBeLessThan(0);
    expect(compareSemver('1.1.0', '1.1.0')).toBe(0);
  });
});
