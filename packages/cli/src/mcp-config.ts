import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENT_DECK_DECK_ID_HEADER } from '@agent-deck/shared';

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
 * MCP client entry for the agent-deck server. When `deckId` is given, the deck is
 * carried as a request header (`x-agent-deck-deck-id`) so the server pre-binds this
 * workspace's session to that deck on connect — no `bind_workspace` call needed.
 * The id is a portable UUID (safe to commit); the absolute workspace path is not,
 * so it is intentionally omitted.
 */
export function buildAgentDeckEntry(
  client: McpClient,
  endpoint: McpEndpoint,
  deckId?: string,
): Record<string, unknown> {
  const url = buildMcpUrl(endpoint);
  const headers = deckId ? { [AGENT_DECK_DECK_ID_HEADER]: deckId } : undefined;

  if (client === 'claude-desktop') {
    const args = ['-y', 'supergateway', '--streamableHttp', url];
    if (deckId) {
      args.push('--header', `${AGENT_DECK_DECK_ID_HEADER}:${deckId}`);
    }
    return { command: 'npx', args };
  }

  if (client === 'claude') {
    return headers ? { type: 'http', url, headers } : { type: 'http', url };
  }

  return headers ? { url, headers } : { url };
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
