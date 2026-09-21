import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildClaudeCliAddArgs,
  resolveSetupMenubar,
  resolveSetupStatusline,
  runSetup,
} from './setup';

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

  it('skips status line for Codex by default', () => {
    expect(resolveSetupStatusline('codex')).toBe(false);
  });

  it('honors --no-statusline', () => {
    expect(resolveSetupStatusline('claude', false)).toBe(false);
  });

  it('honors explicit --statusline for claude-desktop', () => {
    expect(resolveSetupStatusline('claude-desktop', true)).toBe(true);
  });

  it('registers Claude Code with the trusted stdio launcher in the requested scope', () => {
    const endpoint = { host: '127.0.0.2', mcpPort: 2110 };
    expect(buildClaudeCliAddArgs('global', endpoint)).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      'agent-deck',
      '-e',
      'AGENT_DECK_MCP_PORT=2110',
      '-e',
      'AGENT_DECK_HOST=127.0.0.2',
      '--',
      'agent-deck',
      'mcp-launch',
    ]);
    expect(buildClaudeCliAddArgs('project', endpoint)).toEqual([
      'mcp',
      'add',
      '--scope',
      'project',
      'agent-deck',
      '-e',
      'AGENT_DECK_MCP_PORT=2110',
      '-e',
      'AGENT_DECK_HOST=127.0.0.2',
      '--',
      'agent-deck',
      'mcp-launch',
    ]);
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

  it('merges Codex guidance into the global AGENTS.md without replacing existing instructions', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-codex-'));
    const codexDir = path.join(tmpHome, '.codex');
    const agentsPath = path.join(codexDir, 'AGENTS.md');
    const previousCodexHome = process.env.CODEX_HOME;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    delete process.env.CODEX_HOME;
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(agentsPath, '# Personal instructions\n\nKeep this section.\n');

    try {
      const code = await runSetup([
        '--client',
        'codex',
        '--scope',
        'global',
        '--no-statusline',
        '--no-menubar',
      ]);
      expect(code).toBe(0);
      const written = fs.readFileSync(agentsPath, 'utf8');
      expect(written).toContain('# Personal instructions');
      expect(written).toContain('Keep this section.');
      expect(written).toContain('<!-- agent-deck:harness:start -->');
      expect(written).toContain('agent-deck mcp-launch');
      expect(written).toContain('<!-- agent-deck:harness:end -->');
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      vi.restoreAllMocks();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('removes managed legacy stubs in the workspace while keeping the harness and user files', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-cleanup-'));
    const managedCursor = path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', 'pb_old.mdc');
    const userRule = path.join(workspace, '.cursor', 'rules', 'custom.mdc');
    const managedSkill = path.join(workspace, '.claude', 'skills', 'agent-deck-old', 'SKILL.md');
    const userSkill = path.join(workspace, '.claude', 'skills', 'my-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(managedCursor), { recursive: true });
    fs.writeFileSync(
      managedCursor,
      '<!-- agent-deck:stub:start pb_old -->\n# legacy\n<!-- agent-deck:stub:end -->\n',
    );
    fs.writeFileSync(userRule, '# user rule\n');
    fs.mkdirSync(path.dirname(managedSkill), { recursive: true });
    fs.writeFileSync(
      managedSkill,
      '<!-- agent-deck:stub:start pb_old -->\n# legacy\n<!-- agent-deck:stub:end -->\n',
    );
    fs.mkdirSync(path.dirname(userSkill), { recursive: true });
    fs.writeFileSync(userSkill, '# user skill\n');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    let code = -1;
    let logged = '';
    try {
      code = await runSetup([
        '--client',
        'cursor',
        '--scope',
        'project',
        '--no-statusline',
        '--no-menubar',
      ]);
    } finally {
      cwd.mockRestore();
      logged = log.mock.calls.flat().join('\n');
      log.mockRestore();
    }
    expect(code).toBe(0);

    expect(fs.existsSync(managedCursor)).toBe(false);
    expect(fs.existsSync(path.dirname(managedSkill))).toBe(false);
    expect(fs.readFileSync(userRule, 'utf8')).toBe('# user rule\n');
    expect(fs.readFileSync(userSkill, 'utf8')).toBe('# user skill\n');
    const harness = fs.readFileSync(path.join(workspace, '.cursor', 'rules', 'agent-deck.mdc'), 'utf8');
    expect(harness).toContain('<!-- agent-deck:harness:start -->');
    expect(harness).toContain('<!-- agent-deck:harness:end -->');
    expect(logged).toContain('Removed 2 legacy playbook stub(s)');

    // Idempotent: a second run succeeds with no further changes.
    const rerunLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rerunCwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    try {
      expect(
        await runSetup([
          '--client',
          'cursor',
          '--scope',
          'project',
          '--no-statusline',
          '--no-menubar',
        ]),
      ).toBe(0);
    } finally {
      rerunCwd.mockRestore();
      rerunLog.mockRestore();
    }
    expect(rerunLog.mock.calls.flat().join('\n')).not.toContain('legacy playbook stub(s)');
    expect(fs.readFileSync(userRule, 'utf8')).toBe('# user rule\n');
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('names the exact path and fails setup when a managed stub cannot be removed', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-cleanup-fail-'));
    const managedCursor = path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', 'pb_old.mdc');
    fs.mkdirSync(path.dirname(managedCursor), { recursive: true });
    fs.writeFileSync(
      managedCursor,
      '<!-- agent-deck:stub:start pb_old -->\n# legacy\n<!-- agent-deck:stub:end -->\n',
    );

    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((target: unknown, ...rest: unknown[]) => {
      if (String(target) === managedCursor) {
        throw new Error('EACCES: permission denied');
      }
      return (realUnlink as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.unlinkSync);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    let code = -1;
    let errored = '';
    try {
      code = await runSetup([
        '--client',
        'cursor',
        '--scope',
        'project',
        '--no-statusline',
        '--no-menubar',
      ]);
    } finally {
      cwd.mockRestore();
      errored = error.mock.calls.flat().join('\n');
      log.mockRestore();
      vi.restoreAllMocks();
    }
    expect(code).toBe(1);
    expect(errored).toContain(managedCursor);
    // Failure happens before the harness install, so no new files are written.
    expect(fs.existsSync(path.join(workspace, '.cursor', 'rules', 'agent-deck.mdc'))).toBe(false);
    fs.rmSync(workspace, { recursive: true, force: true });
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
