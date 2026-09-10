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
    const entry: Record<string, unknown> = {
      type: 'stdio',
      command: 'agent-deck',
      args: ['mcp-launch'],
    };
    if (options?.workspaceRoot) {
      entry.env = {
        AGENT_DECK_WORKSPACE: path.resolve(options.workspaceRoot),
      };
    }
    return entry;
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
 * (which is not how Agent Deck grants work).
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
          ? 'legacy bare URL has no workspace grant launcher'
          : result.reason === 'missing-workspace'
            ? 'mcp-launch has no AGENT_DECK_WORKSPACE pin'
            : result.reason === 'endpoint-changed'
              ? 'the configured Agent Deck endpoint is stale'
              : 'a custom agent-deck wrapper cannot be validated automatically';
    return [
      `Cursor MCP diagnostic: ${detail} in ${result.path}. No changes made.`,
      '  Run `agent-deck use <deck> --client cursor` in the intended workspace; Cursor mcp_auth is not the Agent Deck grant path.',
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
