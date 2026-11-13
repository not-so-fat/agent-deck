import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeDefaultDeck } from '@agent-deck/shared';
import { cursorProjectSlug, type HostId, type HostLiveSession } from './host-connection';
import { runDoctor } from './start';

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

const CLIENT_NAMES: Record<HostId, string> = {
  codex: 'codex',
  claude: 'claude-code',
  cursor: 'cursor',
  muse: 'muse',
};

function session(host: HostId, workspaceRoot?: string): HostLiveSession {
  return workspaceRoot === undefined
    ? { clientName: CLIENT_NAMES[host] }
    : { workspaceRoot, clientName: CLIENT_NAMES[host] };
}

describe('doctor host connections (NOT-574)', () => {
  const tmpDirs: string[] = [];
  let output: string[];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let originalWarn: typeof console.warn;
  let savedCodexHome: string | undefined;
  let savedCodexBin: string | undefined;
  let savedXdg: string | undefined;
  let savedAgentDeckHome: string | undefined;

  beforeEach(() => {
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
    savedCodexHome = process.env.CODEX_HOME;
    savedCodexBin = process.env.CODEX_BIN;
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedAgentDeckHome = process.env.AGENT_DECK_HOME;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    vi.restoreAllMocks();
    if (savedCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = savedCodexHome;
    }
    if (savedCodexBin === undefined) {
      delete process.env.CODEX_BIN;
    } else {
      process.env.CODEX_BIN = savedCodexBin;
    }
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    if (savedAgentDeckHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = savedAgentDeckHome;
    }
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoots(): { home: string; workspace: string; codexHome: string; xdg: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-doc-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-doc-ws-'));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-doc-codex-'));
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-doc-xdg-'));
    tmpDirs.push(home, workspace, codexHome, xdg);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    process.env.CODEX_HOME = codexHome;
    process.env.XDG_CONFIG_HOME = xdg;
    // No live Codex CLI in doctor tests: an absent binary reports the
    // plugin check as skipped without touching the real installation.
    process.env.CODEX_BIN = path.join(codexHome, 'no-such-codex');
    return { home, workspace, codexHome, xdg };
  }

  function canonical(workspace: string): string {
    return fs.realpathSync(workspace);
  }

  function connectionLines(): string[] {
    return output.join('\n').split('\n').filter((line) => line.includes('connection:'));
  }

  function useIsolatedStore(): void {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-doc-store-'));
    tmpDirs.push(store);
    process.env.AGENT_DECK_HOME = store;
  }

  function deckSourceLines(): string[] {
    return output.join('\n').split('\n').filter((line) => line.includes('Deck source:'));
  }

  it('prints the state and remedy for every host, never OK for install state', async () => {
    makeRoots();
    await runDoctor({ daemonHealth: { up: false, sessions: [] } });
    const lines = connectionLines();
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).toContain('Codex connection: no-entry');
    expect(lines.join('\n')).toContain('Claude Code connection: no-entry');
    expect(lines.join('\n')).toContain('Cursor connection: no-entry');
    expect(lines.join('\n')).toContain('Muse connection: no-entry');
    for (const line of lines) {
      expect(line).toContain('Remedy:');
    }
    expect(lines.join('\n')).not.toContain('connected');
  });

  it('never reports connected when the daemon is down', async () => {
    const { home, workspace, codexHome, xdg } = makeRoots();
    // Every host gets a healthy entry plus trust/approval; only the
    // daemon is down.
    fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.codex', 'config.toml'),
      ['[mcp_servers.agent-deck]', 'url = "http://127.0.0.1:1110/mcp"', ''].join('\n'),
    );
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        `[projects."${canonical(workspace)}"]`,
        'trust_level = "trusted"',
        '',
        '[mcp_servers.agent-deck]',
        'url = "http://127.0.0.1:1110/mcp"',
        '',
      ].join('\n'),
    );
    writeJson(path.join(workspace, '.mcp.json'), {
      mcpServers: {
        'agent-deck': {
          type: 'http',
          url: 'http://127.0.0.1:1110/mcp',
          headers: { 'x-agent-deck-workspace': workspace },
        },
      },
    });
    writeJson(path.join(home, '.claude.json'), {
      mcpServers: { 'agent-deck': { type: 'http', url: 'http://127.0.0.1:1110/mcp' } },
      projects: {
        [canonical(workspace)]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ['agent-deck'],
          disabledMcpjsonServers: [],
        },
      },
    });
    writeJson(path.join(workspace, '.cursor', 'mcp.json'), {
      mcpServers: {
        'agent-deck': {
          url: 'http://127.0.0.1:1110/mcp',
          headers: { 'x-agent-deck-workspace': workspace },
        },
      },
    });
    writeJson(path.join(home, '.cursor', 'mcp.json'), {
      mcpServers: { 'agent-deck': { url: 'http://127.0.0.1:1110/mcp' } },
    });
    writeJson(
      path.join(home, '.cursor', 'projects', cursorProjectSlug(workspace), 'mcp-approvals.json'),
      ['agent-deck-abc123'],
    );
    fs.mkdirSync(path.join(workspace, '.git'));
    writeJson(path.join(xdg, 'muse', 'settings.json'), {
      mcpServers: { 'agent-deck': { type: 'http', url: 'http://127.0.0.1:1110/mcp' } },
      schema_version: 1,
    });
    writeJson(path.join(xdg, 'muse', 'trust.json'), {
      schema_version: 1,
      projects: { [canonical(workspace)]: { decision: 'trusted' } },
    });

    await runDoctor({ daemonHealth: { up: false, sessions: [] } });
    const text = connectionLines().join('\n');
    expect(text).toContain('Codex connection: entry-daemon-down');
    expect(text).toContain('Claude Code connection: entry-daemon-down');
    expect(text).toContain('Cursor connection: entry-daemon-down');
    expect(text).toContain('Muse connection: entry-daemon-down');
    expect(text).not.toContain('connected');
    expect(text).toContain('agent-deck start');
  });

  it('reports entry-daemon-down for every host when untrusted entries meet a stopped daemon (NOT-586)', async () => {
    const { workspace } = makeRoots();
    // Project entries everywhere, trust nowhere (plus a git repo so
    // Muse reaches the daemon gate rather than the repository gate).
    fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.codex', 'config.toml'),
      ['[mcp_servers.agent-deck]', 'url = "http://127.0.0.1:1110/mcp"', ''].join('\n'),
    );
    writeJson(path.join(workspace, '.mcp.json'), {
      mcpServers: {
        'agent-deck': {
          type: 'http',
          url: 'http://127.0.0.1:1110/mcp',
          headers: { 'x-agent-deck-workspace': workspace },
        },
      },
    });
    writeJson(path.join(workspace, '.cursor', 'mcp.json'), {
      mcpServers: {
        'agent-deck': {
          url: 'http://127.0.0.1:1110/mcp',
          headers: { 'x-agent-deck-workspace': workspace },
        },
      },
    });
    fs.mkdirSync(path.join(workspace, '.git'));

    await runDoctor({ daemonHealth: { up: false, sessions: [] } });
    const lines = connectionLines();
    expect(lines).toHaveLength(4);
    const text = lines.join('\n');
    expect(text).toContain('Codex connection: entry-daemon-down');
    expect(text).toContain('Claude Code connection: entry-daemon-down');
    expect(text).toContain('Cursor connection: entry-daemon-down');
    expect(text).toContain('Muse connection: entry-daemon-down');
    expect(text).not.toContain('folder-not-trusted');
    for (const line of lines) {
      expect(line).toContain('agent-deck start');
    }
  });

  it('never reports connected for an untrusted folder', async () => {
    const { workspace } = makeRoots();
    // Project entries everywhere, trust nowhere (plus a git repo so
    // Muse reaches its trust gate rather than the repository gate).
    fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.codex', 'config.toml'),
      ['[mcp_servers.agent-deck]', 'url = "http://127.0.0.1:1110/mcp"', ''].join('\n'),
    );
    writeJson(path.join(workspace, '.mcp.json'), {
      mcpServers: {
        'agent-deck': {
          type: 'http',
          url: 'http://127.0.0.1:1110/mcp',
          headers: { 'x-agent-deck-workspace': workspace },
        },
      },
    });
    writeJson(path.join(workspace, '.cursor', 'mcp.json'), {
      mcpServers: {
        'agent-deck': {
          url: 'http://127.0.0.1:1110/mcp',
          headers: { 'x-agent-deck-workspace': workspace },
        },
      },
    });
    fs.mkdirSync(path.join(workspace, '.git'));

    // Matching live sessions for every host: the trust gates still win.
    const matching = (['codex', 'claude', 'cursor', 'muse'] as const).map((host) =>
      session(host, workspace),
    );
    await runDoctor({ daemonHealth: { up: true, sessions: matching } });
    const text = connectionLines().join('\n');
    expect(text).toContain('Codex connection: folder-not-trusted');
    expect(text).toContain('Claude Code connection: folder-not-trusted');
    expect(text).toContain('Cursor connection: folder-not-trusted');
    expect(text).toContain('Muse connection: folder-not-trusted');
    expect(text).not.toContain('connected');
  });

  it('reports folder-not-repository and stale-conflicting-entry for Muse', async () => {
    const { workspace, xdg } = makeRoots();
    // Project HTTP entry, trusted, but no git repo.
    writeJson(path.join(workspace, '.mcp.json'), {
      mcpServers: {
        'agent-deck': {
          type: 'http',
          url: 'http://127.0.0.1:1110/mcp',
          headers: { 'x-agent-deck-workspace': workspace },
        },
      },
    });
    writeJson(path.join(xdg, 'muse', 'settings.json'), {
      mcpServers: { 'agent-deck': { type: 'http', url: 'http://127.0.0.1:1110/mcp' } },
      schema_version: 1,
    });
    writeJson(path.join(xdg, 'muse', 'trust.json'), {
      schema_version: 1,
      projects: { [canonical(workspace)]: { decision: 'trusted' } },
    });

    await runDoctor({
      daemonHealth: { up: true, sessions: [session('muse', workspace)] },
    });
    expect(connectionLines().join('\n')).toContain('Muse connection: folder-not-repository');

    // Now a stale stdio user entry against the HTTP project entry.
    output.length = 0;
    fs.mkdirSync(path.join(workspace, '.git'));
    writeJson(path.join(xdg, 'muse', 'settings.json'), {
      mcpServers: { 'agent-deck': { command: 'agent-deck', args: ['mcp-launch'] } },
      schema_version: 1,
    });
    await runDoctor({
      daemonHealth: { up: true, sessions: [session('muse', workspace)] },
    });
    const text = connectionLines().join('\n');
    expect(text).toContain('Muse connection: stale-conflicting-entry');
    expect(text).toContain('rewrite both entries to HTTP');
  });

  it('reports connected only for a session attributed to the host and folder', async () => {
    const { workspace, codexHome } = makeRoots();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-doc-else-'));
    tmpDirs.push(elsewhere);
    // Codex: global-only entry (no trust gate). Others: no entries.
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      ['[mcp_servers.agent-deck]', 'url = "http://127.0.0.1:1110/mcp"', ''].join('\n'),
    );

    await runDoctor({ daemonHealth: { up: true, sessions: [] } });
    let text = connectionLines().join('\n');
    expect(text).toContain('Codex connection: entry-daemon-up-no-session');
    expect(text).not.toContain('Codex connection: connected');

    // Sessions from another folder or another host must not connect Codex.
    output.length = 0;
    await runDoctor({
      daemonHealth: {
        up: true,
        sessions: [session('codex', elsewhere), session('cursor', workspace)],
      },
    });
    text = connectionLines().join('\n');
    expect(text).toContain('Codex connection: entry-daemon-up-no-session');
    expect(text).not.toContain('Codex connection: connected');

    output.length = 0;
    await runDoctor({
      daemonHealth: { up: true, sessions: [session('codex', workspace)] },
    });
    text = connectionLines().join('\n');
    expect(text).toContain('Codex connection: connected (global entry, 1 live session)');
    expect(text).toContain('No action needed');
  });

  it('NOT-602: reports the folder assignment over the default deck', async () => {
    const { workspace } = makeRoots();
    useIsolatedStore();
    writeDefaultDeck({ deckId: 'default-id', deckName: 'd1' });
    writeJson(path.join(workspace, '.agent-deck', 'use.json'), {
      version: 3,
      deckId: 'assign-id',
      deckName: 'd2',
      mcpUrl: 'http://127.0.0.1:1110/mcp',
    });

    await runDoctor({ daemonHealth: { up: false, sessions: [] } });
    const lines = deckSourceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Deck source: folder assignment (d2)');
  });

  it('NOT-602: reports the default deck for a folder with no assignment', async () => {
    makeRoots();
    useIsolatedStore();
    writeDefaultDeck({ deckId: 'default-id', deckName: 'd1' });

    await runDoctor({ daemonHealth: { up: false, sessions: [] } });
    const lines = deckSourceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Deck source: default deck (d1)');
  });

  it('NOT-602: reports none with the set-default remedy when unbound', async () => {
    makeRoots();
    useIsolatedStore();

    await runDoctor({ daemonHealth: { up: false, sessions: [] } });
    const lines = deckSourceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Deck source: none');
    expect(lines[0]).toContain('agent-deck default <deck>');
  });
});
