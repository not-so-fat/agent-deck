/**
 * Legacy launcher-entry rewrite (NOT-566, Muse retired NOT-572).
 *
 * Codex, Claude Code, and Muse connect over pure MCP now (per-folder
 * entry plus a global headerless fallback); installs that still carry a
 * pre-migration `agent-deck mcp-launch` entry keep working — the launcher
 * is retained for Claude Desktop — but `agent-deck upgrade` rewrites
 * those entries to the pure-MCP shape so the retired path stops spreading.
 * (Cursor entries migrate when `setup`/`use` re-runs — see NOT-567.)
 *
 * Owned files (launcher entries only; anything else is left byte-identical):
 * - `<folder>/.mcp.json` → per-folder HTTP entry (workspace header) for a
 *   legacy Claude marker (`type: 'stdio'` or an `AGENT_DECK_WORKSPACE`
 *   pin); a Muse-shaped launcher entry (neither marker) is rewritten the
 *   same way when the folder has a deck assignment (`.agent-deck/use.json`
 *   naming a deck), otherwise removed so the global fallback applies.
 *   The file is shared with Claude Code, and both clients read the same
 *   HTTP shape now (NOT-571).
 * - `<folder>/.codex/config.toml` → per-folder HTTP section (workspace header)
 * - `~/.claude.json` → headerless global HTTP fallback
 * - `~/.codex/config.toml` → headerless global HTTP fallback section
 * - Muse user settings (`$XDG_CONFIG_HOME/muse/settings.json`) → headerless
 *   global HTTP fallback (schema_version preserved); a same-name launcher
 *   project entry would otherwise be rejected against it as
 *   invalid_transport_combination.
 *
 * Never touched: Cursor entries (global and project), claude-desktop
 * entries, custom wrappers, and files that fail to parse (recorded as
 * skipped with the reason, so one bad file cannot block the rest).
 * Rewrites are idempotent: a second run changes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  buildAgentDeckEntry,
  buildCodexAgentDeckEntry,
  buildGlobalFallbackHttpEntry,
  codexTomlHasLauncherEntry,
  formatCodexGlobalFallbackSection,
  formatCodexMcpSection,
  isLegacyClaudeLaunchEntry,
  isLegacyMuseLaunchEntry,
  isMcpLaunchEntry,
  mergeCodexTomlConfig,
  mergeMcpServerConfig,
  mergeMuseServerConfig,
  readJsonFile,
  readTextFile,
  resolveConfigPath,
  writeJsonFile,
  writeTextFile,
  type McpEndpoint,
} from './mcp-config';

export type LauncherMigrationAction = 'rewritten' | 'removed' | 'unchanged' | 'skipped';

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
  matches: (entry: unknown) => boolean = isMcpLaunchEntry,
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
  if (current === undefined || !matches(current)) {
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

/**
 * True when the folder has a deck assignment (`.agent-deck/use.json`
 * naming a deck id). Sync read for the upgrade path: v2 and v3 manifests
 * both carry `deckId`, so one shape check covers both. A missing,
 * unparsable, or deck-less file means unassigned — the global fallback
 * applies there. Legacy macOS Keychain-only assignments are not visible
 * here; that folder reads as unassigned and its Muse launcher entry is
 * removed (re-run `agent-deck use <deck>` to rebind).
 */
function hasFolderAssignment(workspaceRoot: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, '.agent-deck', 'use.json'), 'utf8');
    const parsed = JSON.parse(raw) as { deckId?: unknown };
    return typeof parsed.deckId === 'string' && parsed.deckId.length > 0;
  } catch {
    return false;
  }
}

/** Remove the `agent-deck` server from a parsed config, keeping everything else. */
function removeAgentDeckServer(existing: Record<string, unknown>): Record<string, unknown> {
  const servers = existing.mcpServers;
  const mcpServers =
    servers && typeof servers === 'object' && !Array.isArray(servers)
      ? { ...(servers as Record<string, unknown>) }
      : {};
  delete mcpServers['agent-deck'];
  return { ...existing, mcpServers };
}

/**
 * Rewrite the shared project `<folder>/.mcp.json` (NOT-566 Claude,
 * NOT-572 Muse). A Claude-marked launcher entry is always rewritten to
 * the per-folder HTTP entry. A Muse-shaped launcher entry (neither
 * marker) is rewritten the same way when the folder has an assignment;
 * without one it is removed so the headerless global fallback applies
 * instead of a stale per-folder pin. Custom entries stay byte-identical.
 */
function rewriteProjectMcpJson(
  workspaceRoot: string,
  endpoint: McpEndpoint,
): LauncherMigrationResult {
  const configPath = resolveConfigPath('claude', 'project', workspaceRoot);
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
  if (current === undefined) {
    return { path: configPath, action: 'unchanged' };
  }
  if (isLegacyClaudeLaunchEntry(current)) {
    try {
      writeJsonFile(
        configPath,
        mergeMcpServerConfig(
          existing,
          buildAgentDeckEntry('claude', endpoint, { workspaceRoot }),
        ),
      );
    } catch (error) {
      return {
        path: configPath,
        action: 'skipped',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return { path: configPath, action: 'rewritten' };
  }
  if (!isLegacyMuseLaunchEntry(current)) {
    return { path: configPath, action: 'unchanged' };
  }
  try {
    if (hasFolderAssignment(workspaceRoot)) {
      writeJsonFile(
        configPath,
        mergeMcpServerConfig(
          existing,
          buildAgentDeckEntry('claude', endpoint, { workspaceRoot }),
        ),
      );
      return { path: configPath, action: 'rewritten' };
    }
    writeJsonFile(configPath, removeAgentDeckServer(existing));
  } catch (error) {
    return {
      path: configPath,
      action: 'skipped',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { path: configPath, action: 'removed' };
}

/**
 * Rewrite the Muse user settings launcher entry to the headerless global
 * HTTP fallback (NOT-572). Muse-only file, so any `agent-deck mcp-launch`
 * entry there is a legacy Muse entry by construction. An incompatible
 * schema_version is `skipped` with the reason — setup owns that repair.
 */
function rewriteMuseGlobalSettings(endpoint: McpEndpoint): LauncherMigrationResult {
  const configPath = resolveConfigPath('muse', 'global');
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
  let merged: Record<string, unknown>;
  try {
    merged = mergeMuseServerConfig(existing, buildGlobalFallbackHttpEntry(endpoint), configPath);
  } catch (error) {
    return {
      path: configPath,
      action: 'skipped',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    writeJsonFile(configPath, merged);
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
    // Project .mcp.json is shared with Claude Code: Claude-marked and
    // Muse-shaped launcher entries each get their own conversion; a
    // custom entry is `unchanged`. The global ~/.claude.json is
    // Claude-only, so any launcher entry there is legacy Claude by
    // construction.
    rewriteProjectMcpJson(workspaceRoot, endpoint),
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
    rewriteMuseGlobalSettings(endpoint),
  ];
}

/** One console line per rewritten, removed, or skipped file; silent when clean. */
export function formatLauncherMigrationResults(results: LauncherMigrationResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    if (result.action === 'rewritten') {
      lines.push(`MCP config: rewrote legacy launcher entry to pure MCP → ${result.path}`);
    } else if (result.action === 'removed') {
      lines.push(
        `MCP config: removed legacy launcher entry with no folder assignment → ${result.path} (global fallback applies; run \`agent-deck use <deck>\` to bind a deck)`,
      );
    } else if (result.action === 'skipped') {
      lines.push(`MCP config: left ${result.path} unchanged (${result.reason ?? 'unknown reason'})`);
    }
  }
  return lines;
}
