import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizeJsonText } from './strip-ansi';

export type McpClient = 'cursor' | 'claude' | 'claude-desktop';
export type SetupScope = 'global' | 'project';

export interface McpEndpoint {
  host: string;
  mcpPort: number;
}

export function buildMcpUrl({ host, mcpPort }: McpEndpoint): string {
  return `http://${host}:${mcpPort}/mcp`;
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
    default:
      throw new Error(`Unsupported client: ${client satisfies never}`);
  }
}

/**
 * MCP client entry for the agent-deck server. Uses the trusted local launcher,
 * which reads the private workspace grant at runtime — no deck id in tracked config.
 */
export function buildAgentDeckEntry(
  client: McpClient,
  endpoint: McpEndpoint,
  options?: { workspaceRoot?: string },
): Record<string, unknown> {
  if (client === 'claude-desktop') {
    return {
      command: 'agent-deck',
      args: ['mcp-launch'],
    };
  }

  if (client === 'claude') {
    return {
      type: 'stdio',
      command: 'agent-deck',
      args: ['mcp-launch'],
    };
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

/** Pre-1.7 Cursor/HTTP entries used bare `url` with no grant Bearer. */
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
  if (record.command !== 'agent-deck') {
    return false;
  }
  const args = record.args;
  return Array.isArray(args) && args.includes('mcp-launch');
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
  | { action: 'ok'; path: string }
  | { action: 'created'; path: string; reason: 'missing'; workspaceRoot: string }
  | { action: 'upgraded'; path: string; reason: 'bare-url'; workspaceRoot?: string }
  | {
      action: 'updated';
      path: string;
      reason: 'missing-workspace' | 'workspace-changed' | 'endpoint-changed';
      workspaceRoot: string;
    }
  | { action: 'skipped'; path: string; reason: 'custom-entry' };

/**
 * Cursor Agent chat uses the user-level MCP entry (`user-agent-deck`).
 * Pre-1.7 bare `url` configs fail discovery and only expose Cursor's `mcp_auth`
 * (which is not how Agent Deck grants work).
 *
 * Without a workspaceRoot, only positively identified legacy bare HTTP entries
 * are upgraded. An explicit `agent-deck use` passes workspaceRoot and may also
 * create or repair Agent Deck's own launcher. Custom wrappers are never changed.
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
      return { action: 'ok', path: configPath };
    }
    writeJsonFile(configPath, mergeMcpServerConfig(existingConfig, desired));
    return { action: 'created', path: configPath, reason: 'missing', workspaceRoot };
  }

  if (isLegacyBareHttpAgentDeckEntry(existing)) {
    writeJsonFile(configPath, mergeMcpServerConfig(existingConfig, desired));
    return {
      action: 'upgraded',
      path: configPath,
      reason: 'bare-url',
      ...(workspaceRoot ? { workspaceRoot } : {}),
    };
  }

  if (!isMcpLaunchEntry(existing)) {
    return workspaceRoot
      ? { action: 'skipped', path: configPath, reason: 'custom-entry' }
      : { action: 'ok', path: configPath };
  }

  if (!workspaceRoot) {
    return { action: 'ok', path: configPath };
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

  if (currentWorkspace === workspaceRoot && !endpointChanged) {
    return { action: 'ok', path: configPath };
  }

  const reason = !currentWorkspace
    ? 'missing-workspace'
    : currentWorkspace !== workspaceRoot
      ? 'workspace-changed'
      : 'endpoint-changed';
  writeJsonFile(configPath, mergeMcpServerConfig(existingConfig, desired));
  return { action: 'updated', path: configPath, reason, workspaceRoot };
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
  const workspaceNote =
    'workspaceRoot' in result ? ` Workspace pinned to ${result.workspaceRoot}.` : '';
  return [
    `Cursor MCP: ${result.action} ${result.path} (${result.reason} → mcp-launch).${workspaceNote}`,
    '  Reload Cursor MCP (or restart Cursor). Cursor\'s mcp_auth is not the Agent Deck fix — use needs a workspace grant + mcp-launch.',
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
