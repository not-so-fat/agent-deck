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

export type CursorGlobalMcpEnsureResult =
  | { action: 'ok'; path: string }
  | { action: 'upgraded' | 'created'; path: string; reason: 'bare-url' | 'missing' | 'non-launcher' };

/**
 * Cursor Agent chat uses the user-level MCP entry (`user-agent-deck`).
 * Pre-1.7 bare `url` configs fail discovery and only expose Cursor's `mcp_auth`
 * (which is not how Agent Deck grants work). Rewrite to `mcp-launch` when needed.
 */
export function ensureGlobalCursorMcpLaunch(endpoint: McpEndpoint): CursorGlobalMcpEnsureResult {
  const configPath = resolveConfigPath('cursor', 'global');
  const existingConfig = readJsonFile(configPath);
  const servers =
    existingConfig.mcpServers && typeof existingConfig.mcpServers === 'object'
      ? (existingConfig.mcpServers as Record<string, unknown>)
      : {};
  const existing = servers['agent-deck'];

  if (isMcpLaunchEntry(existing) && !isLegacyBareHttpAgentDeckEntry(existing)) {
    return { action: 'ok', path: configPath };
  }

  const reason: 'bare-url' | 'missing' | 'non-launcher' = !existing
    ? 'missing'
    : isLegacyBareHttpAgentDeckEntry(existing)
      ? 'bare-url'
      : 'non-launcher';

  const entry = buildAgentDeckEntry('cursor', endpoint);
  writeJsonFile(configPath, mergeMcpServerConfig(existingConfig, entry));
  return {
    action: existing ? 'upgraded' : 'created',
    path: configPath,
    reason,
  };
}

export function formatCursorGlobalMcpEnsureMessage(result: CursorGlobalMcpEnsureResult): string | null {
  if (result.action === 'ok') {
    return null;
  }
  const why =
    result.reason === 'bare-url'
      ? 'bare url (no grant Bearer)'
      : result.reason === 'missing'
        ? 'missing agent-deck entry'
        : 'non-launcher entry';
  return [
    `Cursor MCP: ${result.action} ${result.path} (${why} → mcp-launch).`,
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
