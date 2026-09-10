import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveSetupMenubar, resolveSetupStatusline, runSetup } from './setup';

describe('setup statusline defaults', () => {
  it('enables status line for Claude Code by default', () => {
    expect(resolveSetupStatusline('claude')).toBe(true);
  });

  it('enables status line for Cursor CLI by default', () => {
    expect(resolveSetupStatusline('cursor')).toBe(true);
  });

  it('skips status line for Claude Desktop by default', () => {
    expect(resolveSetupStatusline('claude-desktop')).toBe(false);
  });

  it('honors --no-statusline', () => {
    expect(resolveSetupStatusline('claude', false)).toBe(false);
  });

  it('honors explicit --statusline for claude-desktop', () => {
    expect(resolveSetupStatusline('claude-desktop', true)).toBe(true);
  });

  it('enables menubar on macOS by default', () => {
    const expected = process.platform === 'darwin';
    expect(resolveSetupMenubar('cursor')).toBe(expected);
    expect(resolveSetupMenubar('claude')).toBe(expected);
  });

  it('honors --no-menubar', () => {
    expect(resolveSetupMenubar('cursor', false)).toBe(false);
  });

  it('preserves a global Cursor workspace pin written by use', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-cursor-'));
    const workspace = path.join(tmpHome, 'workspace');
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    fs.mkdirSync(path.join(tmpHome, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.cursor', 'mcp.json'),
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

    try {
      const code = await runSetup([
        '--client',
        'cursor',
        '--scope',
        'global',
        '--mcp-port',
        '2220',
        '--no-statusline',
        '--no-menubar',
      ]);
      expect(code).toBe(0);
      const written = JSON.parse(
        fs.readFileSync(path.join(tmpHome, '.cursor', 'mcp.json'), 'utf8'),
      ) as { mcpServers: Record<string, { env?: Record<string, string> }> };
      expect(written.mcpServers['agent-deck']?.env).toMatchObject({
        AGENT_DECK_MCP_PORT: '2220',
        AGENT_DECK_WORKSPACE: workspace,
      });
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'darwin')(
    'setup --menubar alone installs only the SwiftBar plugin',
    async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-menubar-'));
    process.env.AGENT_DECK_SWIFTBAR_DIR = tmpDir;
    try {
      const code = await runSetup(['--menubar']);
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, 'agent-deck.3s.sh'))).toBe(true);
    } finally {
      delete process.env.AGENT_DECK_SWIFTBAR_DIR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
  );
});
