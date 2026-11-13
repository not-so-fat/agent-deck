import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  codexTomlHasAgentDeckEntry,
  isHttpAgentDeckEntry,
  readDefaultDeck,
} from './mcp-config';
import { readUseManifest } from './playbook-stubs';

/**
 * Pure-MCP host connection classifier (NOT-574).
 *
 * Per host and folder, reports the real connection state instead of
 * install state: whether an Agent Deck entry exists, whether the daemon
 * is up, whether a live session for this host and folder was observed,
 * and — for the hosts that gate project config — whether the folder is
 * trusted (and, for Muse, whether the folder is inside a git repository
 * and whether a stale same-name stdio entry conflicts with the HTTP
 * entry).
 *
 * Daemon health is `up` (`backendUp && mcpUp` from `probeAgentDeck`)
 * plus the live-session list from the read-only
 * `GET /api/scope/bindings` (same source as the menu bar). A session
 * counts toward a host and folder only when its MCP `clientName`
 * identifies that host and its `workspaceRoot` is this folder or
 * absent (folder-less sessions come from global headerless entries and
 * cannot contradict any folder). A session from another folder or
 * another host never reads as connected.
 */

export type HostId = 'codex' | 'claude' | 'cursor' | 'muse';

export type HostConnectionState =
  | 'no-entry'
  | 'entry-daemon-down'
  | 'entry-daemon-up-no-session'
  | 'connected'
  | 'folder-not-trusted'
  | 'folder-not-repository'
  | 'stale-conflicting-entry';

/**
 * Live MCP session as `GET /api/scope/bindings` reports it — the subset
 * the classifier attributes. Both fields are optional on the wire:
 * `clientName` is the MCP `clientInfo.name` the host sent at
 * initialize, and `workspaceRoot` is absent for folder-less sessions
 * (global headerless entries that never bound a folder).
 */
export interface HostLiveSession {
  workspaceRoot?: string;
  clientName?: string;
}

export interface DaemonHealth {
  up: boolean;
  sessions: HostLiveSession[];
}

export interface HostConnectionInput {
  host: HostId;
  /** Folder the connection state is reported for (session attribution). */
  folder: string;
  hasProjectEntry: boolean;
  hasGlobalEntry: boolean;
  /** Meaningful only when a project entry exists; otherwise ignored. */
  folderTrusted: boolean;
  /** Muse only; other hosts pass true. */
  folderInRepository: boolean;
  /** Muse only; other hosts pass false. */
  hasStaleConflict: boolean;
  daemonUp: boolean;
  /** Live sessions from `/api/scope/bindings`, attributed per host and folder. */
  sessions: HostLiveSession[];
}

export interface HostConnectionResult {
  host: HostId;
  state: HostConnectionState;
  remedy: string;
  detail: string;
}

const HOST_LABELS: Record<HostId, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  cursor: 'Cursor',
  muse: 'Muse',
};

function entryDetail(input: HostConnectionInput): string {
  if (input.hasProjectEntry && input.hasGlobalEntry) {
    return 'project + global entries';
  }
  if (input.hasProjectEntry) {
    return 'project entry';
  }
  return 'global entry';
}

/**
 * MCP `clientInfo.name` keywords per host, matched case-insensitively
 * as substrings (`claude-code` → claude, `codex`/`codex-cli` → codex).
 * An unknown or absent name attributes to no host — a session from a
 * client doctor does not know (another tool, an inspector) must never
 * light up a host it did not come from.
 */
const CLIENT_NAME_KEYWORDS: Record<HostId, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  cursor: ['cursor'],
  muse: ['muse'],
};

const CLIENT_NAME_CHECK_ORDER: HostId[] = ['claude', 'codex', 'cursor', 'muse'];

/** Host a live session's `clientName` identifies, or undefined when unknown. */
export function hostIdForClientName(clientName: string | undefined): HostId | undefined {
  const name = clientName?.trim().toLowerCase();
  if (!name) {
    return undefined;
  }
  for (const host of CLIENT_NAME_CHECK_ORDER) {
    if (CLIENT_NAME_KEYWORDS[host].some((keyword) => name.includes(keyword))) {
      return host;
    }
  }
  return undefined;
}

/**
 * True when a live session belongs to this host and folder: the
 * `clientName` must identify the host, and the `workspaceRoot` must be
 * this folder (canonically compared, so `/tmp/x` matches
 * `/private/tmp/x`) or absent — a folder-less session comes from a
 * global headerless entry and cannot contradict any folder.
 */
export function sessionMatchesHostFolder(
  session: HostLiveSession,
  host: HostId,
  folder: string,
): boolean {
  if (hostIdForClientName(session.clientName) !== host) {
    return false;
  }
  const root = session.workspaceRoot?.trim();
  if (!root) {
    return true;
  }
  return canonicalFolder(root) === canonicalFolder(folder);
}

/** Live sessions attributed to this host and folder. */
export function countMatchingSessions(
  sessions: HostLiveSession[],
  host: HostId,
  folder: string,
): number {
  return sessions.filter((session) => sessionMatchesHostFolder(session, host, folder)).length;
}

/**
 * Pure classifier: the Muse stale-conflict and repository gates first
 * (they block even with the daemon up), then daemon reachability, then
 * the trust gate, then the attributed live-session count. Daemon-down
 * takes precedence over folder-not-trusted for every host: a trust
 * remedy cannot help while the daemon is stopped. Trust and repository
 * gates apply only when a project entry exists — the global headerless
 * fallback needs neither.
 */
export function classifyHostConnection(input: HostConnectionInput): HostConnectionResult {
  const { host } = input;
  if (!input.hasProjectEntry && !input.hasGlobalEntry) {
    return {
      host,
      state: 'no-entry',
      remedy: remedyFor(host, 'no-entry'),
      detail: 'no project or global entry',
    };
  }
  if (host === 'muse' && input.hasStaleConflict) {
    return {
      host,
      state: 'stale-conflicting-entry',
      remedy: remedyFor(host, 'stale-conflicting-entry'),
      detail: 'project and global entries conflict',
    };
  }
  if (host === 'muse' && input.hasProjectEntry && !input.folderInRepository) {
    return {
      host,
      state: 'folder-not-repository',
      remedy: remedyFor(host, 'folder-not-repository'),
      detail: 'project entry present',
    };
  }
  if (!input.daemonUp) {
    return {
      host,
      state: 'entry-daemon-down',
      remedy: remedyFor(host, 'entry-daemon-down'),
      detail: entryDetail(input),
    };
  }
  if (input.hasProjectEntry && !input.folderTrusted) {
    return {
      host,
      state: 'folder-not-trusted',
      remedy: remedyFor(host, 'folder-not-trusted'),
      detail: 'project entry present',
    };
  }
  const matchingSessions = countMatchingSessions(input.sessions, host, input.folder);
  if (matchingSessions > 0) {
    return {
      host,
      state: 'connected',
      remedy: remedyFor(host, 'connected'),
      detail: `${entryDetail(input)}, ${matchingSessions} live session${matchingSessions === 1 ? '' : 's'}`,
    };
  }
  return {
    host,
    state: 'entry-daemon-up-no-session',
    remedy: remedyFor(host, 'entry-daemon-up-no-session'),
    detail: entryDetail(input),
  };
}

/** One-line remedy per host and state. */
export function remedyFor(host: HostId, state: HostConnectionState): string {
  switch (state) {
    case 'no-entry':
      switch (host) {
        case 'codex':
          return 'Run `agent-deck setup --client codex` then `agent-deck use <deck>` in this folder, then start a new Codex task.';
        case 'claude':
          return 'Run `agent-deck setup --client claude` then `agent-deck use <deck>` in this folder, approve the entry, then reload MCP.';
        case 'cursor':
          return 'Run `agent-deck setup --client cursor` then `agent-deck use <deck>` in this folder, approve the server, then reload MCP.';
        case 'muse':
          return 'Run `agent-deck setup --client muse` then `agent-deck use <deck>` in this folder (inside a git repo), trust the folder, then reload MCP.';
      }
      break;
    case 'entry-daemon-down':
      switch (host) {
        case 'codex':
          return 'Start the daemon with `agent-deck start`, then start a new Codex task so MCP reloads.';
        case 'claude':
          return 'Start the daemon with `agent-deck start`, then reload MCP (restart Claude Code).';
        case 'cursor':
          return 'Start the daemon with `agent-deck start`, then reload MCP in Cursor.';
        case 'muse':
          return 'Start the daemon with `agent-deck start`, then reload MCP (restart Muse).';
      }
      break;
    case 'entry-daemon-up-no-session':
      switch (host) {
        case 'codex':
          return 'Reload MCP in Codex (start a new task) — daemon is up but no live session was observed.';
        case 'claude':
          return 'Reload MCP in Claude Code (restart or reload) — daemon is up but no live session was observed.';
        case 'cursor':
          return 'Reload MCP in Cursor — daemon is up but no live session was observed.';
        case 'muse':
          return 'Reload MCP in Muse (restart Muse) — daemon is up but no live session was observed.';
      }
      break;
    case 'connected':
      return 'No action needed — live session observed.';
    case 'folder-not-trusted':
      switch (host) {
        case 'codex':
          return 'Trust this folder in Codex (open it and accept trust so the user config records it), then start a new task.';
        case 'claude':
          return 'Approve the project agent-deck server (open `claude` in this folder and approve), then reload MCP.';
        case 'cursor':
          return 'Approve the project agent-deck server in Cursor, then reload MCP.';
        case 'muse':
          return 'Trust this folder in Muse, then reload MCP (restart Muse).';
      }
      break;
    case 'folder-not-repository':
      return 'Run `git init` (or move into a git repository), trust the folder, then reload MCP.';
    case 'stale-conflicting-entry':
      return 'Run `agent-deck setup --client muse` and `agent-deck use <deck>` to rewrite both entries to HTTP, then reload MCP.';
  }
}

export function formatHostConnectionLine(result: HostConnectionResult): string {
  return `${HOST_LABELS[result.host]} connection: ${result.state} (${result.detail}). Remedy: ${result.remedy}`;
}

/** Canonical folder for trust comparisons (`/tmp` vs `/private/tmp` on macOS). */
export function canonicalFolder(folder: string): string {
  try {
    return fs.realpathSync(path.resolve(folder));
  } catch {
    return path.resolve(folder);
  }
}

/** This folder plus every ancestor up to the filesystem root. */
function folderAndAncestors(canonical: string): string[] {
  const chain: string[] = [canonical];
  let current = canonical;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      return chain;
    }
    chain.push(parent);
    current = parent;
  }
}

/**
 * Raw `agent-deck` entry from a JSON MCP config, or undefined when the
 * file is missing, unparsable, or holds no such key. Any defined object
 * counts as an entry — HTTP, legacy launcher, or custom — since only
 * presence gates the classifier; shape matters solely for the Muse
 * stale-conflict check.
 */
export function readJsonAgentDeckEntry(configPath: string): unknown {
  let parsed: unknown;
  try {
    if (!fs.existsSync(configPath)) {
      return undefined;
    }
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return undefined;
  }
  const entry = (servers as Record<string, unknown>)['agent-deck'];
  return entry === undefined ? undefined : entry;
}

/** True for a stdio entry: an explicit command, or `type: 'stdio'`. */
export function isStdioAgentDeckEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return typeof record.command === 'string' || record.type === 'stdio';
}

/**
 * Muse merges a same-name project entry with the user entry field by
 * field, so a stdio entry on one side and an HTTP entry on the other
 * rejects the server as `invalid_transport_combination`. True only for
 * that mismatched pair — a single legacy entry still connects.
 */
export function hasMuseStaleConflict(projectEntry: unknown, globalEntry: unknown): boolean {
  if (projectEntry === undefined || globalEntry === undefined) {
    return false;
  }
  const projectHttp = isHttpAgentDeckEntry(projectEntry);
  const globalHttp = isHttpAgentDeckEntry(globalEntry);
  const projectStdio = isStdioAgentDeckEntry(projectEntry);
  const globalStdio = isStdioAgentDeckEntry(globalEntry);
  return (projectHttp && globalStdio) || (projectStdio && globalHttp);
}

/** True when `folder` sits inside a git working tree (`.git` here or above). */
export function isInsideGitRepository(folder: string): boolean {
  for (const candidate of folderAndAncestors(path.resolve(folder))) {
    try {
      if (fs.existsSync(path.join(candidate, '.git'))) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

const CODEX_PROJECTS_HEADER_RE =
  /^\s*\[\s*projects\s*\.\s*("([^"]+)"|'([^']+)'|([^\]\s]+))\s*\]\s*(?:#.*)?$/;
const CODEX_TRUST_LEVEL_RE = /^\s*trust_level\s*=\s*("trusted"|'trusted'|trusted)\s*(?:#.*)?$/;

function isTomlHeader(line: string): boolean {
  return line.trimStart().startsWith('[');
}

/** Every `[projects."<path>"]` path whose body sets `trust_level = "trusted"`. */
export function parseCodexTrustedProjects(userToml: string): string[] {
  const trusted: string[] = [];
  const lines = userToml.split('\n');
  let current: string | null = null;
  let currentTrusted = false;
  const flush = () => {
    if (current !== null && currentTrusted) {
      trusted.push(current);
    }
    current = null;
    currentTrusted = false;
  };
  for (const line of lines) {
    if (isTomlHeader(line)) {
      flush();
      const match = CODEX_PROJECTS_HEADER_RE.exec(line);
      if (match) {
        current = match[2] ?? match[3] ?? match[4] ?? null;
      }
      continue;
    }
    if (current !== null && CODEX_TRUST_LEVEL_RE.test(line)) {
      currentTrusted = true;
    }
  }
  flush();
  return trusted;
}

/**
 * Codex trusts a folder only via the user `config.toml` projects table —
 * a `-c` override is not enough. A trusted ancestor covers its children.
 */
export function isCodexFolderTrusted(userToml: string, folder: string): boolean {
  const trusted = new Set(parseCodexTrustedProjects(userToml).map((p) => canonicalFolder(p)));
  return folderAndAncestors(canonicalFolder(folder)).some((candidate) => trusted.has(candidate));
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function claudeEnableAllProjectMcpServers(home: string, folder: string): boolean {
  const candidates = [
    path.join(home, '.claude', 'settings.json'),
    path.join(folder, '.claude', 'settings.json'),
    path.join(folder, '.claude', 'settings.local.json'),
  ];
  for (const file of candidates) {
    if (readJsonObject(file)?.enableAllProjectMcpServers === true) {
      return true;
    }
  }
  return readJsonObject(path.join(home, '.claude.json'))?.enableAllProjectMcpServers === true;
}

/**
 * Claude approves a project `.mcp.json` server per folder: the server
 * name lands in `~/.claude.json` projects[<folder>].enabledMcpjsonServers
 * once approved. `enableAllProjectMcpServers` in user or project
 * settings auto-approves. A folder whose trust dialog was never accepted
 * (`hasTrustDialogAccepted === false`) is not trusted.
 */
export function isClaudeProjectApproved(home: string, folder: string): boolean {
  if (claudeEnableAllProjectMcpServers(home, folder)) {
    return true;
  }
  const claudeJson = readJsonObject(path.join(home, '.claude.json'));
  const projects = claudeJson?.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
    return false;
  }
  const records = projects as Record<string, unknown>;
  const keys = [canonicalFolder(folder), path.resolve(folder)];
  for (const key of keys) {
    const record = records[key];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      continue;
    }
    const typed = record as Record<string, unknown>;
    if (typed.hasTrustDialogAccepted === false) {
      return false;
    }
    const enabled = typed.enabledMcpjsonServers;
    if (Array.isArray(enabled) && enabled.includes('agent-deck')) {
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Cursor's per-folder approval slug: the canonical path with every run
 * of non-alphanumeric characters collapsed to one `-`, trimmed. E.g.
 * `/Users/x/y` → `Users-x-y`, `/private/tmp/smoke` → `private-tmp-smoke`.
 */
export function cursorProjectSlug(folder: string): string {
  return canonicalFolder(folder)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Cursor approves a project server per folder in
 * `~/.cursor/projects/<slug>/mcp-approvals.json`, a JSON array holding
 * `agent-deck-<hash>` once approved. Any `agent-deck`-prefixed entry
 * counts — the hash suffix is Cursor-internal.
 */
export function isCursorProjectApproved(home: string, folder: string): boolean {
  const approvalsPath = path.join(home, '.cursor', 'projects', cursorProjectSlug(folder), 'mcp-approvals.json');
  try {
    if (!fs.existsSync(approvalsPath)) {
      return false;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(approvalsPath, 'utf8'));
    return (
      Array.isArray(parsed) &&
      parsed.some((value) => typeof value === 'string' && value.startsWith('agent-deck'))
    );
  } catch {
    return false;
  }
}

function museConfigDir(home: string, xdgConfigHome?: string): string {
  const xdg = xdgConfigHome ?? process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? xdg : path.join(home, '.config');
}

export function museTrustPath(home: string, xdgConfigHome?: string): string {
  return path.join(museConfigDir(home, xdgConfigHome), 'muse', 'trust.json');
}

export function museGlobalSettingsPath(home: string, xdgConfigHome?: string): string {
  return path.join(museConfigDir(home, xdgConfigHome), 'muse', 'settings.json');
}

/**
 * Muse trusts a folder via `trust.json` projects[<canonical>].decision —
 * a trusted ancestor covers its children. Canonical paths only:
 * `/private/tmp/...`, never `/tmp/...`.
 */
export function isMuseFolderTrusted(home: string, folder: string, xdgConfigHome?: string): boolean {
  const trust = readJsonObject(museTrustPath(home, xdgConfigHome));
  const projects = trust?.projects;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) {
    return false;
  }
  const records = projects as Record<string, unknown>;
  return folderAndAncestors(canonicalFolder(folder)).some((candidate) => {
    const record = records[candidate];
    return (
      !!record &&
      typeof record === 'object' &&
      !Array.isArray(record) &&
      (record as Record<string, unknown>).decision === 'trusted'
    );
  });
}

export interface InspectHostConnectionOptions {
  home?: string;
  /** Overrides $XDG_CONFIG_HOME for the Muse paths (tests). */
  xdgConfigHome?: string;
  /** Overrides $CODEX_HOME for the Codex user config (tests). */
  codexHome?: string;
  daemon: DaemonHealth;
}

function codexUserConfigPath(home: string, codexHome?: string): string {
  const resolved = codexHome ?? process.env.CODEX_HOME?.trim() ?? path.join(home, '.codex');
  return path.join(resolved || path.join(home, '.codex'), 'config.toml');
}

function readTextOrEmpty(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Read-only inspection for one host and folder: config presence from
 * the host's own files, trust/approval from the host's own store, repo
 * membership for Muse, and the caller-supplied daemon health. Never
 * writes and never launches a host CLI.
 */
export function inspectHostConnection(
  host: HostId,
  folder: string,
  options: InspectHostConnectionOptions,
): HostConnectionResult {
  const home = options.home ?? os.homedir();
  const resolvedFolder = path.resolve(folder);
  const { daemon } = options;

  if (host === 'codex') {
    const projectText = readTextOrEmpty(path.join(resolvedFolder, '.codex', 'config.toml'));
    const userText = readTextOrEmpty(codexUserConfigPath(home, options.codexHome));
    const hasProjectEntry = codexTomlHasAgentDeckEntry(projectText);
    const hasGlobalEntry = codexTomlHasAgentDeckEntry(userText);
    return classifyHostConnection({
      host,
      folder: resolvedFolder,
      hasProjectEntry,
      hasGlobalEntry,
      folderTrusted: hasProjectEntry ? isCodexFolderTrusted(userText, resolvedFolder) : true,
      folderInRepository: true,
      hasStaleConflict: false,
      daemonUp: daemon.up,
      sessions: daemon.sessions,
    });
  }

  if (host === 'claude') {
    const projectEntry = readJsonAgentDeckEntry(path.join(resolvedFolder, '.mcp.json'));
    const globalEntry = readJsonAgentDeckEntry(path.join(home, '.claude.json'));
    const hasProjectEntry = projectEntry !== undefined;
    return classifyHostConnection({
      host,
      folder: resolvedFolder,
      hasProjectEntry,
      hasGlobalEntry: globalEntry !== undefined,
      folderTrusted: hasProjectEntry ? isClaudeProjectApproved(home, resolvedFolder) : true,
      folderInRepository: true,
      hasStaleConflict: false,
      daemonUp: daemon.up,
      sessions: daemon.sessions,
    });
  }

  if (host === 'cursor') {
    const projectEntry = readJsonAgentDeckEntry(path.join(resolvedFolder, '.cursor', 'mcp.json'));
    const globalEntry = readJsonAgentDeckEntry(path.join(home, '.cursor', 'mcp.json'));
    const hasProjectEntry = projectEntry !== undefined;
    return classifyHostConnection({
      host,
      folder: resolvedFolder,
      hasProjectEntry,
      hasGlobalEntry: globalEntry !== undefined,
      folderTrusted: hasProjectEntry ? isCursorProjectApproved(home, resolvedFolder) : true,
      folderInRepository: true,
      hasStaleConflict: false,
      daemonUp: daemon.up,
      sessions: daemon.sessions,
    });
  }

  const projectEntry = readJsonAgentDeckEntry(path.join(resolvedFolder, '.mcp.json'));
  const globalEntry = readJsonAgentDeckEntry(museGlobalSettingsPath(home, options.xdgConfigHome));
  const hasProjectEntry = projectEntry !== undefined;
  return classifyHostConnection({
    host,
    folder: resolvedFolder,
    hasProjectEntry,
    hasGlobalEntry: globalEntry !== undefined,
    folderTrusted: hasProjectEntry
      ? isMuseFolderTrusted(home, resolvedFolder, options.xdgConfigHome)
      : true,
    folderInRepository: hasProjectEntry ? isInsideGitRepository(resolvedFolder) : true,
    hasStaleConflict: hasMuseStaleConflict(projectEntry, globalEntry),
    daemonUp: daemon.up,
    sessions: daemon.sessions,
  });
}

/** Inspect all four pure-MCP hosts for one folder (doctor order). */
export function inspectAllHostConnections(
  folder: string,
  options: InspectHostConnectionOptions,
): HostConnectionResult[] {
  const hosts: HostId[] = ['codex', 'claude', 'cursor', 'muse'];
  return hosts.map((host) => inspectHostConnection(host, folder, options));
}

/**
 * Which deck source a new session in a folder would use (NOT-602).
 *
 * Same strict precedence the daemon resolves in `resolveHeaderDeck`
 * (`packages/backend/src/mcp-server.ts`): an explicit launch deck
 * header wins, else the folder assignment, else the user default deck,
 * else the session lands unassigned (`none`). The assignment read is
 * the same v3-only `readUseManifest` the daemon uses, so a legacy v1
 * or grant-based v2 `use.json` does not count as an assignment here
 * either — a folder carrying only one is effectively unbound for a new
 * headerless session.
 */
export type DeckSourceKind = 'launch-header' | 'folder-assignment' | 'default-deck' | 'none';

export interface DeckSourceDeck {
  deckId: string;
  deckName?: string;
}

export interface DeckSourceInput {
  /** Explicit launch deck (`x-agent-deck-deck-id`) the new session would send, if known. */
  launchDeck?: DeckSourceDeck | null;
  /** v3 folder assignment (`<folder>/.agent-deck/use.json`), if present. */
  assignment?: DeckSourceDeck | null;
  /** User default deck (`$AGENT_DECK_HOME/default-deck.json`), if set. */
  defaultDeck?: DeckSourceDeck | null;
}

export interface DeckSourceResult {
  source: DeckSourceKind;
  deck?: DeckSourceDeck;
}

/** A deck ref counts only with a non-blank id, like the daemon's `?.trim() || undefined`. */
function normalizeDeckRef(ref: DeckSourceDeck | null | undefined): DeckSourceDeck | undefined {
  const deckId = ref?.deckId?.trim();
  if (!deckId) {
    return undefined;
  }
  const deckName = ref?.deckName?.trim();
  return deckName ? { deckId, deckName } : { deckId };
}

/** Pure precedence: launch header, then folder assignment, then default deck, then none. */
export function resolveDeckSource(input: DeckSourceInput): DeckSourceResult {
  const launchDeck = normalizeDeckRef(input.launchDeck);
  if (launchDeck) {
    return { source: 'launch-header', deck: launchDeck };
  }
  const assignment = normalizeDeckRef(input.assignment);
  if (assignment) {
    return { source: 'folder-assignment', deck: assignment };
  }
  const defaultDeck = normalizeDeckRef(input.defaultDeck);
  if (defaultDeck) {
    return { source: 'default-deck', deck: defaultDeck };
  }
  return { source: 'none' };
}

/**
 * Read-only deck-source inspection for one folder: the v3 assignment on
 * disk plus the user default deck through the pure precedence above. A
 * new interactive session sends no deck header, so doctor never reports
 * `launch-header` — the branch exists so the precedence stays complete
 * and unit-testable.
 */
export function inspectFolderDeckSource(folder: string): DeckSourceResult {
  const assignment = readUseManifest(folder);
  const defaultDeck = readDefaultDeck();
  return resolveDeckSource({
    assignment: assignment ? { deckId: assignment.deckId, deckName: assignment.deckName } : null,
    defaultDeck: defaultDeck ? { deckId: defaultDeck.deckId, deckName: defaultDeck.deckName } : null,
  });
}

const DECK_SOURCE_LABELS: Record<DeckSourceKind, string> = {
  'launch-header': 'launch header',
  'folder-assignment': 'folder assignment',
  'default-deck': 'default deck',
  none: 'none',
};

export function formatDeckSourceLine(resolved: DeckSourceResult): string {
  const label = DECK_SOURCE_LABELS[resolved.source];
  const name = resolved.deck?.deckName?.trim() || resolved.deck?.deckId?.trim();
  if (resolved.source === 'none' || !name) {
    return 'Deck source: none (no folder assignment, no default deck). Remedy: run `agent-deck default <deck>` to set a default deck.';
  }
  return `Deck source: ${label} (${name})`;
}
