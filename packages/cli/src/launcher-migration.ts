/**
 * Legacy launcher-entry rewrite (NOT-566).
 *
 * Codex and Claude Code connect over pure MCP now (per-folder entry plus a
 * global headerless fallback); installs that still carry a pre-migration
 * `agent-deck mcp-launch` entry keep working — the launcher is retained for
 * Cursor, Muse, and Claude Desktop — but `agent-deck upgrade` rewrites
 * those entries to the pure-MCP shape so the retired path stops spreading.
 *
 * Owned files (launcher entries only; anything else is left byte-identical):
 * - `<folder>/.mcp.json` → per-folder HTTP entry (workspace header)
 * - `<folder>/.codex/config.toml` → per-folder HTTP section (workspace header)
 * - `~/.claude.json` → headerless global HTTP fallback
 * - `~/.codex/config.toml` → headerless global HTTP fallback section
 *
 * Never touched: Cursor entries (global and project), Muse entries,
 * claude-desktop entries, custom wrappers, and files that fail to parse
 * (recorded as skipped with the reason, so one bad file cannot block the
 * rest). Rewrites are idempotent: a second run changes nothing.
 */
import {
  buildAgentDeckEntry,
  buildCodexAgentDeckEntry,
  buildGlobalFallbackHttpEntry,
  codexTomlHasLauncherEntry,
  formatCodexGlobalFallbackSection,
  formatCodexMcpSection,
  isMcpLaunchEntry,
  mergeCodexTomlConfig,
  mergeMcpServerConfig,
  readJsonFile,
  readTextFile,
  resolveConfigPath,
  writeJsonFile,
  writeTextFile,
  type McpEndpoint,
} from './mcp-config';

export type LauncherMigrationAction = 'rewritten' | 'unchanged' | 'skipped';

export interface LauncherMigrationResult {
  path: string;
  action: LauncherMigrationAction;
  /** Human-readable reason for `skipped` (and only for `skipped`). */
  reason?: string;
}

export interface LauncherMigrationOptions {
  workspaceRoot: string;
  endpoint: McpEndpoint;
}

function rewriteJsonEntry(
  configPath: string,
  replacement: Record<string, unknown>,
): LauncherMigrationResult {
  let existing: Record<string, unknown>;
  try {
    existing = readJsonFile(configPath);
  } catch (error) {
    return {
      path: configPath,
      action: 'skipped',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const servers = existing.mcpServers;
  const current =
    servers && typeof servers === 'object' && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)['agent-deck']
      : undefined;
  if (current === undefined || !isMcpLaunchEntry(current)) {
    return { path: configPath, action: 'unchanged' };
  }
  try {
    writeJsonFile(configPath, mergeMcpServerConfig(existing, replacement));
  } catch (error) {
    return {
      path: configPath,
      action: 'skipped',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { path: configPath, action: 'rewritten' };
}

function rewriteCodexToml(configPath: string, section: string): LauncherMigrationResult {
  let existing: string;
  try {
    existing = readTextFile(configPath);
  } catch (error) {
    return {
      path: configPath,
      action: 'skipped',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!codexTomlHasLauncherEntry(existing)) {
    return { path: configPath, action: 'unchanged' };
  }
  try {
    writeTextFile(configPath, mergeCodexTomlConfig(existing, section));
  } catch (error) {
    return {
      path: configPath,
      action: 'skipped',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { path: configPath, action: 'rewritten' };
}

/**
 * Rewrite legacy launcher entries to pure-MCP entries. Best-effort per
 * file: every owned path is attempted and reported, so one unreadable or
 * unwritable file cannot block the rest. Never throws for file problems —
 * those are `skipped` results with the reason attached.
 */
export function rewriteLegacyLauncherEntries(
  options: LauncherMigrationOptions,
): LauncherMigrationResult[] {
  const { workspaceRoot, endpoint } = options;
  return [
    rewriteJsonEntry(
      resolveConfigPath('claude', 'project', workspaceRoot),
      buildAgentDeckEntry('claude', endpoint, { workspaceRoot }),
    ),
    rewriteCodexToml(
      resolveConfigPath('codex', 'project', workspaceRoot),
      formatCodexMcpSection(buildCodexAgentDeckEntry(endpoint, { workspaceRoot })),
    ),
    rewriteJsonEntry(
      resolveConfigPath('claude', 'global', workspaceRoot),
      buildGlobalFallbackHttpEntry(endpoint),
    ),
    rewriteCodexToml(
      resolveConfigPath('codex', 'global', workspaceRoot),
      formatCodexGlobalFallbackSection(endpoint),
    ),
  ];
}

/** One console line per rewritten or skipped file; silent when clean. */
export function formatLauncherMigrationResults(results: LauncherMigrationResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    if (result.action === 'rewritten') {
      lines.push(`MCP config: rewrote legacy launcher entry to pure MCP → ${result.path}`);
    } else if (result.action === 'skipped') {
      lines.push(`MCP config: left ${result.path} unchanged (${result.reason ?? 'unknown reason'})`);
    }
  }
  return lines;
}
