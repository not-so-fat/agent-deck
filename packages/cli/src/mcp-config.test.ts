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
  readCursorWorkspaceRoot,
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
