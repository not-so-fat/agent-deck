import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildAgentDeckEntry,
  ensureGlobalCursorMcpLaunch,
  formatCursorGlobalMcpEnsureMessage,
  isLegacyBareHttpAgentDeckEntry,
  isMcpLaunchEntry,
  mergeMcpServerConfig,
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
    expect(buildAgentDeckEntry('claude', { host: '127.0.0.1', mcpPort: 3001 })).toEqual({
      type: 'stdio',
      command: 'agent-deck',
      args: ['mcp-launch'],
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
});

describe('legacy bare HTTP detection', () => {
  it('flags url-only entries', () => {
    expect(isLegacyBareHttpAgentDeckEntry({ url: 'http://127.0.0.1:1110/mcp' })).toBe(true);
    expect(isMcpLaunchEntry({ url: 'http://127.0.0.1:1110/mcp' })).toBe(false);
  });

  it('recognizes mcp-launch entries', () => {
    expect(isMcpLaunchEntry({ command: 'agent-deck', args: ['mcp-launch'] })).toBe(true);
    expect(isLegacyBareHttpAgentDeckEntry({ command: 'agent-deck', args: ['mcp-launch'] })).toBe(false);
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

  it('upgrades bare url and explains mcp_auth is not the fix', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    tmpDirs.push(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } } }, null, 2)}\n`,
    );

    const result = ensureGlobalCursorMcpLaunch({ host: '127.0.0.1', mcpPort: 1110 });
    expect(result).toMatchObject({ action: 'upgraded', reason: 'bare-url' });
    const message = formatCursorGlobalMcpEnsureMessage(result);
    expect(message).toContain('mcp-launch');
    expect(message).toContain('mcp_auth');

    const written = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command?: string; url?: string }>;
    };
    expect(written.mcpServers['agent-deck']?.url).toBeUndefined();
    expect(written.mcpServers['agent-deck']?.command).toBe('agent-deck');
  });

  it('does not create missing or overwrite custom global entries', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-mcp-home-'));
    tmpDirs.push(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    expect(ensureGlobalCursorMcpLaunch({ host: '127.0.0.1', mcpPort: 1110 })).toMatchObject({
      action: 'ok',
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
      action: 'ok',
    });
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
