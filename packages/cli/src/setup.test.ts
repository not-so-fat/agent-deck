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

  it('NOT-296: Codex setup installs no status-line hook even with explicit --statusline', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-codex-nostatus-'));
    const codexDir = path.join(tmpHome, '.codex');
    const previousCodexHome = process.env.CODEX_HOME;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    delete process.env.CODEX_HOME;
    fs.mkdirSync(codexDir, { recursive: true });

    try {
      const code = await runSetup([
        '--client',
        'codex',
        '--scope',
        'global',
        '--statusline',
        '--no-menubar',
      ]);
      expect(code).toBe(0);
      // No command hook for Codex: the script is never written and no
      // statusLine/HUD integration is added (Codex exposes built-in fields only).
      expect(fs.existsSync(path.join(tmpHome, '.agent-deck', 'bin', 'statusline.sh'))).toBe(
        false,
      );
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
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

  it('setup completion text states the first-turn receipt expectation (NOT-295)', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-receipt-'));
    const previousCodexHome = process.env.CODEX_HOME;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    delete process.env.CODEX_HOME;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let code = -1;
    let logged = '';
    try {
      code = await runSetup([
        '--client',
        'codex',
        '--scope',
        'global',
        '--no-statusline',
        '--no-menubar',
      ]);
    } finally {
      logged = log.mock.calls.flat().join('\n');
      log.mockRestore();
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      vi.restoreAllMocks();
    }
    expect(code).toBe(0);
    // Users learn what the first turn shows and that the transcript
    // receipt — not a workspace badge — is authoritative.
    expect(logged).toContain('First turn: the agent calls get_session_context once and shows exactly one');
    expect(logged).toContain('verbatim display_summary line');
    expect(logged).toContain('authoritative');
    expect(logged).toContain('terminal status lines are optional secondary context');
    // The installed guidance carries the same receipt contract.
    const agents = fs.readFileSync(path.join(tmpHome, '.codex', 'AGENTS.md'), 'utf8');
    expect(agents).toContain('exactly one transcript line');
    fs.rmSync(tmpHome, { recursive: true, force: true });
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

describe('NOT-387 muse setup', () => {
  const MUSE_ARGS = [
    '--client',
    'muse',
    '--scope',
    'global',
    '--host',
    '127.0.0.1',
    '--mcp-port',
    '1110',
    '--no-statusline',
    '--no-menubar',
  ];

  async function runWithXdg(
    xdg: string | undefined,
    home: string,
    args: string[],
  ): Promise<{ code: number; logged: string }> {
    const previousXdg = process.env.XDG_CONFIG_HOME;
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdg;
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await runSetup(args);
      return { code, logged: log.mock.calls.flat().join('\n') };
    } finally {
      log.mockRestore();
      vi.restoreAllMocks();
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  }

  it('skips status line for Muse by default and honors explicit flags', () => {
    expect(resolveSetupStatusline('muse')).toBe(false);
    expect(resolveSetupStatusline('muse', false)).toBe(false);
    expect(resolveSetupStatusline('muse', true)).toBe(true);
    expect(resolveSetupMenubar('muse', false)).toBe(false);
  });

  it('lists muse in the missing-client error and keeps claude-desktop project rejected', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runSetup(['--scope', 'global', '--no-menubar'])).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('muse');
      error.mockClear();
      expect(
        await runSetup(['--client', 'claude-desktop', '--scope', 'project', '--no-menubar']),
      ).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toContain('--scope project is only supported');
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });

  it('writes global Muse settings through XDG_CONFIG_HOME idempotently', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-muse-home-'));
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-muse-xdg-'));
    const settingsPath = path.join(tmpXdg, 'muse', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          theme: 'dark',
          mcpServers: {
            memory: { command: 'npx', args: ['-y', 'memory'] },
          },
        },
        null,
        2,
      )}\n`,
    );

    try {
      const first = await runWithXdg(tmpXdg, tmpHome, MUSE_ARGS);
      expect(first.code).toBe(0);
      expect(first.logged).toContain('Start a new Muse process');
      expect(first.logged).toContain('/mcp');
      expect(first.logged).toContain('workspace trust');
      expect(first.logged).toContain('agent-deck use <deck> --client muse');
      expect(first.logged).toContain('MCP endpoint → http://127.0.0.1:1110/mcp');
      const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      // Unrelated settings and servers survive parsing byte-equivalent.
      expect(written.theme).toBe('dark');
      expect((written.mcpServers as Record<string, unknown>).memory).toEqual({
        command: 'npx',
        args: ['-y', 'memory'],
      });
      expect(written.schema_version).toBe(1);
      // Exact launcher fields only — toEqual fails on any extra field.
      expect((written.mcpServers as Record<string, unknown>)['agent-deck']).toEqual({
        command: 'agent-deck',
        args: ['mcp-launch'],
        env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
      });
      // No Muse files leak into the mocked home.
      expect(fs.existsSync(path.join(tmpHome, '.config', 'muse', 'settings.json'))).toBe(false);

      const beforeSecond = fs.readFileSync(settingsPath, 'utf8');
      const second = await runWithXdg(tmpXdg, tmpHome, MUSE_ARGS);
      expect(second.code).toBe(0);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(beforeSecond);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  it('NOT-388: clean global muse setup installs three skills, second run changes nothing', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-muse-skills-home-'));
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-muse-skills-xdg-'));
    const snapshot = (dir: string): Map<string, string> => {
      const out = new Map<string, string>();
      const walk = (current: string) => {
        if (!fs.existsSync(current)) return;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.set(path.relative(dir, full), fs.readFileSync(full, 'utf8'));
        }
      };
      walk(dir);
      return out;
    };
    try {
      const first = await runWithXdg(tmpXdg, tmpHome, MUSE_ARGS);
      expect(first.code).toBe(0);
      for (const id of ['agent-deck-session', 'agent-deck-playbooks', 'agent-deck-setup']) {
        const skillPath = path.join(tmpXdg, 'muse', 'skills', id, 'SKILL.md');
        expect(fs.existsSync(skillPath)).toBe(true);
        const content = fs.readFileSync(skillPath, 'utf8');
        expect(content).toContain(`name: ${id}`);
        expect(content).toContain('<!-- agent-deck:managed-skill -->');
      }
      const before = snapshot(path.join(tmpXdg, 'muse'));
      expect(before.size).toBeGreaterThanOrEqual(4); // settings.json + 3 skills
      const second = await runWithXdg(tmpXdg, tmpHome, MUSE_ARGS);
      expect(second.code).toBe(0);
      expect(snapshot(path.join(tmpXdg, 'muse'))).toEqual(before);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  it('NOT-388: muse skill collision exits 1, names the path, and leaves bytes unchanged', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-muse-coll-home-'));
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-muse-coll-xdg-'));
    const collisionPath = path.join(tmpXdg, 'muse', 'skills', 'agent-deck-setup', 'SKILL.md');
    fs.mkdirSync(path.dirname(collisionPath), { recursive: true });
    const userBytes = '# My own setup notes\n\nKeep me.\n';
    fs.writeFileSync(collisionPath, userBytes, 'utf8');
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpXdg;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runSetup(MUSE_ARGS)).toBe(1);
      const errored = error.mock.calls.flat().join('\n');
      expect(errored).toContain(collisionPath);
      expect(errored).toContain('agent-deck setup --client muse');
      expect(fs.readFileSync(collisionPath, 'utf8')).toBe(userBytes);
      expect(fs.existsSync(path.join(tmpXdg, 'muse', 'skills', 'agent-deck-session'))).toBe(false);
    } finally {
      error.mockRestore();
      log.mockRestore();
      vi.restoreAllMocks();
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  it('falls back to ~/.config/muse when XDG_CONFIG_HOME is unset', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-muse-fallback-'));
    const settingsPath = path.join(tmpHome, '.config', 'muse', 'settings.json');
    try {
      const { code } = await runWithXdg(undefined, tmpHome, MUSE_ARGS);
      expect(code).toBe(0);
      const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      expect(written.schema_version).toBe(1);
      expect((written.mcpServers as Record<string, unknown>)['agent-deck']).toEqual({
        command: 'agent-deck',
        args: ['mcp-launch'],
        env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
      });
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('merges project .mcp.json and leaves other project servers unchanged', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-muse-project-'));
    const mcpPath = path.join(workspace, '.mcp.json');
    fs.writeFileSync(
      mcpPath,
      `${JSON.stringify({ mcpServers: { memory: { command: 'npx', args: ['-y', 'memory'] } } }, null, 2)}\n`,
    );
    const args = [
      '--client',
      'muse',
      '--scope',
      'project',
      '--host',
      '127.0.0.1',
      '--mcp-port',
      '1110',
      '--no-statusline',
      '--no-menubar',
    ];
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runSetup(args)).toBe(0);
      const written = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as Record<string, unknown>;
      expect(written).toEqual({
        mcpServers: {
          memory: { command: 'npx', args: ['-y', 'memory'] },
          'agent-deck': {
            command: 'agent-deck',
            args: ['mcp-launch'],
            env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
          },
        },
      });
      // Project harness merges root AGENTS.md; no Cursor/Claude-only files.
      expect(fs.existsSync(path.join(workspace, '.cursor'))).toBe(false);
      expect(fs.existsSync(path.join(workspace, 'CLAUDE.md'))).toBe(false);
      const agentsPath = path.join(workspace, 'AGENTS.md');
      expect(fs.existsSync(agentsPath)).toBe(true);
      const agents = fs.readFileSync(agentsPath, 'utf8');
      expect(agents).toContain('<!-- agent-deck:harness:start -->');
      expect(agents).toContain('call `get_session_context` once');
      expect(agents).toContain('display_summary');

      const beforeSecond = fs.readFileSync(mcpPath, 'utf8');
      const agentsBefore = fs.readFileSync(agentsPath, 'utf8');
      expect(await runSetup(args)).toBe(0);
      expect(fs.readFileSync(mcpPath, 'utf8')).toBe(beforeSecond);
      expect(fs.readFileSync(agentsPath, 'utf8')).toBe(agentsBefore);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
      vi.restoreAllMocks();
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('leaves settings untouched and exits 1 on an incompatible schema_version', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-muse-schema-'));
    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-setup-muse-sxdg-'));
    const settingsPath = path.join(tmpXdg, 'muse', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = `${JSON.stringify(
      {
        schema_version: 2,
        mcpServers: { memory: { command: 'npx', args: ['-y', 'memory'] } },
      },
      null,
      2,
    )}\n`;
    fs.writeFileSync(settingsPath, original);
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpXdg;
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runSetup(MUSE_ARGS)).toBe(1);
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(original);
      const errored = error.mock.calls.flat().join('\n');
      expect(errored).toContain(settingsPath);
      expect(errored).toContain('expected 1');
    } finally {
      error.mockRestore();
      log.mockRestore();
      vi.restoreAllMocks();
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpXdg, { recursive: true, force: true });
    }
  });
});
