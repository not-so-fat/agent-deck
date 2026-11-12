/**
 * Legacy launcher-entry rewrite (NOT-566, Muse retired NOT-572, scan NOT-577).
 *
 * Codex, Claude Code, and Muse connect over pure MCP now (per-folder
 * entry plus a global headerless fallback); installs that still carry a
 * pre-migration `agent-deck mcp-launch` entry keep working — the launcher
 * is retained for Claude Desktop — but `agent-deck upgrade` rewrites
 * those entries to the pure-MCP shape so the retired path stops spreading.
 * (Cursor project entries migrate via `upgrade --scan` or when
 * `setup`/`use` re-runs — see NOT-567/NOT-577.)
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
 * - `<folder>/.cursor/mcp.json` → per-folder HTTP entry (workspace header)
 *   for a legacy launcher entry — scan only (`includeCursorProject`),
 *   never the plain `upgrade` path.
 * - `~/.claude.json` → headerless global HTTP fallback
 * - `~/.codex/config.toml` → headerless global HTTP fallback section
 * - Muse user settings (`$XDG_CONFIG_HOME/muse/settings.json`) → headerless
 *   global HTTP fallback (schema_version preserved); a same-name launcher
 *   project entry would otherwise be rejected against it as
 *   invalid_transport_combination.
 *
 * Never touched: Cursor global entries, claude-desktop entries, custom
 * wrappers, and files that fail to parse (recorded as skipped with the
 * reason, so one bad file cannot block the rest). Plain `upgrade` also
 * leaves Cursor project entries alone; only `upgrade --scan` rewrites
 * them. Rewrites are idempotent: a second run changes nothing. With
 * `dryRun` every check runs but nothing is written — `rewritten`/`removed`
 * then mean "would rewrite"/"would remove".
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
  /** When true, report `rewritten`/`removed` without writing anything (scan `--check`). */
  dryRun?: boolean;
  /** When true, also rewrite the Cursor project entry (scan only, never plain `upgrade`). */
  includeCursorProject?: boolean;
}

function rewriteJsonEntry(
  configPath: string,
  replacement: Record<string, unknown>,
  matches: (entry: unknown) => boolean = isMcpLaunchEntry,
  dryRun = false,
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
  if (dryRun) {
    return { path: configPath, action: 'rewritten' };
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
  dryRun = false,
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
    if (dryRun) {
      return { path: configPath, action: 'rewritten' };
    }
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
  if (dryRun) {
    return {
      path: configPath,
      action: hasFolderAssignment(workspaceRoot) ? 'rewritten' : 'removed',
    };
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
 * Rewrite the Cursor project `<folder>/.cursor/mcp.json` launcher entry to
 * the headed HTTP entry (NOT-577, scan only). Cursor-only file, so any
 * `agent-deck mcp-launch` entry there is legacy Cursor by construction.
 * Non-launcher and custom entries stay byte-identical, and the folder
 * assignment (`.agent-deck/use.json`) is never touched — the daemon
 * resolves the deck from it via the workspace header.
 */
function rewriteCursorProjectEntry(
  workspaceRoot: string,
  endpoint: McpEndpoint,
  dryRun = false,
): LauncherMigrationResult {
  return rewriteJsonEntry(
    resolveConfigPath('cursor', 'project', workspaceRoot),
    buildAgentDeckEntry('cursor', endpoint, { workspaceRoot }),
    isMcpLaunchEntry,
    dryRun,
  );
}

/**
 * Rewrite the Muse user settings launcher entry to the headerless global
 * HTTP fallback (NOT-572). Muse-only file, so any `agent-deck mcp-launch`
 * entry there is a legacy Muse entry by construction. An incompatible
 * schema_version is `skipped` with the reason — setup owns that repair.
 */
function rewriteMuseGlobalSettings(endpoint: McpEndpoint, dryRun = false): LauncherMigrationResult {
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
  if (dryRun) {
    return { path: configPath, action: 'rewritten' };
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

function rewriteCodexToml(configPath: string, section: string, dryRun = false): LauncherMigrationResult {
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
  if (dryRun) {
    return { path: configPath, action: 'rewritten' };
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
 * Rewrite the per-folder entries for one workspace root: the shared
 * `.mcp.json`, the Codex project TOML, and — only when
 * `includeCursorProject` is set (scan path) — the Cursor project entry.
 */
export function rewriteProjectLauncherEntries(options: {
  workspaceRoot: string;
  endpoint: McpEndpoint;
  dryRun?: boolean;
  includeCursorProject?: boolean;
}): LauncherMigrationResult[] {
  const { workspaceRoot, endpoint, dryRun = false, includeCursorProject = false } = options;
  const results: LauncherMigrationResult[] = [
    // Project .mcp.json is shared with Claude Code: Claude-marked and
    // Muse-shaped launcher entries each get their own conversion; a
    // custom entry is `unchanged`.
    rewriteProjectMcpJson(workspaceRoot, endpoint, dryRun),
    rewriteCodexToml(
      resolveConfigPath('codex', 'project', workspaceRoot),
      formatCodexMcpSection(buildCodexAgentDeckEntry(endpoint, { workspaceRoot })),
      dryRun,
    ),
  ];
  if (includeCursorProject) {
    results.push(rewriteCursorProjectEntry(workspaceRoot, endpoint, dryRun));
  }
  return results;
}

/**
 * Rewrite the global fallbacks once per invocation. These never depend on
 * the workspace root (home-dir paths), so the scan pass runs them once
 * rather than once per folder.
 */
export function rewriteGlobalLauncherEntries(options: {
  endpoint: McpEndpoint;
  dryRun?: boolean;
}): LauncherMigrationResult[] {
  const { endpoint, dryRun = false } = options;
  return [
    // The global ~/.claude.json is Claude-only, so any launcher entry
    // there is legacy Claude by construction.
    rewriteJsonEntry(
      resolveConfigPath('claude', 'global'),
      buildGlobalFallbackHttpEntry(endpoint),
      isMcpLaunchEntry,
      dryRun,
    ),
    rewriteCodexToml(
      resolveConfigPath('codex', 'global'),
      formatCodexGlobalFallbackSection(endpoint),
      dryRun,
    ),
    rewriteMuseGlobalSettings(endpoint, dryRun),
  ];
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
  const { workspaceRoot, endpoint, dryRun = false, includeCursorProject = false } = options;
  return [
    ...rewriteProjectLauncherEntries({ workspaceRoot, endpoint, dryRun, includeCursorProject }),
    ...rewriteGlobalLauncherEntries({ endpoint, dryRun }),
  ];
}

/**
 * Rewrite every assigned folder's project entries plus the globals once
 * (NOT-577 scan pass). Globals are identical for every folder, so they
 * run once rather than once per folder; project entries (including the
 * Cursor project entry) run per folder.
 */
export function rewriteScanFolders(
  folders: string[],
  endpoint: McpEndpoint,
  options: { dryRun?: boolean } = {},
): LauncherMigrationResult[] {
  const { dryRun = false } = options;
  const results: LauncherMigrationResult[] = [];
  for (const folder of folders) {
    results.push(
      ...rewriteProjectLauncherEntries({
        workspaceRoot: folder,
        endpoint,
        dryRun,
        includeCursorProject: true,
      }),
    );
  }
  results.push(...rewriteGlobalLauncherEntries({ endpoint, dryRun }));
  return results;
}

/**
 * One console line per rewritten, removed, or skipped file; silent when
 * clean. With `check`, rewrites read as "would rewrite"/"would remove"
 * for the dry-run report.
 */
export function formatLauncherMigrationResults(
  results: LauncherMigrationResult[],
  options: { check?: boolean } = {},
): string[] {
  const lines: string[] = [];
  for (const result of results) {
    if (result.action === 'rewritten') {
      lines.push(
        options.check
          ? `MCP config: would rewrite legacy launcher entry to pure MCP → ${result.path}`
          : `MCP config: rewrote legacy launcher entry to pure MCP → ${result.path}`,
      );
    } else if (result.action === 'removed') {
      lines.push(
        options.check
          ? `MCP config: would remove legacy launcher entry with no folder assignment → ${result.path} (global fallback applies; run \`agent-deck use <deck>\` to bind a deck)`
          : `MCP config: removed legacy launcher entry with no folder assignment → ${result.path} (global fallback applies; run \`agent-deck use <deck>\` to bind a deck)`,
      );
    } else if (result.action === 'skipped') {
      lines.push(`MCP config: left ${result.path} unchanged (${result.reason ?? 'unknown reason'})`);
    }
  }
  return lines;
}

/** Count summary for the scan pass, always printed (even when clean). */
export function formatScanSummary(
  folders: string[],
  results: LauncherMigrationResult[],
  options: { check?: boolean } = {},
): string {
  const rewritten = results.filter((r) => r.action === 'rewritten').length;
  const removed = results.filter((r) => r.action === 'removed').length;
  const skipped = results.filter((r) => r.action === 'skipped').length;
  const unchanged = results.filter((r) => r.action === 'unchanged').length;
  const folderWord = folders.length === 1 ? 'folder' : 'folders';
  if (options.check) {
    return (
      `Scan (check): ${folders.length} ${folderWord}, ` +
      `${rewritten} would rewrite, ${removed} would remove, ` +
      `${skipped} skipped, ${unchanged} unchanged — no files changed.`
    );
  }
  return (
    `Scan complete: ${folders.length} ${folderWord}, ` +
    `${rewritten} rewritten, ${removed} removed, ${skipped} skipped, ${unchanged} unchanged.`
  );
}
