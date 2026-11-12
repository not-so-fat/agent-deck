import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalFolder,
  classifyHostConnection,
  countMatchingSessions,
  cursorProjectSlug,
  formatHostConnectionLine,
  hasMuseStaleConflict,
  hostIdForClientName,
  inspectAllHostConnections,
  inspectHostConnection,
  isClaudeProjectApproved,
  isCodexFolderTrusted,
  isCursorProjectApproved,
  isInsideGitRepository,
  isMuseFolderTrusted,
  isStdioAgentDeckEntry,
  parseCodexTrustedProjects,
  readJsonAgentDeckEntry,
  remedyFor,
  sessionMatchesHostFolder,
  type DaemonHealth,
  type HostId,
  type HostLiveSession,
} from './host-connection';
import { codexTomlHasAgentDeckEntry } from './mcp-config';

const DAEMON_DOWN: DaemonHealth = { up: false, sessions: [] };
const DAEMON_UP_NO_SESSION: DaemonHealth = { up: true, sessions: [] };

const FOLDER = path.resolve('ad-test-folder');
const OTHER_FOLDER = path.resolve('ad-other-folder');

/** MCP clientInfo.name stub per host (substring the matcher keys on). */
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

/** Daemon up with one live session attributed to this host and folder. */
function daemonConnected(host: HostId, folder: string): DaemonHealth {
  return { up: true, sessions: [session(host, folder)] };
}

const HTTP_ENTRY = { type: 'http', url: 'http://127.0.0.1:1110/mcp' };
const HTTP_PROJECT_ENTRY = (workspace: string) => ({
  type: 'http',
  url: 'http://127.0.0.1:1110/mcp',
  headers: { 'x-agent-deck-workspace': workspace },
});
const STDIO_ENTRY = { command: 'agent-deck', args: ['mcp-launch'] };

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeMcpJson(filePath: string, entry: unknown): void {
  writeJson(filePath, { mcpServers: { 'agent-deck': entry } });
}

describe('classifyHostConnection (NOT-574)', () => {
  it('returns no-entry when neither project nor global entry exists', () => {
    const result = classifyHostConnection({
      host: 'claude',
      folder: FOLDER,
      hasProjectEntry: false,
      hasGlobalEntry: false,
      folderTrusted: false,
      folderInRepository: false,
      hasStaleConflict: false,
      daemonUp: true,
      sessions: [session('claude', FOLDER), session('claude', FOLDER)],
    });
    expect(result.state).toBe('no-entry');
    expect(result.remedy).toContain('agent-deck setup --client claude');
    expect(result.remedy).toContain('agent-deck use <deck>');
  });

  it('returns stale-conflicting-entry for Muse ahead of every other gate', () => {
    const result = classifyHostConnection({
      host: 'muse',
      folder: FOLDER,
      hasProjectEntry: true,
      hasGlobalEntry: true,
      folderTrusted: false,
      folderInRepository: false,
      hasStaleConflict: true,
      daemonUp: false,
      sessions: [],
    });
    expect(result.state).toBe('stale-conflicting-entry');
    expect(result.remedy).toContain('agent-deck setup --client muse');
  });

  it('returns folder-not-repository for a Muse project entry outside a repo', () => {
    const result = classifyHostConnection({
      host: 'muse',
      folder: FOLDER,
      hasProjectEntry: true,
      hasGlobalEntry: false,
      folderTrusted: true,
      folderInRepository: false,
      hasStaleConflict: false,
      daemonUp: true,
      sessions: [session('muse', FOLDER), session('muse', FOLDER)],
    });
    expect(result.state).toBe('folder-not-repository');
    expect(result.remedy).toContain('git init');
  });

  it('returns folder-not-trusted for a project entry in an untrusted folder', () => {
    for (const host of ['codex', 'claude', 'cursor', 'muse'] as const) {
      const result = classifyHostConnection({
        host,
        folder: FOLDER,
        hasProjectEntry: true,
        hasGlobalEntry: false,
        folderTrusted: false,
        folderInRepository: true,
        hasStaleConflict: false,
        daemonUp: true,
        sessions: [session(host, FOLDER), session(host, FOLDER)],
      });
      expect(result.state).toBe('folder-not-trusted');
      expect(result.remedy.length).toBeGreaterThan(0);
    }
  });

  it('skips the trust gate when only the global fallback exists', () => {
    const result = classifyHostConnection({
      host: 'codex',
      folder: FOLDER,
      hasProjectEntry: false,
      hasGlobalEntry: true,
      folderTrusted: false,
      folderInRepository: true,
      hasStaleConflict: false,
      daemonUp: false,
      sessions: [],
    });
    expect(result.state).toBe('entry-daemon-down');
  });

  it('returns entry-daemon-down when the daemon is down', () => {
    const result = classifyHostConnection({
      host: 'cursor',
      folder: FOLDER,
      hasProjectEntry: true,
      hasGlobalEntry: true,
      folderTrusted: true,
      folderInRepository: true,
      hasStaleConflict: false,
      daemonUp: false,
      sessions: [],
    });
    expect(result.state).toBe('entry-daemon-down');
    expect(result.remedy).toContain('agent-deck start');
  });

  it('returns entry-daemon-up-no-session when the daemon is up with no live session', () => {
    const result = classifyHostConnection({
      host: 'claude',
      folder: FOLDER,
      hasProjectEntry: true,
      hasGlobalEntry: false,
      folderTrusted: true,
      folderInRepository: true,
      hasStaleConflict: false,
      daemonUp: true,
      sessions: [],
    });
    expect(result.state).toBe('entry-daemon-up-no-session');
    expect(result.remedy).toContain('no live session was observed');
  });

  it('returns connected when the daemon is up with a live session', () => {
    const result = classifyHostConnection({
      host: 'muse',
      folder: FOLDER,
      hasProjectEntry: true,
      hasGlobalEntry: true,
      folderTrusted: true,
      folderInRepository: true,
      hasStaleConflict: false,
      daemonUp: true,
      sessions: [session('muse', FOLDER)],
    });
    expect(result.state).toBe('connected');
    expect(result.remedy).toContain('No action needed');
  });

  it('ignores live sessions from another folder or another host', () => {
    const otherHost: Record<HostId, HostId> = {
      codex: 'cursor',
      claude: 'codex',
      cursor: 'muse',
      muse: 'claude',
    };
    for (const host of ['codex', 'claude', 'cursor', 'muse'] as const) {
      const result = classifyHostConnection({
        host,
        folder: FOLDER,
        hasProjectEntry: true,
        hasGlobalEntry: true,
        folderTrusted: true,
        folderInRepository: true,
        hasStaleConflict: false,
        daemonUp: true,
        sessions: [
          session(host, OTHER_FOLDER),
          session(otherHost[host], FOLDER),
          { workspaceRoot: FOLDER, clientName: 'some-other-tool' },
          { workspaceRoot: FOLDER },
        ],
      });
      expect(result.state).toBe('entry-daemon-up-no-session');
    }
  });

  it('counts a folder-less session from the same host as connected', () => {
    for (const host of ['codex', 'claude', 'cursor', 'muse'] as const) {
      const result = classifyHostConnection({
        host,
        folder: FOLDER,
        hasProjectEntry: false,
        hasGlobalEntry: true,
        folderTrusted: true,
        folderInRepository: true,
        hasStaleConflict: false,
        daemonUp: true,
        sessions: [session(host)],
      });
      expect(result.state).toBe('connected');
    }
  });

  it('gives every host and state a one-line remedy', () => {
    for (const host of ['codex', 'claude', 'cursor', 'muse'] as const) {
      for (const state of [
        'no-entry',
        'entry-daemon-down',
        'entry-daemon-up-no-session',
        'connected',
        'folder-not-trusted',
        'folder-not-repository',
        'stale-conflicting-entry',
      ] as const) {
        const remedy = remedyFor(host, state);
        expect(remedy.length).toBeGreaterThan(0);
        expect(remedy).not.toContain('\n');
      }
    }
  });

  it('formats the state and remedy on one line', () => {
    const line = formatHostConnectionLine(
      classifyHostConnection({
        host: 'codex',
        folder: FOLDER,
        hasProjectEntry: true,
        hasGlobalEntry: false,
        folderTrusted: true,
        folderInRepository: true,
        hasStaleConflict: false,
        daemonUp: false,
        sessions: [],
      }),
    );
    expect(line).toContain('Codex connection: entry-daemon-down');
    expect(line).toContain('agent-deck start');
  });
});

describe('session attribution (NOT-574)', () => {
  it('hostIdForClientName maps MCP client names case-insensitively', () => {
    expect(hostIdForClientName('claude-code')).toBe('claude');
    expect(hostIdForClientName('Claude-Code 2.1.307')).toBe('claude');
    expect(hostIdForClientName('codex')).toBe('codex');
    expect(hostIdForClientName('Codex CLI')).toBe('codex');
    expect(hostIdForClientName('cursor')).toBe('cursor');
    expect(hostIdForClientName('Cursor')).toBe('cursor');
    expect(hostIdForClientName('muse')).toBe('muse');
    expect(hostIdForClientName('Muse')).toBe('muse');
  });

  it('hostIdForClientName maps unknown or absent names to no host', () => {
    expect(hostIdForClientName(undefined)).toBeUndefined();
    expect(hostIdForClientName('')).toBeUndefined();
    expect(hostIdForClientName('   ')).toBeUndefined();
    expect(hostIdForClientName('inspector')).toBeUndefined();
    expect(hostIdForClientName('vscode')).toBeUndefined();
  });

  it('sessionMatchesHostFolder compares folders canonically', () => {
    const resolved = fs.realpathSync(os.tmpdir());
    const unresolved = os.tmpdir();
    expect(
      sessionMatchesHostFolder({ workspaceRoot: unresolved, clientName: 'claude-code' }, 'claude', resolved),
    ).toBe(true);
    expect(
      sessionMatchesHostFolder({ workspaceRoot: resolved, clientName: 'claude-code' }, 'claude', unresolved),
    ).toBe(true);
    expect(
      sessionMatchesHostFolder(
        { workspaceRoot: path.join(resolved, 'definitely-not-here'), clientName: 'claude-code' },
        'claude',
        resolved,
      ),
    ).toBe(false);
  });

  it('sessionMatchesHostFolder counts folder-less same-host sessions only', () => {
    expect(sessionMatchesHostFolder({ clientName: 'cursor' }, 'cursor', FOLDER)).toBe(true);
    expect(
      sessionMatchesHostFolder({ workspaceRoot: '  ', clientName: 'cursor' }, 'cursor', FOLDER),
    ).toBe(true);
    expect(sessionMatchesHostFolder({ clientName: 'cursor' }, 'codex', FOLDER)).toBe(false);
    expect(sessionMatchesHostFolder({}, 'cursor', FOLDER)).toBe(false);
  });

  it('countMatchingSessions counts only this host and folder', () => {
    const sessions: HostLiveSession[] = [
      session('claude', FOLDER),
      session('claude', FOLDER),
      session('claude', OTHER_FOLDER),
      session('codex', FOLDER),
      { workspaceRoot: FOLDER, clientName: 'unknown-tool' },
    ];
    expect(countMatchingSessions(sessions, 'claude', FOLDER)).toBe(2);
    expect(countMatchingSessions(sessions, 'codex', FOLDER)).toBe(1);
    expect(countMatchingSessions(sessions, 'cursor', FOLDER)).toBe(0);
    expect(countMatchingSessions([], 'claude', FOLDER)).toBe(0);
  });
});

describe('config readers (NOT-574)', () => {
  it('codexTomlHasAgentDeckEntry matches sections, sub-tables, and dotted keys', () => {
    expect(codexTomlHasAgentDeckEntry('[mcp_servers.agent-deck]\nurl = "http://x/mcp"\n')).toBe(true);
    expect(
      codexTomlHasAgentDeckEntry('[mcp_servers.agent-deck.env]\nFOO = "1"\n'),
    ).toBe(true);
    expect(
      codexTomlHasAgentDeckEntry('[mcp_servers]\nagent-deck = { url = "http://x/mcp" }\n'),
    ).toBe(true);
    expect(codexTomlHasAgentDeckEntry('[mcp_servers.other]\nurl = "http://x/mcp"\n')).toBe(
      false,
    );
    expect(
      codexTomlHasAgentDeckEntry('[mcp_servers.agent-deck-env]\nurl = "http://x/mcp"\n'),
    ).toBe(false);
    expect(codexTomlHasAgentDeckEntry('')).toBe(false);
  });

  it('parseCodexTrustedProjects reads the projects trust table', () => {
    const toml = [
      '[projects."/a/b"]',
      'trust_level = "trusted"',
      '',
      "[projects.'/c/d']",
      'trust_level = "untrusted"',
      '',
      '[mcp_servers.agent-deck]',
      'url = "http://127.0.0.1:1110/mcp"',
      '',
    ].join('\n');
    expect(parseCodexTrustedProjects(toml)).toEqual(['/a/b']);
  });

  it('isCodexFolderTrusted matches the canonical path and trusted ancestors', () => {
    const folder = fs.realpathSync(os.tmpdir());
    const toml = `[projects."${folder}"]\ntrust_level = "trusted"\n`;
    expect(isCodexFolderTrusted(toml, folder)).toBe(true);
    expect(isCodexFolderTrusted(toml, path.join(folder, 'child'))).toBe(true);
    expect(isCodexFolderTrusted('', folder)).toBe(false);
    expect(
      isCodexFolderTrusted(`[projects."${folder}"]\ntrust_level = "untrusted"\n`, folder),
    ).toBe(false);
  });

  it('isCodexFolderTrusted canonicalizes trust entries before comparing', () => {
    // A trust entry recorded as /tmp/x must match /private/tmp/x on macOS.
    const recorded = os.tmpdir();
    const folder = fs.realpathSync(os.tmpdir());
    const toml = `[projects."${recorded}"]\ntrust_level = "trusted"\n`;
    expect(isCodexFolderTrusted(toml, folder)).toBe(true);
    expect(isCodexFolderTrusted(toml, recorded)).toBe(true);
  });

  it('cursorProjectSlug collapses non-alphanumeric runs', () => {
    expect(cursorProjectSlug('/Users/x/y')).toBe('Users-x-y');
    expect(cursorProjectSlug('/private/tmp/smoke')).toBe('private-tmp-smoke');
  });

  it('hasMuseStaleConflict matches only the mismatched stdio/HTTP pair', () => {
    expect(hasMuseStaleConflict(HTTP_ENTRY, STDIO_ENTRY)).toBe(true);
    expect(hasMuseStaleConflict(STDIO_ENTRY, HTTP_ENTRY)).toBe(true);
    expect(hasMuseStaleConflict(HTTP_ENTRY, HTTP_ENTRY)).toBe(false);
    expect(hasMuseStaleConflict(STDIO_ENTRY, STDIO_ENTRY)).toBe(false);
    expect(hasMuseStaleConflict(HTTP_ENTRY, undefined)).toBe(false);
    expect(hasMuseStaleConflict(undefined, undefined)).toBe(false);
  });

  it('isStdioAgentDeckEntry matches command entries and type stdio', () => {
    expect(isStdioAgentDeckEntry(STDIO_ENTRY)).toBe(true);
    expect(isStdioAgentDeckEntry({ type: 'stdio' })).toBe(true);
    expect(isStdioAgentDeckEntry(HTTP_ENTRY)).toBe(false);
    expect(isStdioAgentDeckEntry(undefined)).toBe(false);
  });

  it('readJsonAgentDeckEntry returns undefined for missing or unparsable files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-host-conn-'));
    try {
      expect(readJsonAgentDeckEntry(path.join(dir, 'missing.json'))).toBeUndefined();
      const bad = path.join(dir, 'bad.json');
      fs.writeFileSync(bad, 'not json');
      expect(readJsonAgentDeckEntry(bad)).toBeUndefined();
      const empty = path.join(dir, 'empty.json');
      writeJson(empty, { mcpServers: {} });
      expect(readJsonAgentDeckEntry(empty)).toBeUndefined();
      const full = path.join(dir, 'full.json');
      writeMcpJson(full, HTTP_ENTRY);
      expect(readJsonAgentDeckEntry(full)).toEqual(HTTP_ENTRY);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isInsideGitRepository finds .git here or above', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-host-conn-git-'));
    try {
      const child = path.join(root, 'child', 'grandchild');
      fs.mkdirSync(child, { recursive: true });
      expect(isInsideGitRepository(child)).toBe(false);
      fs.mkdirSync(path.join(root, '.git'));
      expect(isInsideGitRepository(child)).toBe(true);
      expect(isInsideGitRepository(root)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('canonicalFolder resolves symlinked tmp paths', () => {
    expect(canonicalFolder(os.tmpdir())).toBe(fs.realpathSync(os.tmpdir()));
  });
});

describe('inspectHostConnection fixtures (NOT-574)', () => {
  const tmpDirs: string[] = [];
  let savedCodexHome: string | undefined;
  let savedXdg: string | undefined;

  beforeEach(() => {
    savedCodexHome = process.env.CODEX_HOME;
    savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.CODEX_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = savedCodexHome;
    }
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRoots(): { home: string; workspace: string; codexHome: string; xdg: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-hc-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-hc-ws-'));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-hc-codex-'));
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-hc-xdg-'));
    tmpDirs.push(home, workspace, codexHome, xdg);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    return { home, workspace, codexHome, xdg };
  }

  function canonical(workspace: string): string {
    return fs.realpathSync(workspace);
  }

  function writeCodexProject(workspace: string): void {
    const file = path.join(workspace, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      ['[mcp_servers.agent-deck]', 'url = "http://127.0.0.1:1110/mcp"', `http_headers = { "x-agent-deck-workspace" = "${workspace}" }`, ''].join('\n'),
    );
  }

  function writeCodexUser(codexHome: string, workspace: string, trusted: boolean): void {
    const file = path.join(codexHome, 'config.toml');
    const trustBlock = trusted
      ? [`[projects."${canonical(workspace)}"]`, 'trust_level = "trusted"', '']
      : [];
    fs.writeFileSync(
      file,
      [...trustBlock, '[mcp_servers.agent-deck]', 'url = "http://127.0.0.1:1110/mcp"', ''].join('\n'),
    );
  }

  function writeClaudeProject(workspace: string): void {
    writeMcpJson(path.join(workspace, '.mcp.json'), HTTP_PROJECT_ENTRY(workspace));
  }

  function writeClaudeUser(home: string, workspace: string, approved: boolean): void {
    writeJson(path.join(home, '.claude.json'), {
      mcpServers: { 'agent-deck': HTTP_ENTRY },
      projects: approved
        ? { [canonical(workspace)]: { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['agent-deck'], disabledMcpjsonServers: [] } }
        : {},
    });
  }

  function writeCursorProject(workspace: string): void {
    const file = path.join(workspace, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeMcpJson(file, { url: 'http://127.0.0.1:1110/mcp', headers: { 'x-agent-deck-workspace': workspace } });
  }

  function writeCursorUser(home: string): void {
    const file = path.join(home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeMcpJson(file, { url: 'http://127.0.0.1:1110/mcp' });
  }

  function writeCursorApproval(home: string, workspace: string): void {
    const file = path.join(home, '.cursor', 'projects', cursorProjectSlug(workspace), 'mcp-approvals.json');
    writeJson(file, ['agent-deck-abc123hash']);
  }

  function writeMuseGlobal(xdg: string, entry: unknown): void {
    writeJson(path.join(xdg, 'muse', 'settings.json'), { mcpServers: { 'agent-deck': entry }, schema_version: 1 });
  }

  function writeMuseTrust(xdg: string, workspace: string): void {
    writeJson(path.join(xdg, 'muse', 'trust.json'), {
      schema_version: 1,
      projects: { [canonical(workspace)]: { decision: 'trusted' } },
    });
  }

  function makeGitRepo(workspace: string): void {
    fs.mkdirSync(path.join(workspace, '.git'));
  }

  describe('codex', () => {
    it('no-entry with no project or user entry', () => {
      const { workspace, codexHome, home } = makeRoots();
      const result = inspectHostConnection('codex', workspace, {
        home,
        codexHome,
        daemon: daemonConnected('codex', workspace),
      });
      expect(result.state).toBe('no-entry');
      expect(result.remedy).toContain('agent-deck setup --client codex');
    });

    it('folder-not-trusted for a project entry in an untrusted folder', () => {
      const { workspace, codexHome, home } = makeRoots();
      writeCodexProject(workspace);
      writeCodexUser(codexHome, workspace, false);
      const result = inspectHostConnection('codex', workspace, {
        home,
        codexHome,
        daemon: daemonConnected('codex', workspace),
      });
      expect(result.state).toBe('folder-not-trusted');
      expect(result.remedy).toContain('Trust this folder');
    });

    it('entry-daemon-down with a trusted entry and a stopped daemon', () => {
      const { workspace, codexHome, home } = makeRoots();
      writeCodexProject(workspace);
      writeCodexUser(codexHome, workspace, true);
      const result = inspectHostConnection('codex', workspace, {
        home,
        codexHome,
        daemon: DAEMON_DOWN,
      });
      expect(result.state).toBe('entry-daemon-down');
    });

    it('entry-daemon-up-no-session with no live session', () => {
      const { workspace, codexHome, home } = makeRoots();
      writeCodexProject(workspace);
      writeCodexUser(codexHome, workspace, true);
      const result = inspectHostConnection('codex', workspace, {
        home,
        codexHome,
        daemon: DAEMON_UP_NO_SESSION,
      });
      expect(result.state).toBe('entry-daemon-up-no-session');
    });

    it('connected with a trusted entry and a live session', () => {
      const { workspace, codexHome, home } = makeRoots();
      writeCodexProject(workspace);
      writeCodexUser(codexHome, workspace, true);
      const result = inspectHostConnection('codex', workspace, {
        home,
        codexHome,
        daemon: daemonConnected('codex', workspace),
      });
      expect(result.state).toBe('connected');
    });

    it('up-no-session when the only live sessions are elsewhere', () => {
      const { workspace, codexHome, home } = makeRoots();
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-hc-else-'));
      tmpDirs.push(elsewhere);
      writeCodexProject(workspace);
      writeCodexUser(codexHome, workspace, true);
      const result = inspectHostConnection('codex', workspace, {
        home,
        codexHome,
        daemon: {
          up: true,
          sessions: [session('codex', elsewhere), session('cursor', workspace)],
        },
      });
      expect(result.state).toBe('entry-daemon-up-no-session');
    });

    it('global-only entry skips trust and reports daemon state', () => {
      const { workspace, codexHome, home } = makeRoots();
      writeCodexUser(codexHome, workspace, false);
      const down = inspectHostConnection('codex', workspace, { home, codexHome, daemon: DAEMON_DOWN });
      expect(down.state).toBe('entry-daemon-down');
      const up = inspectHostConnection('codex', workspace, { home, codexHome, daemon: daemonConnected('codex', workspace) });
      expect(up.state).toBe('connected');
    });
  });

  describe('claude', () => {
    it('no-entry with no project or user entry', () => {
      const { workspace, home } = makeRoots();
      const result = inspectHostConnection('claude', workspace, { home, daemon: daemonConnected('claude', workspace) });
      expect(result.state).toBe('no-entry');
    });

    it('folder-not-trusted for an unapproved project server', () => {
      const { workspace, home } = makeRoots();
      writeClaudeProject(workspace);
      writeClaudeUser(home, workspace, false);
      expect(isClaudeProjectApproved(home, workspace)).toBe(false);
      const result = inspectHostConnection('claude', workspace, { home, daemon: daemonConnected('claude', workspace) });
      expect(result.state).toBe('folder-not-trusted');
      expect(result.remedy).toContain('Approve the project agent-deck server');
    });

    it('entry-daemon-down with an approved entry and a stopped daemon', () => {
      const { workspace, home } = makeRoots();
      writeClaudeProject(workspace);
      writeClaudeUser(home, workspace, true);
      expect(isClaudeProjectApproved(home, workspace)).toBe(true);
      const result = inspectHostConnection('claude', workspace, { home, daemon: DAEMON_DOWN });
      expect(result.state).toBe('entry-daemon-down');
    });

    it('entry-daemon-up-no-session with no live session', () => {
      const { workspace, home } = makeRoots();
      writeClaudeProject(workspace);
      writeClaudeUser(home, workspace, true);
      const result = inspectHostConnection('claude', workspace, { home, daemon: DAEMON_UP_NO_SESSION });
      expect(result.state).toBe('entry-daemon-up-no-session');
    });

    it('connected with an approved entry and a live session', () => {
      const { workspace, home } = makeRoots();
      writeClaudeProject(workspace);
      writeClaudeUser(home, workspace, true);
      const result = inspectHostConnection('claude', workspace, { home, daemon: daemonConnected('claude', workspace) });
      expect(result.state).toBe('connected');
    });
  });

  describe('cursor', () => {
    it('no-entry with no project or global entry', () => {
      const { workspace, home } = makeRoots();
      const result = inspectHostConnection('cursor', workspace, { home, daemon: daemonConnected('cursor', workspace) });
      expect(result.state).toBe('no-entry');
    });

    it('folder-not-trusted for an unapproved project server', () => {
      const { workspace, home } = makeRoots();
      writeCursorProject(workspace);
      writeCursorUser(home);
      expect(isCursorProjectApproved(home, workspace)).toBe(false);
      const result = inspectHostConnection('cursor', workspace, { home, daemon: daemonConnected('cursor', workspace) });
      expect(result.state).toBe('folder-not-trusted');
      expect(result.remedy).toContain('Approve the project agent-deck server');
    });

    it('entry-daemon-down with an approved entry and a stopped daemon', () => {
      const { workspace, home } = makeRoots();
      writeCursorProject(workspace);
      writeCursorUser(home);
      writeCursorApproval(home, workspace);
      expect(isCursorProjectApproved(home, workspace)).toBe(true);
      const result = inspectHostConnection('cursor', workspace, { home, daemon: DAEMON_DOWN });
      expect(result.state).toBe('entry-daemon-down');
    });

    it('entry-daemon-up-no-session with no live session', () => {
      const { workspace, home } = makeRoots();
      writeCursorProject(workspace);
      writeCursorUser(home);
      writeCursorApproval(home, workspace);
      const result = inspectHostConnection('cursor', workspace, { home, daemon: DAEMON_UP_NO_SESSION });
      expect(result.state).toBe('entry-daemon-up-no-session');
    });

    it('connected with an approved entry and a live session', () => {
      const { workspace, home } = makeRoots();
      writeCursorProject(workspace);
      writeCursorUser(home);
      writeCursorApproval(home, workspace);
      const result = inspectHostConnection('cursor', workspace, { home, daemon: daemonConnected('cursor', workspace) });
      expect(result.state).toBe('connected');
    });
  });

  describe('muse', () => {
    it('no-entry with no project or user entry', () => {
      const { workspace, home, xdg } = makeRoots();
      const result = inspectHostConnection('muse', workspace, { home, xdgConfigHome: xdg, daemon: daemonConnected('muse', workspace) });
      expect(result.state).toBe('no-entry');
    });

    it('stale-conflicting-entry for a stdio user entry against an HTTP project entry', () => {
      const { workspace, home, xdg } = makeRoots();
      makeGitRepo(workspace);
      writeMcpJson(path.join(workspace, '.mcp.json'), HTTP_PROJECT_ENTRY(workspace));
      writeMuseGlobal(xdg, STDIO_ENTRY);
      writeMuseTrust(xdg, workspace);
      const result = inspectHostConnection('muse', workspace, { home, xdgConfigHome: xdg, daemon: daemonConnected('muse', workspace) });
      expect(result.state).toBe('stale-conflicting-entry');
      expect(result.remedy).toContain('rewrite both entries to HTTP');
    });

    it('folder-not-repository for a project entry outside a git repo', () => {
      const { workspace, home, xdg } = makeRoots();
      writeMcpJson(path.join(workspace, '.mcp.json'), HTTP_PROJECT_ENTRY(workspace));
      writeMuseGlobal(xdg, HTTP_ENTRY);
      writeMuseTrust(xdg, workspace);
      expect(isInsideGitRepository(workspace)).toBe(false);
      const result = inspectHostConnection('muse', workspace, { home, xdgConfigHome: xdg, daemon: daemonConnected('muse', workspace) });
      expect(result.state).toBe('folder-not-repository');
      expect(result.remedy).toContain('git init');
    });

    it('folder-not-trusted for a project entry in an untrusted folder', () => {
      const { workspace, home, xdg } = makeRoots();
      makeGitRepo(workspace);
      writeMcpJson(path.join(workspace, '.mcp.json'), HTTP_PROJECT_ENTRY(workspace));
      writeMuseGlobal(xdg, HTTP_ENTRY);
      expect(isMuseFolderTrusted(home, workspace, xdg)).toBe(false);
      const result = inspectHostConnection('muse', workspace, { home, xdgConfigHome: xdg, daemon: daemonConnected('muse', workspace) });
      expect(result.state).toBe('folder-not-trusted');
      expect(result.remedy).toContain('Trust this folder');
    });

    it('entry-daemon-down with a trusted entry and a stopped daemon', () => {
      const { workspace, home, xdg } = makeRoots();
      makeGitRepo(workspace);
      writeMcpJson(path.join(workspace, '.mcp.json'), HTTP_PROJECT_ENTRY(workspace));
      writeMuseGlobal(xdg, HTTP_ENTRY);
      writeMuseTrust(xdg, workspace);
      const result = inspectHostConnection('muse', workspace, { home, xdgConfigHome: xdg, daemon: DAEMON_DOWN });
      expect(result.state).toBe('entry-daemon-down');
    });

    it('entry-daemon-up-no-session with no live session', () => {
      const { workspace, home, xdg } = makeRoots();
      makeGitRepo(workspace);
      writeMcpJson(path.join(workspace, '.mcp.json'), HTTP_PROJECT_ENTRY(workspace));
      writeMuseGlobal(xdg, HTTP_ENTRY);
      writeMuseTrust(xdg, workspace);
      const result = inspectHostConnection('muse', workspace, { home, xdgConfigHome: xdg, daemon: DAEMON_UP_NO_SESSION });
      expect(result.state).toBe('entry-daemon-up-no-session');
    });

    it('connected with a trusted entry and a live session', () => {
      const { workspace, home, xdg } = makeRoots();
      makeGitRepo(workspace);
      writeMcpJson(path.join(workspace, '.mcp.json'), HTTP_PROJECT_ENTRY(workspace));
      writeMuseGlobal(xdg, HTTP_ENTRY);
      writeMuseTrust(xdg, workspace);
      const result = inspectHostConnection('muse', workspace, { home, xdgConfigHome: xdg, daemon: daemonConnected('muse', workspace) });
      expect(result.state).toBe('connected');
    });
  });

  describe('inspectAllHostConnections', () => {
    it('reports all four hosts and never writes', () => {
      const { workspace, home, codexHome, xdg } = makeRoots();
      const before = fs.readdirSync(home);
      const results = inspectAllHostConnections(workspace, {
        home,
        codexHome,
        xdgConfigHome: xdg,
        daemon: DAEMON_DOWN,
      });
      expect(results.map((r) => r.host)).toEqual(['codex', 'claude', 'cursor', 'muse']);
      expect(results.every((r) => r.state === 'no-entry')).toBe(true);
      expect(fs.readdirSync(home)).toEqual(before);
    });
  });
});
