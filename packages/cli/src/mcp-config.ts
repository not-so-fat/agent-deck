import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizeJsonText } from './strip-ansi';

/** Shared recovery sentence for Cursor MCP diagnostics and docs (NOT-50). */
export const CURSOR_MCP_RECOVERY_HINT =
  "If Agent Deck tools are missing in Cursor, don't use `mcp_auth` — run `agent-deck use <deck> --client cursor` in the project folder, then reload Cursor MCP.";

export type McpClient = 'cursor' | 'claude' | 'claude-desktop' | 'muse' | 'codex';
export type SetupScope = 'global' | 'project';

/** Muse user settings require this exact schema version (NOT-387). */
export const MUSE_SCHEMA_VERSION = 1;

export interface McpEndpoint {
  host: string;
  mcpPort: number;
}

export function buildMcpUrl({ host, mcpPort }: McpEndpoint): string {
  return `http://${host}:${mcpPort}/mcp`;
}

/** Muse honors XDG_CONFIG_HOME for its user settings; otherwise ~/.config. */
export function resolveMuseGlobalConfigDir(home: string = os.homedir()): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? xdg : path.join(home, '.config');
}

export function resolveConfigPath(
  client: McpClient,
  scope: SetupScope,
  cwd: string = process.cwd(),
): string {
  const home = os.homedir();

  switch (client) {
    case 'cursor':
      return scope === 'project'
        ? path.join(cwd, '.cursor', 'mcp.json')
        : path.join(home, '.cursor', 'mcp.json');
    case 'claude':
      return scope === 'project'
        ? path.join(cwd, '.mcp.json')
        : path.join(home, '.claude.json');
    case 'claude-desktop':
      if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      if (process.platform === 'win32') {
        return path.join(process.env.APPDATA ?? home, 'Claude', 'claude_desktop_config.json');
      }
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    case 'muse':
      if (scope === 'project') {
        return path.join(cwd, '.mcp.json');
      }
      return path.join(resolveMuseGlobalConfigDir(home), 'muse', 'settings.json');
    case 'codex':
      return scope === 'project'
        ? path.join(cwd, '.codex', 'config.toml')
        : path.join(home, '.codex', 'config.toml');
    default:
      throw new Error(`Unsupported client: ${client satisfies never}`);
  }
}

/** Pure-HTTP Codex entry: URL plus the workspace header only (NOT-563). */
export type CodexAgentDeckEntry = {
  url: string;
  http_headers: Record<string, string>;
};

/**
 * Pure-HTTP entry for a Codex project config (`<folder>/.codex/config.toml`).
 * The daemon resolves the deck from `.agent-deck/use.json` — no deck id here.
 */
export function buildCodexAgentDeckEntry(
  endpoint: McpEndpoint,
  options: { workspaceRoot: string },
): CodexAgentDeckEntry {
  return {
    url: buildMcpUrl(endpoint),
    http_headers: {
      'x-agent-deck-workspace': path.resolve(options.workspaceRoot),
    },
  };
}

/**
 * Global headerless HTTP fallback entry (NOT-565, design §4): folders with
 * no assignment connect everywhere over pure MCP and land in the existing
 * unassigned (explain-only) session. No headers, no executable lookup.
 * Per-folder entries written by `agent-deck use` use the same server name,
 * so they shadow this fallback where an assignment exists.
 */
export function buildGlobalFallbackHttpEntry(endpoint: McpEndpoint): Record<string, unknown> {
  return {
    type: 'http',
    url: buildMcpUrl(endpoint),
  };
}

/**
 * MCP client entry for the agent-deck server. Launcher clients use the
 * trusted local launcher, which reads the folder assignment at runtime —
 * no deck id in tracked config. Codex and Claude project entries are
 * pure HTTP (NOT-563): the workspace header names the folder and the
 * daemon resolves the deck from `.agent-deck/use.json`.
 *
 * A `workspaceRoot` selects the per-folder HTTP form for Claude; without
 * one Claude gets the global headerless HTTP fallback (NOT-565).
 */
export function buildAgentDeckEntry(
  client: McpClient,
  endpoint: McpEndpoint,
  options?: { workspaceRoot?: string },
): Record<string, unknown> {
  if (client === 'codex') {
    if (!options?.workspaceRoot) {
      throw new Error(
        'buildAgentDeckEntry(codex) requires options.workspaceRoot for the x-agent-deck-workspace header',
      );
    }
    return buildCodexAgentDeckEntry(endpoint, { workspaceRoot: options.workspaceRoot });
  }

  if (client === 'claude-desktop') {
    return {
      command: 'agent-deck',
      args: ['mcp-launch'],
    };
  }

  if (client === 'muse') {
    // Muse may rewrite its settings file, so rely only on the preserved
    // command/args/env fields: no cwd, type, required, or timeout fields.
    // No AGENT_DECK_WORKSPACE pin either — an omitted cwd means the Muse
    // session working directory, so mcp-launch resolves the active
    // workspace's .agent-deck/use.json dynamically. options.workspaceRoot
    // is deliberately ignored for both scopes.
    return {
      command: 'agent-deck',
      args: ['mcp-launch'],
      env: {
        AGENT_DECK_MCP_PORT: String(endpoint.mcpPort),
        AGENT_DECK_HOST: endpoint.host,
      },
    };
  }

  if (client === 'claude') {
    if (options?.workspaceRoot) {
      // NOT-563 per-folder pure-MCP entry: the daemon resolves the deck
      // from `.agent-deck/use.json` — no deck id in the file.
      return {
        type: 'http',
        url: buildMcpUrl(endpoint),
        headers: {
          'x-agent-deck-workspace': path.resolve(options.workspaceRoot),
        },
      };
    }
    // NOT-565 global setup fallback: headerless pure HTTP, no launcher
    // and no executable lookup. (The per-folder form above already
    // returned, so no workspaceRoot is in scope here.)
    return buildGlobalFallbackHttpEntry(endpoint);
  }

  const env: Record<string, string> = {
    AGENT_DECK_MCP_PORT: String(endpoint.mcpPort),
    AGENT_DECK_HOST: endpoint.host,
  };
  if (options?.workspaceRoot) {
    env.AGENT_DECK_WORKSPACE = path.resolve(options.workspaceRoot);
  }

  return {
    command: 'agent-deck',
    args: ['mcp-launch'],
    env,
  };
}

/** Pre-1.7 Cursor/HTTP entries used bare `url` with no deck-assignment launcher. */
export function isLegacyBareHttpAgentDeckEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  return typeof record.url === 'string' && typeof record.command !== 'string';
}

export function isMcpLaunchEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return false;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.command !== 'string') {
    return false;
  }
  const commandName = record.command.replaceAll('\\', '/').split('/').pop();
  if (commandName !== 'agent-deck' && commandName !== 'agent-deck.cmd') {
    return false;
  }
  const args = record.args;
  return Array.isArray(args) && args.length === 1 && args[0] === 'mcp-launch';
}

export function readCursorWorkspaceRoot(entry: unknown): string | undefined {
  if (!isMcpLaunchEntry(entry)) {
    return undefined;
  }
  const env = (entry as Record<string, unknown>).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return undefined;
  }
  const workspaceRoot = (env as Record<string, unknown>).AGENT_DECK_WORKSPACE;
  return typeof workspaceRoot === 'string' && workspaceRoot.length > 0
    ? path.resolve(workspaceRoot)
    : undefined;
}

export type CursorGlobalMcpEnsureResult =
  | { action: 'ok'; path: string; workspaceRoot?: string }
  | {
      action: 'diagnostic';
      path: string;
      reason: 'missing' | 'bare-url' | 'missing-workspace' | 'endpoint-changed' | 'custom-entry';
      workspaceRoot?: string;
    }
  | { action: 'created'; path: string; reason: 'missing'; workspaceRoot: string }
  | { action: 'upgraded'; path: string; reason: 'bare-url'; workspaceRoot: string }
  | {
      action: 'updated';
      path: string;
      reason: 'missing-workspace' | 'endpoint-changed';
      workspaceRoot: string;
    }
  | {
      action: 'updated';
      path: string;
      reason: 'workspace-changed';
      workspaceRoot: string;
      previousWorkspaceRoot: string;
    }
  | { action: 'skipped'; path: string; reason: 'custom-entry' };

/**
 * Cursor Agent chat uses the user-level MCP entry (`user-agent-deck`).
 * Pre-1.7 bare `url` configs fail discovery and only expose Cursor's `mcp_auth`
 * (which is not how Agent Deck folder assignment works).
 *
 * Without a workspaceRoot this is strictly read-only and returns diagnostics.
 * An explicit `agent-deck use` passes workspaceRoot and may create or repair
 * Agent Deck's own launcher. Custom wrappers are never changed.
 */
export function ensureGlobalCursorMcpLaunch(
  endpoint: McpEndpoint,
  options?: { workspaceRoot?: string },
): CursorGlobalMcpEnsureResult {
  const configPath = resolveConfigPath('cursor', 'global');
  const existingConfig = readJsonFile(configPath);
  const servers =
    existingConfig.mcpServers && typeof existingConfig.mcpServers === 'object'
      ? (existingConfig.mcpServers as Record<string, unknown>)
      : {};
  const existing = servers['agent-deck'];
  const workspaceRoot = options?.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
  const desired = buildAgentDeckEntry('cursor', endpoint, { workspaceRoot });

  if (existing === undefined) {
    if (!workspaceRoot) {
      return { action: 'diagnostic', path: configPath, reason: 'missing' };
    }
    writeJsonFile(configPath, mergeMcpServerConfig(existingConfig, desired));
    return { action: 'created', path: configPath, reason: 'missing', workspaceRoot };
  }

  if (isLegacyBareHttpAgentDeckEntry(existing)) {
    if (!workspaceRoot) {
      return { action: 'diagnostic', path: configPath, reason: 'bare-url' };
    }
    writeJsonFile(configPath, mergeMcpServerConfig(existingConfig, desired));
    return {
      action: 'upgraded',
      path: configPath,
      reason: 'bare-url',
      workspaceRoot,
    };
  }

  if (!isMcpLaunchEntry(existing)) {
    return workspaceRoot
      ? { action: 'skipped', path: configPath, reason: 'custom-entry' }
      : { action: 'diagnostic', path: configPath, reason: 'custom-entry' };
  }

  const currentWorkspace = readCursorWorkspaceRoot(existing);
  const existingEnv = (existing as Record<string, unknown>).env;
  const env =
    existingEnv && typeof existingEnv === 'object' && !Array.isArray(existingEnv)
      ? (existingEnv as Record<string, unknown>)
      : {};
  const endpointChanged =
    env.AGENT_DECK_HOST !== endpoint.host ||
    env.AGENT_DECK_MCP_PORT !== String(endpoint.mcpPort);

  if (!workspaceRoot) {
    if (!currentWorkspace) {
      return { action: 'diagnostic', path: configPath, reason: 'missing-workspace' };
    }
    if (endpointChanged) {
      return {
        action: 'diagnostic',
        path: configPath,
        reason: 'endpoint-changed',
        workspaceRoot: currentWorkspace,
      };
    }
    return { action: 'ok', path: configPath, workspaceRoot: currentWorkspace };
  }

  if (currentWorkspace === workspaceRoot && !endpointChanged) {
    return { action: 'ok', path: configPath, workspaceRoot };
  }

  const reason = !currentWorkspace
    ? 'missing-workspace'
    : currentWorkspace !== workspaceRoot
      ? 'workspace-changed'
      : 'endpoint-changed';
  const currentRecord = existing as Record<string, unknown>;
  const desiredEnv = desired.env as Record<string, string>;
  const repaired = {
    ...currentRecord,
    ...desired,
    env: {
      ...env,
      ...desiredEnv,
    },
  };
  writeJsonFile(configPath, mergeMcpServerConfig(existingConfig, repaired));
  return reason === 'workspace-changed'
    ? {
        action: 'updated',
        path: configPath,
        reason,
        workspaceRoot,
        previousWorkspaceRoot: currentWorkspace!,
      }
    : { action: 'updated', path: configPath, reason, workspaceRoot };
}

export function formatCursorGlobalMcpEnsureMessage(result: CursorGlobalMcpEnsureResult): string | null {
  if (result.action === 'ok') {
    return null;
  }
  if (result.action === 'skipped') {
    return [
      `Cursor MCP: left custom agent-deck entry unchanged in ${result.path}.`,
      '  Configure that wrapper to run `agent-deck mcp-launch` with AGENT_DECK_WORKSPACE set to this workspace.',
    ].join('\n');
  }
  if (result.action === 'diagnostic') {
    const detail =
      result.reason === 'missing'
        ? 'no user-level agent-deck entry exists'
        : result.reason === 'bare-url'
          ? 'legacy bare URL has no deck-assignment launcher'
          : result.reason === 'missing-workspace'
            ? 'mcp-launch has no AGENT_DECK_WORKSPACE pin'
            : result.reason === 'endpoint-changed'
              ? 'the configured Agent Deck endpoint is stale'
              : 'a custom agent-deck wrapper cannot be validated automatically';
    return [
      `Cursor MCP diagnostic: ${detail} in ${result.path}. No changes made.`,
      `  ${CURSOR_MCP_RECOVERY_HINT}`,
    ].join('\n');
  }
  if (result.action === 'created') {
    return [
      `Cursor MCP: created ${result.path} and pinned it to ${result.workspaceRoot}.`,
      '  Reload Cursor MCP (or restart Cursor). Cursor mcp_auth is not required.',
    ].join('\n');
  }
  if (result.action === 'upgraded') {
    return [
      `Cursor MCP: upgraded the legacy bare URL in ${result.path} to mcp-launch and pinned it to ${result.workspaceRoot}.`,
      '  Reload Cursor MCP (or restart Cursor). Cursor mcp_auth is not required.',
    ].join('\n');
  }
  if (result.reason === 'workspace-changed') {
    return [
      `Cursor MCP: moved the user-level workspace pin from ${result.previousWorkspaceRoot} to ${result.workspaceRoot} in ${result.path}.`,
      '  Cursor user-level Agent Deck is last explicit `agent-deck use` wins; reload Cursor MCP (or restart Cursor).',
    ].join('\n');
  }
  const detail =
    result.reason === 'missing-workspace'
      ? `added the missing workspace pin ${result.workspaceRoot}`
      : `updated the endpoint while keeping workspace ${result.workspaceRoot}`;
  return [
    `Cursor MCP: repaired ${result.path}; ${detail}.`,
    '  Reload Cursor MCP (or restart Cursor). Cursor mcp_auth is not required.',
  ].join('\n');
}

export function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = sanitizeJsonText(fs.readFileSync(filePath, 'utf8').trim());
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }

  return parsed as Record<string, unknown>;
}

/**
 * Merge into Muse global settings: sets schema_version when absent, rejects
 * an incompatible existing schema version with an actionable error (caller
 * must leave the file untouched), and preserves every unrelated root key
 * and MCP server. Project .mcp.json uses the plain merge — it has no
 * schema_version and is shared with Claude Code.
 */
export function mergeMuseServerConfig(
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
  configPath: string,
): Record<string, unknown> {
  const schemaVersion = existing.schema_version;
  if (schemaVersion !== undefined && schemaVersion !== MUSE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schema_version in ${configPath}: expected ${MUSE_SCHEMA_VERSION}, found ${JSON.stringify(schemaVersion)}. ` +
        'Update Muse or fix the file manually, then re-run setup.',
    );
  }
  return {
    ...mergeMcpServerConfig(existing, entry),
    schema_version: MUSE_SCHEMA_VERSION,
  };
}

export function mergeMcpServerConfig(
  existing: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const currentServers = existing.mcpServers;
  const mcpServers =
    currentServers && typeof currentServers === 'object' && !Array.isArray(currentServers)
      ? { ...(currentServers as Record<string, unknown>) }
      : {};

  mcpServers['agent-deck'] = entry;

  return {
    ...existing,
    mcpServers,
  };
}

export function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function readTextFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function writeTextFile(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

/**
 * Matches our managed Codex section headers: the `[mcp_servers.agent-deck]`
 * parent plus any `[mcp_servers.agent-deck.<sub>]` sub-table (the layout
 * `codex mcp add --env` writes). Bare or quoted key, whitespace-tolerant,
 * with any trailing comment. Never matches a merely prefixed sibling such
 * as `[mcp_servers.agent-deck-env]`.
 */
const CODEX_AGENT_DECK_SECTION_RE =
  /^\s*\[\s*mcp_servers\s*\.\s*("agent-deck"|'agent-deck'|agent-deck)\s*(\.\s*[^\]#]+)?\]\s*(?:#.*)?$/;

/** Matches a bare `[mcp_servers]` section header holding dotted/inline keys. */
const CODEX_MCP_SERVERS_SECTION_RE =
  /^\s*\[\s*("mcp_servers"|'mcp_servers'|mcp_servers)\s*\]\s*(?:#.*)?$/;

/** Matches an `agent-deck` key definition start inside `[mcp_servers]`. */
const CODEX_MCP_SERVERS_AGENT_DECK_KEY_RE =
  /^\s*("agent-deck"|'agent-deck'|agent-deck)\s*(?=[.=])/;

function isTomlSectionHeader(line: string): boolean {
  return line.trimStart().startsWith('[');
}

/**
 * Net `{`/`[` minus `}`/`]` depth change of one TOML line, ignoring string
 * literals and `#` comments so braces inside values never unbalance the
 * scan. Used to skip multi-line inline tables when removing stale keys.
 */
function tomlBracketDelta(line: string): number {
  let code = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '"') {
      i += 1;
      while (i < line.length && line[i] !== '"') {
        i += line[i] === '\\' ? 2 : 1;
      }
      i += 1;
    } else if (ch === "'") {
      i += 1;
      while (i < line.length && line[i] !== "'") {
        i += 1;
      }
      i += 1;
    } else if (ch === '#') {
      break;
    } else {
      code += ch;
      i += 1;
    }
  }
  let delta = 0;
  for (const c of code) {
    if (c === '{' || c === '[') {
      delta += 1;
    } else if (c === '}' || c === ']') {
      delta -= 1;
    }
  }
  return delta;
}

export function escapeTomlBasicString(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
}

/**
 * Canonical `[mcp_servers.agent-deck]` TOML block (NOT-563). No trailing
 * newline — the merge helper owns file framing.
 */
export function formatCodexMcpSection(entry: CodexAgentDeckEntry): string {
  const headers = Object.entries(entry.http_headers)
    .map(
      ([name, value]) => `"${escapeTomlBasicString(name)}" = "${escapeTomlBasicString(value)}"`,
    )
    .join(', ');
  return [
    '[mcp_servers.agent-deck]',
    `url = "${escapeTomlBasicString(entry.url)}"`,
    `http_headers = { ${headers} }`,
  ].join('\n');
}

/**
 * Canonical headerless `[mcp_servers.agent-deck]` TOML block: the global
 * unassigned-folder fallback (NOT-565, design §4). Same-name per-folder
 * entries written by `agent-deck use` shadow it. No trailing newline —
 * the merge helper owns file framing.
 */
export function formatCodexGlobalFallbackSection(endpoint: McpEndpoint): string {
  return [
    '[mcp_servers.agent-deck]',
    `url = "${escapeTomlBasicString(buildMcpUrl(endpoint))}"`,
  ].join('\n');
}

/**
 * Merge our managed section into existing Codex TOML, preserving every
 * unrelated byte. Stale agent-deck content in any form is removed first:
 * the parent section, every `[mcp_servers.agent-deck.<sub>]` sub-table
 * wherever it sits, and dotted/inline `agent-deck` keys under a bare
 * `[mcp_servers]` section (multi-line inline tables included). The first
 * managed section is replaced in place with its header normalized to the
 * bare form; otherwise the section is appended after a blank separator.
 * Idempotent: merging twice yields byte-identical text. The result ends
 * with exactly one newline when the section is the last content.
 */
export function mergeCodexTomlConfig(existingText: string, section: string): string {
  const lines = existingText.split('\n');
  const headerKind = new Map<number, 'managed' | 'servers' | 'other'>();
  for (const [index, line] of lines.entries()) {
    if (!isTomlSectionHeader(line)) {
      continue;
    }
    if (CODEX_AGENT_DECK_SECTION_RE.test(line)) {
      headerKind.set(index, 'managed');
    } else if (CODEX_MCP_SERVERS_SECTION_RE.test(line)) {
      headerKind.set(index, 'servers');
    } else {
      headerKind.set(index, 'other');
    }
  }
  const headerIdxs = [...headerKind.keys()];
  const rangeEnd = (headerIdx: number): number => {
    for (const candidate of headerIdxs) {
      if (candidate > headerIdx) {
        return candidate;
      }
    }
    return lines.length;
  };

  // Dotted/inline agent-deck definitions inside bare [mcp_servers] bodies.
  // Only top-level keys count, so a nested `agent-deck` key inside another
  // server's inline table is left alone.
  const removed = new Set<number>();
  for (const [headerIdx, kind] of headerKind) {
    if (kind !== 'servers') {
      continue;
    }
    const end = rangeEnd(headerIdx);
    let depth = 0;
    let index = headerIdx + 1;
    while (index < end) {
      const line = lines[index];
      if (depth === 0 && CODEX_MCP_SERVERS_AGENT_DECK_KEY_RE.test(line)) {
        depth += tomlBracketDelta(line);
        removed.add(index);
        index += 1;
        while (depth > 0 && index < end) {
          depth += tomlBracketDelta(lines[index]);
          removed.add(index);
          index += 1;
        }
        depth = 0;
        continue;
      }
      depth += tomlBracketDelta(line);
      if (depth < 0) {
        depth = 0;
      }
      index += 1;
    }
    // A removed key block takes one following blank separator with it when
    // it sits right after the header or between blank lines, so no doubled
    // blank line is left behind.
    for (let i = headerIdx + 1; i < end; i += 1) {
      if (!removed.has(i) || (i > headerIdx + 1 && removed.has(i - 1))) {
        continue;
      }
      let blockEnd = i;
      while (blockEnd + 1 < end && removed.has(blockEnd + 1)) {
        blockEnd += 1;
      }
      const after = blockEnd + 1;
      const beforeIsSeparator = i === headerIdx + 1 || lines[i - 1].trim() === '';
      if (after < end && !removed.has(after) && lines[after].trim() === '' && beforeIsSeparator) {
        removed.add(after);
      }
      i = blockEnd;
    }
  }

  const managedHeaders = headerIdxs.filter((index) => headerKind.get(index) === 'managed');
  const appendSection = (text: string): string => {
    let framed = text;
    if (framed !== '' && !framed.endsWith('\n')) {
      framed += '\n';
    }
    if (framed !== '' && !framed.endsWith('\n\n')) {
      framed += '\n';
    }
    return `${framed}${section}\n`;
  };
  if (managedHeaders.length === 0) {
    if (removed.size === 0) {
      return appendSection(existingText);
    }
    // Only dotted/inline definitions: drop them, then append. Inserting a
    // section header mid-body would reparent the remaining [mcp_servers]
    // keys under agent-deck.
    return appendSection(lines.filter((_, index) => !removed.has(index)).join('\n'));
  }

  for (const headerIdx of managedHeaders) {
    const end = rangeEnd(headerIdx);
    for (let index = headerIdx; index < end; index += 1) {
      removed.add(index);
    }
  }
  const first = managedHeaders[0];
  const firstEnd = rangeEnd(first);
  let nextKept = firstEnd;
  while (nextKept < lines.length && removed.has(nextKept)) {
    nextKept += 1;
  }
  // Keep one blank separator before the next surviving content when the
  // removed block had any: trailing blanks of the replaced range or blanks
  // in the gap up to the next kept line.
  let hadSeparator = false;
  for (let index = firstEnd - 1; index > first; index -= 1) {
    if (lines[index].trim() === '') {
      hadSeparator = true;
    } else {
      break;
    }
  }
  if (!hadSeparator) {
    for (let index = firstEnd; index < nextKept; index += 1) {
      if (lines[index].trim() === '') {
        hadSeparator = true;
        break;
      }
    }
  }
  const out: string[] = [];
  for (let index = 0; index < first; index += 1) {
    if (!removed.has(index)) {
      out.push(lines[index]);
    }
  }
  out.push(...section.split('\n'));
  const rest: string[] = [];
  for (let index = nextKept; index < lines.length; index += 1) {
    if (!removed.has(index)) {
      rest.push(lines[index]);
    }
  }
  if (hadSeparator && rest.some((line) => line.trim() !== '')) {
    out.push('');
  }
  out.push(...rest);
  const merged = out.join('\n');
  return merged.endsWith('\n') ? merged : `${merged}\n`;
}
