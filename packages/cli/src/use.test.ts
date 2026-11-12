import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';

import { formatUseSummary, parseUseArgs, runUse } from './use';
import { writeUseManifest } from './playbook-stubs';
import { HOME_STORE_WRITE_BLOCKED_HINT } from './home-write';

const createCollectionAdminMock = vi.fn();

vi.mock('./backend-runtime', () => ({
  createCollectionAdmin: () => createCollectionAdminMock(),
}));

function defaultCollectionAdmin() {
  return {
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
  };
}

const tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  createCollectionAdminMock.mockReset();
  createCollectionAdminMock.mockImplementation(defaultCollectionAdmin);
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
  beforeEach(() => {
    createCollectionAdminMock.mockImplementation(defaultCollectionAdmin);
  });

  it('parseUseArgs requires deck or --refresh', () => {
    expect(parseUseArgs([])).toEqual({ error: 'deck name or id is required (or pass --refresh)' });
    expect(parseUseArgs(['dev'])).toMatchObject({ deckRef: 'dev', refresh: false });
    expect(parseUseArgs(['--refresh'])).toMatchObject({ refresh: true });
  });

  it.each([
    { args: ['dev'], clients: 'both' },
    { args: ['dev', '--client', 'cursor'], clients: 'cursor' },
    { args: ['dev', '--client', 'claude'], clients: 'claude' },
    { args: ['dev', '--client', 'codex'], clients: 'codex' },
    { args: ['dev', '--client', 'muse'], clients: 'muse' },
    { args: ['dev', '--client', 'both'], clients: 'both' },
  ])('NOT-387: parseUseArgs accepts --client $clients', ({ args, clients }) => {
    expect(parseUseArgs(args)).toMatchObject({ deckRef: 'dev', clients });
  });

  it('NOT-387: parseUseArgs rejects unknown clients', () => {
    expect(parseUseArgs(['dev', '--client', 'vim'])).toEqual({
      error: '--client must be cursor, claude, codex, muse, or both',
    });
  });

  it('writes v3 assignment and exclude lines without per-playbook stubs or grant endpoints', async () => {
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

    expect(withMcp.deck.name).toBe('dev');
    expect(withMcp.playbookCount).toBe(1);
    expect(fs.existsSync(path.join(workspace, '.cursor', 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.agent-deck', 'use.json'))).toBe(true);
    // NOT-206: bind-time sync writes no per-playbook stubs; discovery is runtime-only.
    expect(fs.existsSync(path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', 'pb_test.mdc'))).toBe(
      false,
    );
    const mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    // NOT-567 per-folder pure-MCP entry — toEqual fails on any extra field.
    expect(mcp.mcpServers['agent-deck']).toEqual({
      url: `http://${parsed.host}:${parsed.mcpPort}/mcp`,
      headers: { 'x-agent-deck-workspace': workspace },
    });
    expect(fs.readFileSync(path.join(workspace, '.cursor', 'mcp.json'), 'utf8')).not.toContain(
      'deck-1',
    );

    // NOT-567: `use` never touches the global entry — the legacy file is byte-identical.
    const globalMcp = JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(globalMcp.mcpServers['agent-deck']).toEqual({ url: 'http://127.0.0.1:1110/mcp' });
    expect(log.mock.calls.flat().join('\n')).not.toContain('upgraded the legacy bare URL');

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

  it('removes managed legacy stubs on refresh while preserving user content', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
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
    expect(fs.existsSync(managedCursor)).toBe(false);
    expect(fs.existsSync(path.dirname(managedSkill))).toBe(false);
    expect(fs.readFileSync(userRule, 'utf8')).toBe('# user rule\n');
    expect(fs.readFileSync(userSkill, 'utf8')).toBe('# user skill\n');
    expect(log.mock.calls.flat().join('\n')).toContain('Removed 2 legacy playbook stub(s)');
  });

  it('removes managed legacy stubs on full use and stays idempotent', async () => {
    const workspace = makeWorkspace();
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } } }, null, 2)}\n`,
    );
    const managedCursor = path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', 'pb_old.mdc');
    const userRule = path.join(workspace, '.cursor', 'rules', 'custom.mdc');
    const lookalike = path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', 'notes.mdc');
    const managedSkill = path.join(workspace, '.claude', 'skills', 'agent-deck-old', 'SKILL.md');
    const userSkill = path.join(workspace, '.claude', 'skills', 'agent-deck-manual', 'SKILL.md');
    fs.mkdirSync(path.dirname(managedCursor), { recursive: true });
    fs.writeFileSync(
      managedCursor,
      '<!-- agent-deck:stub:start pb_old -->\n# legacy\n<!-- agent-deck:stub:end -->\n',
    );
    fs.writeFileSync(userRule, '# user rule\n');
    fs.writeFileSync(lookalike, '# similarly named but user-authored\n');
    fs.mkdirSync(path.dirname(managedSkill), { recursive: true });
    fs.writeFileSync(
      managedSkill,
      '<!-- agent-deck:stub:start pb_old -->\n# legacy\n<!-- agent-deck:stub:end -->\n',
    );
    fs.mkdirSync(path.dirname(userSkill), { recursive: true });
    fs.writeFileSync(userSkill, '# hand-written skill sharing the prefix\n');

    const parsed = parseUseArgs(['dev']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in first).toBe(false);
    if ('error' in first) {
      return;
    }
    expect(first.stubs.cursor.removed).toBe(1);
    expect(first.stubs.claude.removed).toBe(1);
    expect(fs.existsSync(managedCursor)).toBe(false);
    expect(fs.existsSync(path.dirname(managedSkill))).toBe(false);
    expect(fs.readFileSync(userRule, 'utf8')).toBe('# user rule\n');
    expect(fs.readFileSync(lookalike, 'utf8')).toBe('# similarly named but user-authored\n');
    expect(fs.readFileSync(userSkill, 'utf8')).toBe('# hand-written skill sharing the prefix\n');
    expect(log.mock.calls.flat().join('\n')).toContain('Removed 2 legacy playbook stub(s)');

    log.mockClear();
    const second = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in second).toBe(false);
    if ('error' in second) {
      return;
    }
    expect(second.stubs.cursor.removed).toBe(0);
    expect(second.stubs.claude.removed).toBe(0);
    expect(log.mock.calls.flat().join('\n')).not.toContain('legacy playbook stub(s)');
  });

  it('reports the exact path when a managed stub cannot be removed', async () => {
    const workspace = makeWorkspace();
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    const managedCursor = path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', 'pb_old.mdc');
    const userRule = path.join(workspace, '.cursor', 'rules', 'custom.mdc');
    fs.mkdirSync(path.dirname(managedCursor), { recursive: true });
    fs.writeFileSync(
      managedCursor,
      '<!-- agent-deck:stub:start pb_old -->\n# legacy\n<!-- agent-deck:stub:end -->\n',
    );
    fs.writeFileSync(userRule, '# user rule\n');

    const realUnlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(((target: unknown, ...rest: unknown[]) => {
      if (String(target) === managedCursor) {
        throw new Error('EACCES: permission denied');
      }
      return (realUnlink as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.unlinkSync);

    const parsed = parseUseArgs(['dev']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }
    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(true);
    if (!('error' in result)) {
      return;
    }
    expect(result.error).toContain(managedCursor);
    expect(fs.readFileSync(userRule, 'utf8')).toBe('# user rule\n');
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

  it('NOT-567: leaves a legacy global launcher untouched and writes the per-folder HTTP entry', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    const legacyGlobal = {
      mcpServers: {
        'agent-deck': {
          command: 'agent-deck',
          args: ['mcp-launch'],
          env: { AGENT_DECK_HOST: '127.0.0.1', AGENT_DECK_MCP_PORT: '1110' },
        },
      },
    };
    fs.writeFileSync(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      `${JSON.stringify(legacyGlobal, null, 2)}\n`,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const parsed = parseUseArgs(['dev', '--client', 'cursor']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }
    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(false);
    // The global fallback is `setup`'s job — `use` never touches it.
    expect(JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))).toEqual(
      legacyGlobal,
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain('workspace pin');
    const mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers['agent-deck']).toEqual({
      url: `http://${parsed.host}:${parsed.mcpPort}/mcp`,
      headers: { 'x-agent-deck-workspace': workspace },
    });
  });

  it('NOT-567: stays silent about a custom global wrapper it never touches', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
    const custom = {
      mcpServers: {
        'agent-deck': { command: 'npx', args: ['-y', 'custom-wrapper'] },
      },
    };
    fs.writeFileSync(
      path.join(fakeHome, '.cursor', 'mcp.json'),
      `${JSON.stringify(custom, null, 2)}\n`,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = parseUseArgs(['dev', '--client', 'cursor']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }
    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(false);
    expect(warn.mock.calls.flat().join('\n')).not.toContain('left custom agent-deck entry unchanged');
    expect(JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'))).toEqual(
      custom,
    );
  });

  it('NOT-567: rewrites the per-folder HTTP entry without the home store when assignment already matches', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    // No ~/.cursor — the sandbox path must still succeed when only the
    // per-folder entry is needed (`use` never touches the global file).
    writeUseManifest(workspace, {
      version: 3,
      deckId: 'deck-1',
      deckName: 'dev',
      mcpUrl: 'http://127.0.0.1:1110/mcp',
    });
    createCollectionAdminMock.mockImplementation(() => {
      throw Object.assign(new Error('attempt to write a readonly database'), {
        code: 'SQLITE_READONLY',
      });
    });

    const parsed = parseUseArgs(['dev', '--client', 'cursor']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(false);
    if ('error' in result) {
      return;
    }

    expect(result.deck).toEqual({ id: 'deck-1', name: 'dev' });
    const mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(mcp.mcpServers['agent-deck']).toEqual({
      url: `http://${parsed.host}:${parsed.mcpPort}/mcp`,
      headers: { 'x-agent-deck-workspace': workspace },
    });
    expect(fs.existsSync(path.join(fakeHome, '.cursor', 'mcp.json'))).toBe(false);
    expect(createCollectionAdminMock).toHaveBeenCalled();
  });

  it('NOT-571: use --client muse writes use.json plus the per-folder HTTP .mcp.json, idempotently', async () => {
    const workspace = makeWorkspace();
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
    const fakeHome = makeWorkspace();
    const fakeXdg = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fakeXdg;

    const parsed = parseUseArgs(['dev', '--client', 'muse']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await runUse({ ...parsed, workspaceRoot: workspace });
      expect('error' in first).toBe(false);
      if ('error' in first) {
        return;
      }

      expect(first.deck).toEqual({ id: 'deck-1', name: 'dev' });
      expect(first.mcp).toEqual([{ client: 'muse', path: path.join(workspace, '.mcp.json') }]);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
      ) as { version: number; deckId: string; deckName: string };
      expect(manifest.version).toBe(3);
      expect(manifest.deckId).toBe('deck-1');
      expect(manifest.deckName).toBe('dev');

      const mcpPath = path.join(workspace, '.mcp.json');
      const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      // Exact per-folder HTTP shape — toEqual fails on any extra field.
      expect(mcp.mcpServers['agent-deck']).toEqual({
        type: 'http',
        url: `http://${parsed.host}:${parsed.mcpPort}/mcp`,
        headers: { 'x-agent-deck-workspace': workspace },
      });
      expect(fs.readFileSync(mcpPath, 'utf8')).not.toContain('deck-1');
      expect(fs.readFileSync(mcpPath, 'utf8')).not.toContain('mcp-launch');

      // No Cursor- or Claude-only files, and no other host configs touched.
      expect(fs.existsSync(path.join(workspace, '.cursor'))).toBe(false);
      expect(fs.existsSync(path.join(workspace, '.claude'))).toBe(false);
      expect(fs.existsSync(path.join(fakeHome, '.cursor', 'mcp.json'))).toBe(false);
      expect(fs.existsSync(path.join(fakeXdg, 'muse', 'settings.json'))).toBe(false);

      // Git repository plus no legacy user entry: no warnings.
      expect(warn).not.toHaveBeenCalled();

      // The summary names the Muse trust + reload steps.
      const summary = formatUseSummary(first);
      expect(summary).toContain('Muse: trust this folder');
      expect(summary).toContain('.mcp.json');
      expect(summary).toContain('reload MCP');
      expect(summary).toContain('restart Muse');

      const useJsonBefore = fs.readFileSync(
        path.join(workspace, '.agent-deck', 'use.json'),
        'utf8',
      );
      const mcpBefore = fs.readFileSync(mcpPath, 'utf8');
      const second = await runUse({ ...parsed, workspaceRoot: workspace });
      expect('error' in second).toBe(false);
      expect(
        fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
      ).toBe(useJsonBefore);
      expect(fs.readFileSync(mcpPath, 'utf8')).toBe(mcpBefore);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it('NOT-571: use --client muse leaves a sibling Claude entry byte-identical', async () => {
    const workspace = makeWorkspace();
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
    const fakeHome = makeWorkspace();
    const fakeXdg = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fakeXdg;

    const parsed = parseUseArgs(['dev', '--client', 'muse']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    // A Claude run already wrote the identical entry plus an unrelated server.
    const memoryServer = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] };
    const mcpPath = path.join(workspace, '.mcp.json');
    fs.writeFileSync(
      mcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            memory: memoryServer,
            'agent-deck': {
              type: 'http',
              url: `http://${parsed.host}:${parsed.mcpPort}/mcp`,
              headers: { 'x-agent-deck-workspace': workspace },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const before = fs.readFileSync(mcpPath, 'utf8');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runUse({ ...parsed, workspaceRoot: workspace });
      expect('error' in result).toBe(false);
      // Same file, same shape — the Muse write is a no-op on Claude's entry.
      expect(fs.readFileSync(mcpPath, 'utf8')).toBe(before);
      const mcp = JSON.parse(before) as { mcpServers: Record<string, unknown> };
      expect(mcp.mcpServers.memory).toEqual(memoryServer);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it('NOT-571: use --client muse replaces a legacy launcher shape, keeping others, byte-identical on re-run', async () => {
    const workspace = makeWorkspace();
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
    const fakeHome = makeWorkspace();
    const fakeXdg = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fakeXdg;

    const parsed = parseUseArgs(['dev', '--client', 'muse']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    // The Muse-shaped launcher an older `use --client muse` wrote: no
    // type, no workspace pin — plus an unrelated server.
    const memoryServer = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] };
    const mcpPath = path.join(workspace, '.mcp.json');
    fs.writeFileSync(
      mcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            memory: memoryServer,
            'agent-deck': {
              command: 'agent-deck',
              args: ['mcp-launch'],
              env: { AGENT_DECK_MCP_PORT: '9999', AGENT_DECK_HOST: '127.0.0.1' },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const first = await runUse({ ...parsed, workspaceRoot: workspace });
      expect('error' in first).toBe(false);
      if ('error' in first) {
        return;
      }

      const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(mcp.mcpServers.memory).toEqual(memoryServer);
      // Exact per-folder HTTP shape — toEqual fails on any leftover field.
      expect(mcp.mcpServers['agent-deck']).toEqual({
        type: 'http',
        url: `http://${parsed.host}:${parsed.mcpPort}/mcp`,
        headers: { 'x-agent-deck-workspace': workspace },
      });
      expect(mcp.mcpServers['agent-deck']).not.toHaveProperty('command');
      expect(fs.readFileSync(mcpPath, 'utf8')).not.toContain('mcp-launch');

      const before = fs.readFileSync(mcpPath, 'utf8');
      const second = await runUse({ ...parsed, workspaceRoot: workspace });
      expect('error' in second).toBe(false);
      expect(fs.readFileSync(mcpPath, 'utf8')).toBe(before);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it('NOT-571: use --client muse warns outside a git repository without failing', async () => {
    const workspace = makeWorkspace();
    // No `git init`: Muse would ignore the project file here.
    const fakeHome = makeWorkspace();
    const fakeXdg = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fakeXdg;

    const parsed = parseUseArgs(['dev', '--client', 'muse']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runUse({ ...parsed, workspaceRoot: workspace });
      // Exit status unchanged: the assignment and .mcp.json are written.
      expect('error' in result).toBe(false);
      expect(fs.existsSync(path.join(workspace, '.agent-deck', 'use.json'))).toBe(true);
      expect(fs.existsSync(path.join(workspace, '.mcp.json'))).toBe(true);

      const warned = warn.mock.calls.flat().join('\n');
      expect(warned).toContain('not inside a git repository');
      expect(warned).toContain('.mcp.json only inside a repository');
      expect(warned).toContain('git init');
      expect(warned).toContain('trust the folder');
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it('NOT-571: use --client muse warns on a legacy launcher entry in the user settings without failing', async () => {
    const workspace = makeWorkspace();
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
    const fakeHome = makeWorkspace();
    const fakeXdg = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fakeXdg;

    // Agent Deck's own legacy launcher entry in the Muse user settings.
    const settingsPath = path.join(fakeXdg, 'muse', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          schema_version: 1,
          mcpServers: {
            'agent-deck': {
              command: 'agent-deck',
              args: ['mcp-launch'],
              env: { AGENT_DECK_MCP_PORT: '1110', AGENT_DECK_HOST: '127.0.0.1' },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const parsed = parseUseArgs(['dev', '--client', 'muse']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runUse({ ...parsed, workspaceRoot: workspace });
      // Exit status unchanged: the assignment and .mcp.json are written.
      expect('error' in result).toBe(false);
      expect(fs.existsSync(path.join(workspace, '.agent-deck', 'use.json'))).toBe(true);

      const warned = warn.mock.calls.flat().join('\n');
      expect(warned).toContain("still holds Agent Deck's legacy launcher entry");
      expect(warned).toContain('invalid_transport_combination');
      expect(warned).toContain('agent-deck setup --client muse');
      // Git repository, so only the legacy-user-entry warning fires.
      expect(warned).not.toContain('not inside a git repository');
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });

  it('exits with an explicit sandbox/home-write message when the home store is required', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    createCollectionAdminMock.mockImplementation(() => {
      throw Object.assign(new Error('attempt to write a readonly database'), {
        code: 'SQLITE_READONLY',
      });
    });

    const parsed = parseUseArgs(['dev', '--client', 'cursor']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect(result).toMatchObject({ error: expect.stringContaining(HOME_STORE_WRITE_BLOCKED_HINT) });
    if (!('error' in result)) {
      return;
    }
    expect(result.error).toContain('attempt to write a readonly database');
    expect(result.error.startsWith('attempt to write a readonly database')).toBe(false);
  });

  it('NOT-563: default use writes per-folder pure-MCP entries for Codex and Claude', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const parsed = parseUseArgs(['dev']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(false);
    if ('error' in result) {
      return;
    }

    const mcpUrl = `http://${parsed.host}:${parsed.mcpPort}/mcp`;
    const codexPath = path.join(workspace, '.codex', 'config.toml');
    const codexText = fs.readFileSync(codexPath, 'utf8');
    expect(codexText).toBe(
      `[mcp_servers.agent-deck]\nurl = "${mcpUrl}"\nhttp_headers = { "x-agent-deck-workspace" = "${workspace}" }\n`,
    );
    expect(codexText).not.toContain('deck-1');

    const claudePath = path.join(workspace, '.mcp.json');
    const claude = JSON.parse(fs.readFileSync(claudePath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(claude.mcpServers['agent-deck']).toEqual({
      type: 'http',
      url: mcpUrl,
      headers: { 'x-agent-deck-workspace': workspace },
    });
    expect(fs.readFileSync(claudePath, 'utf8')).not.toContain('deck-1');

    // The assignment still carries the deck id for the daemon to resolve.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
    ) as { deckId: string };
    expect(manifest.deckId).toBe('deck-1');

    expect(result.mcp).toContainEqual({ client: 'codex', path: codexPath });
    expect(result.mcp).toContainEqual({ client: 'claude', path: claudePath });
  });

  it('NOT-563: use preserves unrelated entries and is byte-identical on re-run', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const memoryServer = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] };
    fs.writeFileSync(
      path.join(workspace, '.mcp.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            memory: memoryServer,
            'agent-deck': {
              type: 'stdio',
              command: 'agent-deck',
              args: ['mcp-launch'],
              env: { AGENT_DECK_MCP_PORT: '9999', AGENT_DECK_HOST: '127.0.0.1' },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const codexPrefix = '[model]\nname = "gpt-5"\n\n[mcp_servers.other]\nurl = "http://example.com/mcp"\n';
    fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.codex', 'config.toml'), codexPrefix);

    const parsed = parseUseArgs(['dev']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const first = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in first).toBe(false);
    if ('error' in first) {
      return;
    }

    const claudePath = path.join(workspace, '.mcp.json');
    const claude = JSON.parse(fs.readFileSync(claudePath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(claude.mcpServers.memory).toEqual(memoryServer);
    expect(claude.mcpServers['agent-deck']).toEqual({
      type: 'http',
      url: `http://${parsed.host}:${parsed.mcpPort}/mcp`,
      headers: { 'x-agent-deck-workspace': workspace },
    });

    const codexPath = path.join(workspace, '.codex', 'config.toml');
    const codexText = fs.readFileSync(codexPath, 'utf8');
    expect(codexText.startsWith(codexPrefix)).toBe(true);
    expect(codexText).toContain('[mcp_servers.agent-deck]');

    const claudeBefore = fs.readFileSync(claudePath, 'utf8');
    const codexBefore = fs.readFileSync(codexPath, 'utf8');
    const second = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in second).toBe(false);
    expect(fs.readFileSync(claudePath, 'utf8')).toBe(claudeBefore);
    expect(fs.readFileSync(codexPath, 'utf8')).toBe(codexBefore);
  });

  it('NOT-563: use removes a stale codex env sub-table left by codex mcp add', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.codex', 'config.toml'),
      [
        '[mcp_servers.agent-deck]',
        'command = "agent-deck"',
        '',
        '[mcp_servers.agent-deck.env]',
        'AGENT_DECK_WORKSPACE = "/stale/ws"',
        '',
      ].join('\n'),
    );

    const parsed = parseUseArgs(['dev', '--client', 'codex']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(false);
    if ('error' in result) {
      return;
    }

    const mcpUrl = `http://${parsed.host}:${parsed.mcpPort}/mcp`;
    const codexPath = path.join(workspace, '.codex', 'config.toml');
    const codexText = fs.readFileSync(codexPath, 'utf8');
    expect(codexText).toBe(
      `[mcp_servers.agent-deck]\nurl = "${mcpUrl}"\nhttp_headers = { "x-agent-deck-workspace" = "${workspace}" }\n`,
    );
    expect(codexText).not.toContain('AGENT_DECK_WORKSPACE');

    const second = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in second).toBe(false);
    expect(fs.readFileSync(codexPath, 'utf8')).toBe(codexText);
  });

  it('NOT-563: summary names the Claude approval, Codex trust, and reload-MCP steps', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const parsed = parseUseArgs(['dev']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }
    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(false);
    if ('error' in result) {
      return;
    }
    const summary = formatUseSummary(result);
    expect(summary).toContain('approve the project agent-deck entry');
    expect(summary).toContain('Cursor: approve the project agent-deck server');
    expect(summary).toContain('trust this folder');
    expect(summary).toContain('reload MCP');

    const cursorOnly = await runUse({
      ...parsed,
      clients: 'cursor',
      workspaceRoot: workspace,
    });
    expect('error' in cursorOnly).toBe(false);
    if ('error' in cursorOnly) {
      return;
    }
    const cursorSummary = formatUseSummary(cursorOnly);
    // NOT-567: the Cursor steps show only when Cursor was written.
    expect(cursorSummary).toContain('Cursor: approve the project agent-deck server');
    expect(cursorSummary).not.toContain('Claude Code: approve the project agent-deck entry');
    expect(cursorSummary).not.toContain('trust this folder');
  });

  it('NOT-567: use writes the per-folder cursor HTTP entry, preserving others and byte-identical on re-run', async () => {
    const workspace = makeWorkspace();
    const fakeHome = makeWorkspace();
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const memoryServer = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] };
    fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.cursor', 'mcp.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            memory: memoryServer,
            'agent-deck': {
              command: 'agent-deck',
              args: ['mcp-launch'],
              env: { AGENT_DECK_MCP_PORT: '9999', AGENT_DECK_HOST: '127.0.0.1' },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const parsed = parseUseArgs(['dev', '--client', 'cursor']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const first = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in first).toBe(false);
    if ('error' in first) {
      return;
    }

    const cursorPath = path.join(workspace, '.cursor', 'mcp.json');
    const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cursor.mcpServers.memory).toEqual(memoryServer);
    // Exact per-folder shape — toEqual fails on any extra field.
    expect(cursor.mcpServers['agent-deck']).toEqual({
      url: `http://${parsed.host}:${parsed.mcpPort}/mcp`,
      headers: { 'x-agent-deck-workspace': workspace },
    });
    expect(fs.readFileSync(cursorPath, 'utf8')).not.toContain('deck-1');
    expect(first.mcp).toContainEqual({ client: 'cursor', path: cursorPath });

    const before = fs.readFileSync(cursorPath, 'utf8');
    const second = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in second).toBe(false);
    expect(fs.readFileSync(cursorPath, 'utf8')).toBe(before);
  });
});
