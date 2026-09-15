import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

import { parseUseArgs, runUse } from './use';
import { writeUseManifest } from './playbook-stubs';

vi.mock('./backend-runtime', () => ({
  createCollectionAdmin: () => ({
    resolveDeck: async (ref: string) => {
      if (ref === 'dev' || ref === 'deck-1') {
        return { id: 'deck-1', name: 'dev' };
      }
      if (ref === '761f3c44-21b3-4298-81e4-4c85bb963eb1') {
        return null;
      }
      return null;
    },
    listDeckPlaybookStubs: async () => [
      { id: 'pb_test', title: 'Test playbook', triggers: ['test trigger'] },
    ],
  }),
}));

const grantIssue = vi.hoisted(() => ({
  issueWorkspaceGrant: vi.fn(async () => {
    throw new Error('issueWorkspaceGrant must not be called');
  }),
  activateWorkspaceGrant: vi.fn(async () => {
    throw new Error('activateWorkspaceGrant must not be called');
  }),
  revokePendingWorkspaceGrant: vi.fn(async () => {
    throw new Error('revokePendingWorkspaceGrant must not be called');
  }),
  toGrantManifest: vi.fn(),
}));

vi.mock('./grant-issue', () => grantIssue);

const tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-use-cmd-'));
  tmpDirs.push(dir);
  return dir;
}

describe('agent-deck use', () => {
  it('parseUseArgs requires deck or --refresh', () => {
    expect(parseUseArgs([])).toEqual({ error: 'deck name or id is required (or pass --refresh)' });
    expect(parseUseArgs(['dev'])).toMatchObject({ deckRef: 'dev', refresh: false });
    expect(parseUseArgs(['--refresh'])).toMatchObject({ refresh: true });
  });

  it('writes v3 assignment, exclude lines, and stubs without calling grant endpoints', async () => {
    const workspace = makeWorkspace();
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } } }, null, 2)}\n`,
    );

    const parsed = parseUseArgs(['dev', '--client', 'cursor']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Full use (writes project mcp.json + stubs + assignment)
    const withMcp = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in withMcp).toBe(false);
    if ('error' in withMcp) {
      return;
    }

    expect(grantIssue.issueWorkspaceGrant).not.toHaveBeenCalled();
    expect(grantIssue.activateWorkspaceGrant).not.toHaveBeenCalled();
    expect(grantIssue.revokePendingWorkspaceGrant).not.toHaveBeenCalled();

    expect(withMcp.deck.name).toBe('dev');
    expect(withMcp.playbookCount).toBe(1);
    expect(fs.existsSync(path.join(workspace, '.cursor', 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.agent-deck', 'use.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', 'pb_test.mdc'))).toBe(
      true,
    );
    const mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; env?: Record<string, string>; headers?: Record<string, string> }
      >;
    };
    expect(mcp.mcpServers['agent-deck']?.command).toBe('agent-deck');
    expect(mcp.mcpServers['agent-deck']?.args).toEqual(['mcp-launch']);
    expect(mcp.mcpServers['agent-deck']?.env?.AGENT_DECK_WORKSPACE).toBe(workspace);
    expect(mcp.mcpServers['agent-deck']?.headers?.['x-agent-deck-deck-id']).toBeUndefined();

    const globalMcp = JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; url?: string; env?: Record<string, string> }
      >;
    };
    expect(globalMcp.mcpServers['agent-deck']?.url).toBeUndefined();
    expect(globalMcp.mcpServers['agent-deck']?.command).toBe('agent-deck');
    expect(globalMcp.mcpServers['agent-deck']?.args).toEqual(['mcp-launch']);
    expect(globalMcp.mcpServers['agent-deck']?.env?.AGENT_DECK_WORKSPACE).toBe(workspace);
    expect(log.mock.calls.flat().join('\n')).toContain('upgraded the legacy bare URL');

    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
    ) as { version: number; deckId: string; deckName: string; grantId?: string; secret?: string };
    expect(manifest.version).toBe(3);
    expect(manifest.deckId).toBe(withMcp.deck.id);
    expect(manifest.deckName).toBe('dev');
    expect(manifest.grantId).toBeUndefined();
    expect(manifest.secret).toBeUndefined();

    const excludeRel = execFileSync('git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
    }).trim();
    const excludePath = path.isAbsolute(excludeRel) ? excludeRel : path.join(workspace, excludeRel);
    const exclude = fs.readFileSync(excludePath, 'utf8');
    expect(exclude).toContain('/.agent-deck/');
    expect(exclude).toContain('/.cursor/rules/agent-deck-stubs/');
    expect(exclude).toContain('/.claude/skills/agent-deck-*/');

    // Trackable launcher config may be committed by the user; local assignment + stubs must not.
    execFileSync('git', ['add', '.cursor/mcp.json'], { cwd: workspace, stdio: 'ignore' });
    execFileSync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'mcp'],
      { cwd: workspace, stdio: 'ignore' },
    );
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: workspace,
      encoding: 'utf8',
    });
    expect(porcelain.trim()).toBe('');
  });

  it('refresh diagnoses assignment or legacy manifest without rewriting', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    const globalConfig = {
      mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } },
    };
    fs.writeFileSync(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      `${JSON.stringify(globalConfig, null, 2)}\n`,
    );
    writeUseManifest(workspace, {
      version: 3,
      deckId: 'deck-1',
      deckName: 'dev',
      mcpUrl: 'http://127.0.0.1:1110/mcp',
    });

    const parsed = parseUseArgs(['--refresh']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runUse({ ...parsed, workspaceRoot: workspace, skipMcp: true });
    expect(result).toEqual({ error: 'refresh-diagnosis-only' });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
    ) as { deckId: string; version: number };
    expect(manifest.version).toBe(3);
    expect(manifest.deckId).toBe('deck-1');
    expect(log.mock.calls.flat().join('\n')).toContain('Bound deck: dev');
  });

  it('prints a repair message for an existing unpinned launcher', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.cursor', 'mcp.json'),
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
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const parsed = parseUseArgs(['dev', '--client', 'cursor']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }
    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(false);
    expect(log.mock.calls.flat().join('\n')).toContain('added the missing workspace pin');
  });

  it('prints a warning when a custom global wrapper is skipped', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'agent-deck': { command: 'npx', args: ['-y', 'custom-wrapper'] },
        },
      }, null, 2)}\n`,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = parseUseArgs(['dev', '--client', 'cursor']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }
    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(false);
    expect(warn.mock.calls.flat().join('\n')).toContain('left custom agent-deck entry unchanged');
  });
});
