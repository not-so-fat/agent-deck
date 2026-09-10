import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatCursorMcpInspection,
  inspectCursorMcpConfig,
  readGrantSummarySync,
  resolveWorkspacePinValue,
} from './cursor-mcp-inspect';

describe('inspectCursorMcpConfig', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeHomeAndWorkspace(): { home: string; workspace: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-inspect-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-inspect-ws-'));
    tmpDirs.push(home, workspace);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    return { home, workspace };
  }

  function writeV2Grant(workspace: string): void {
    fs.mkdirSync(path.join(workspace, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.agent-deck', 'use.json'),
      `${JSON.stringify({
        version: 2,
        workspaceKey: 'wsp_test',
        grantId: 'wgr_test',
        secret: 'super-secret-value-at-least-32-chars!!',
        deckId: 'deck-1',
        deckName: 'personal-dev',
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
  }

  it('reports missing global and project entries without writing', () => {
    const { home, workspace } = makeHomeAndWorkspace();
    const before = fs.existsSync(path.join(home, '.cursor', 'mcp.json'));

    const report = inspectCursorMcpConfig({
      cwd: workspace,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(before).toBe(false);
    expect(report.preferredSource).toBe('none');
    expect(report.global.shape).toBe('missing');
    expect(report.project.shape).toBe('missing');
    expect(report.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['missing', 'grant-missing']),
    );
    expect(fs.existsSync(path.join(home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('flags bare URL with mcp_auth_dead_end and does not rewrite the file', () => {
    const { home, workspace } = makeHomeAndWorkspace();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const original = `${JSON.stringify(
      { mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } } },
      null,
      2,
    )}\n`;
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), original);

    const report = inspectCursorMcpConfig({
      cwd: workspace,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(report.global.shape).toBe('legacy-bare-url');
    expect(report.preferredSource).toBe('global');
    expect(report.global.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['bare-url', 'mcp_auth_dead_end']),
    );
    expect(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).toBe(original);
    expect(formatCursorMcpInspection(report)).toContain('mcp_auth');
  });

  it('accepts a valid mcp-launch pin with grant metadata (no secrets in output)', () => {
    const { home, workspace } = makeHomeAndWorkspace();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': {
            command: 'agent-deck',
            args: ['mcp-launch'],
            env: {
              AGENT_DECK_HOST: '127.0.0.1',
              AGENT_DECK_MCP_PORT: '1110',
              AGENT_DECK_WORKSPACE: workspace,
            },
          },
        },
      }, null, 2)}\n`,
    );
    writeV2Grant(workspace);

    const report = inspectCursorMcpConfig({
      cwd: workspace,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(report.global.shape).toBe('mcp-launch');
    expect(report.global.workspacePin).toBe(workspace);
    expect(report.grant.present).toBe(true);
    expect(report.grant.deckName).toBe('personal-dev');
    expect(report.issues.filter((i) => i.code === 'grant-missing')).toHaveLength(0);
    expect(report.issues.filter((i) => i.code === 'missing')).toHaveLength(0);
    expect(report.project.shape).toBe('missing');
    const formatted = formatCursorMcpInspection(report);
    expect(formatted).not.toContain('super-secret-value');
    expect(formatted).toContain('personal-dev');
    expect(formatted).toContain('Issues: none');
  });

  it('resolves project ${workspaceFolder} pin before grant lookup', () => {
    const { home, workspace } = makeHomeAndWorkspace();
    fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': {
            command: 'agent-deck',
            args: ['mcp-launch'],
            env: {
              AGENT_DECK_HOST: '127.0.0.1',
              AGENT_DECK_MCP_PORT: '1110',
              AGENT_DECK_WORKSPACE: '${workspaceFolder}',
            },
          },
        },
      }, null, 2)}\n`,
    );
    writeV2Grant(workspace);

    const report = inspectCursorMcpConfig({
      cwd: workspace,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(report.project.workspacePin).toBe(workspace);
    expect(report.grant.checkedRoot).toBe(workspace);
    expect(report.grant.present).toBe(true);
    expect(report.issues.filter((i) => i.code === 'grant-missing')).toHaveLength(0);
    expect(report.project.workspacePin).not.toContain('${workspaceFolder}');
  });

  it('treats legacy v1 use.json as grant-missing', () => {
    const { home, workspace } = makeHomeAndWorkspace();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': {
            command: 'agent-deck',
            args: ['mcp-launch'],
            env: {
              AGENT_DECK_HOST: '127.0.0.1',
              AGENT_DECK_MCP_PORT: '1110',
              AGENT_DECK_WORKSPACE: workspace,
            },
          },
        },
      }, null, 2)}\n`,
    );
    fs.mkdirSync(path.join(workspace, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.agent-deck', 'use.json'),
      `${JSON.stringify({
        version: 1,
        deckId: '761f3c44-21b3-4298-81e4-4c85bb963eb1',
        deckName: 'dev',
        mcpUrl: 'http://127.0.0.1:1110/mcp',
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );

    const report = inspectCursorMcpConfig({
      cwd: workspace,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(report.grant.present).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('grant-missing');
    expect(formatCursorMcpInspection(report)).toContain('Grant   missing');
  });

  it('does not promote shadow missing when global-only setup is healthy', () => {
    const { home, workspace } = makeHomeAndWorkspace();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': {
            command: 'agent-deck',
            args: ['mcp-launch'],
            env: {
              AGENT_DECK_HOST: '127.0.0.1',
              AGENT_DECK_MCP_PORT: '1110',
              AGENT_DECK_WORKSPACE: workspace,
            },
          },
        },
      }, null, 2)}\n`,
    );
    writeV2Grant(workspace);

    const report = inspectCursorMcpConfig({
      cwd: workspace,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(report.preferredSource).toBe('global');
    expect(report.project.shape).toBe('missing');
    expect(report.issues.filter((i) => i.code === 'missing')).toHaveLength(0);
    expect(report.issues).toHaveLength(0);
  });

  it('does not promote shadow missing when project-only setup is healthy', () => {
    const { workspace } = makeHomeAndWorkspace();
    fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': {
            command: 'agent-deck',
            args: ['mcp-launch'],
            env: {
              AGENT_DECK_HOST: '127.0.0.1',
              AGENT_DECK_MCP_PORT: '1110',
              AGENT_DECK_WORKSPACE: workspace,
            },
          },
        },
      }, null, 2)}\n`,
    );
    writeV2Grant(workspace);

    const report = inspectCursorMcpConfig({
      cwd: workspace,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(report.preferredSource).toBe('project');
    expect(report.global.shape).toBe('missing');
    expect(report.issues.filter((i) => i.code === 'missing')).toHaveLength(0);
    expect(report.issues).toHaveLength(0);
  });

  it('detects stale endpoint and missing workspace pin', () => {
    const { home, workspace } = makeHomeAndWorkspace();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': {
            command: 'agent-deck',
            args: ['mcp-launch'],
            env: { AGENT_DECK_HOST: '127.0.0.1', AGENT_DECK_MCP_PORT: '9999' },
          },
        },
      }, null, 2)}\n`,
    );

    const report = inspectCursorMcpConfig({
      cwd: workspace,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(report.global.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['missing-workspace-pin', 'stale-endpoint']),
    );
  });

  it('detects custom wrappers without writing', () => {
    const { home, workspace } = makeHomeAndWorkspace();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const custom = {
      mcpServers: {
        'agent-deck': { command: 'npx', args: ['-y', 'custom-wrapper'] },
      },
    };
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), `${JSON.stringify(custom, null, 2)}\n`);

    const report = inspectCursorMcpConfig({
      cwd: workspace,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(report.global.shape).toBe('custom');
    expect(report.global.issues[0]?.code).toBe('custom-entry');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'))).toEqual(custom);
  });

  it('prefers project over global when both define agent-deck', () => {
    const { home, workspace } = makeHomeAndWorkspace();
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': { url: 'http://127.0.0.1:1110/mcp' },
        },
      }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(workspace, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': {
            command: 'agent-deck',
            args: ['mcp-launch'],
            env: {
              AGENT_DECK_HOST: '127.0.0.1',
              AGENT_DECK_MCP_PORT: '1110',
              AGENT_DECK_WORKSPACE: workspace,
            },
          },
        },
      }, null, 2)}\n`,
    );

    const report = inspectCursorMcpConfig({
      cwd: workspace,
      endpoint: { host: '127.0.0.1', mcpPort: 1110 },
    });

    expect(report.preferredSource).toBe('project');
    expect(report.expectedPrecedence).toBe('project-over-global');
    expect(report.project.shape).toBe('mcp-launch');
    expect(report.global.shape).toBe('legacy-bare-url');
  });

  it('readGrantSummarySync never exposes secret field', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-inspect-grant-'));
    tmpDirs.push(workspace);
    fs.mkdirSync(path.join(workspace, '.agent-deck'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.agent-deck', 'use.json'),
      `${JSON.stringify({
        version: 2,
        grantId: 'wgr_x',
        secret: 'nope-secret-must-not-leak!!!!!!!!!!',
        deckId: 'd1',
        workspaceKey: 'wsp',
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    const summary = readGrantSummarySync(workspace);
    expect(summary.present).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('nope');
  });

  it('resolveWorkspacePinValue leaves global ${workspaceFolder} unresolved', () => {
    expect(resolveWorkspacePinValue('${workspaceFolder}')).toEqual({
      pin: null,
      unresolved: true,
    });
    expect(resolveWorkspacePinValue('${workspaceFolder}', { projectRoot: '/tmp/ws' })).toEqual({
      pin: path.resolve('/tmp/ws'),
      unresolved: false,
    });
  });
});
