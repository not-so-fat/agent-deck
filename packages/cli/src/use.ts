import fs from 'node:fs';
import path from 'node:path';

import { ensureGitExcluded } from '@agent-deck/shared';
import { createCollectionAdmin } from './backend-runtime';
import { parseCliMcpPort } from './defaults';
import {
  buildAgentDeckEntry,
  buildCodexAgentDeckEntry,
  buildMcpUrl,
  formatCodexMcpSection,
  isMcpLaunchEntry,
  mergeCodexTomlConfig,
  mergeMcpServerConfig,
  readJsonFile,
  readTextFile,
  resolveConfigPath,
  writeJsonFile,
  writeTextFile,
  type McpClient,
  type McpEndpoint,
} from './mcp-config';
import { formatCursorMcpInspection, inspectCursorMcpConfig } from './cursor-mcp-inspect';
import {
  formatLegacyStubCleanupMessage,
  removeLegacyPlaybookStubs,
  syncPlaybookStubs,
  type LegacyStubCleanupResult,
  type StubSyncResult,
} from './playbook-stubs';
import { readAssignment, writeAssignment, type AssignmentFields } from './assignment';
import { readLegacyUseManifestV1 } from './playbook-stubs';
import {
  assignmentMatchesDeckRef,
  formatHomeStoreWriteBlockedMessage,
  isHomeStoreWriteError,
} from './home-write';

export type UseClientTarget = 'cursor' | 'claude' | 'codex' | 'muse' | 'both';

export interface UseOptions {
  deckRef?: string;
  refresh: boolean;
  clients: UseClientTarget;
  host: string;
  mcpPort: number;
  skipMcp: boolean;
  workspaceRoot: string;
}

export type UseResult = {
  deck: { id: string; name: string };
  mcpUrl: string;
  manifestPath: string;
  mcp: Array<{ client: McpClient; path: string }>;
  stubs: StubSyncResult;
  playbookCount: number;
  /** True when home-store writes were skipped after a blocked open (sandbox-safe workspace repair). */
  sandboxSafeRepair?: boolean;
};

/**
 * NOT-208 one-time migration: remove Agent Deck-managed legacy playbook
 * stubs from the workspace. Prints the migration note when anything was
 * removed; returns an { error } naming the exact path when a managed file
 * cannot be removed.
 */
function cleanupLegacyStubs(
  workspaceRoot: string,
  options?: { cursor?: boolean; claude?: boolean },
): LegacyStubCleanupResult | { error: string } {
  try {
    const cleanup = removeLegacyPlaybookStubs(workspaceRoot, options);
    const message = formatLegacyStubCleanupMessage(cleanup);
    if (message) {
      console.log(message);
    }
    return cleanup;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function emptyStubSync(workspaceRoot: string): StubSyncResult {
  return {
    cursor: {
      created: 0,
      updated: 0,
      removed: 0,
      dir: path.join(workspaceRoot, '.cursor', 'rules', 'agent-deck-stubs'),
    },
    claude: { created: 0, updated: 0, removed: 0, dirs: [] },
  };
}

function parseUseClient(value: string | undefined): UseClientTarget | null {
  if (!value || value === 'both') {
    return 'both';
  }
  if (value === 'cursor' || value === 'claude' || value === 'codex' || value === 'muse') {
    return value;
  }
  return null;
}

export function parseUseArgs(args: string[]): UseOptions | { error: string } {
  let deckRef: string | undefined;
  let refresh = false;
  let clients: UseClientTarget = 'both';
  let host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  let mcpPort = parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  let skipMcp = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--refresh') {
      refresh = true;
    } else if (arg === '--client') {
      const parsed = parseUseClient(args[++i]);
      if (!parsed) {
        return { error: '--client must be cursor, claude, codex, muse, or both' };
      }
      clients = parsed;
    } else if (arg === '--host') {
      host = args[++i] ?? host;
    } else if (arg === '--mcp-port') {
      mcpPort = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '--no-mcp') {
      skipMcp = true;
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown use option: ${arg}` };
    } else if (!deckRef) {
      deckRef = arg;
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }

  if (!refresh && !deckRef) {
    return { error: 'deck name or id is required (or pass --refresh)' };
  }

  if (!Number.isFinite(mcpPort)) {
    return { error: '--mcp-port must be a number' };
  }

  return {
    deckRef,
    refresh,
    clients,
    host,
    mcpPort,
    skipMcp,
    workspaceRoot: process.cwd(),
  };
}

function clientsToWrite(target: UseClientTarget): McpClient[] {
  if (target === 'cursor') {
    return ['cursor'];
  }
  if (target === 'claude') {
    return ['claude'];
  }
  if (target === 'codex') {
    return ['codex'];
  }
  if (target === 'muse') {
    return ['muse'];
  }
  // Legacy `both` keeps its name but now covers cursor, claude, and codex.
  return ['cursor', 'claude', 'codex'];
}

/** Codex and Muse write no Cursor- or Claude-only stub files. */
function stubTargets(target: UseClientTarget): { cursor: boolean; claude: boolean } {
  return {
    cursor: target === 'cursor' || target === 'both',
    claude: target === 'claude' || target === 'both',
  };
}

function writeProjectMcpConfigs(
  parsed: UseOptions,
  endpoint: McpEndpoint,
): Array<{ client: McpClient; path: string }> {
  const mcpWritten: Array<{ client: McpClient; path: string }> = [];
  if (parsed.skipMcp) {
    return mcpWritten;
  }
  for (const client of clientsToWrite(parsed.clients)) {
    const configPath = resolveConfigPath(client, 'project', parsed.workspaceRoot);
    if (client === 'codex') {
      const section = formatCodexMcpSection(
        buildCodexAgentDeckEntry(endpoint, { workspaceRoot: parsed.workspaceRoot }),
      );
      writeTextFile(configPath, mergeCodexTomlConfig(readTextFile(configPath), section));
      mcpWritten.push({ client, path: configPath });
      continue;
    }
    // NOT-571: Muse takes the same headed per-folder HTTP entry as
    // Claude — the same file, the same shape, no more collision.
    const entry = buildAgentDeckEntry(client, endpoint, {
      workspaceRoot: parsed.workspaceRoot,
    });
    const merged = mergeMcpServerConfig(readJsonFile(configPath), entry);
    writeJsonFile(configPath, merged);
    mcpWritten.push({ client, path: configPath });
  }
  return mcpWritten;
}

/** True when `folder` sits inside a git working tree (`.git` here or above). */
function isInsideGitRepository(folder: string): boolean {
  let current = path.resolve(folder);
  for (;;) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) {
        return true;
      }
    } catch {
      return false;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/**
 * NOT-571 post-write warnings for the Muse per-folder entry. Both warn
 * without failing: the assignment and `.mcp.json` are already written.
 * A missing or unparsable user settings file simply skips the legacy
 * check — `use` must not fail on it.
 */
function warnMuseProjectEntry(workspaceRoot: string): void {
  if (!isInsideGitRepository(workspaceRoot)) {
    console.warn(
      `Muse MCP: ${workspaceRoot} is not inside a git repository — Muse loads .mcp.json only inside a repository, so the project entry will not load here.`,
    );
    console.warn('  Run `git init` (or move into a repository), trust the folder, then reload MCP.');
  }
  const userSettingsPath = resolveConfigPath('muse', 'global');
  let userEntry: unknown;
  try {
    const servers = readJsonFile(userSettingsPath).mcpServers;
    userEntry =
      servers && typeof servers === 'object' && !Array.isArray(servers)
        ? (servers as Record<string, unknown>)['agent-deck']
        : undefined;
  } catch {
    userEntry = undefined;
  }
  if (isMcpLaunchEntry(userEntry)) {
    console.warn(
      `Muse MCP: ${userSettingsPath} still holds Agent Deck's legacy launcher entry, which Muse rejects against the project HTTP entry (invalid_transport_combination) — agent-deck is omitted in this folder.`,
    );
    console.warn(
      '  Re-run `agent-deck setup --client muse` to replace it with the headerless HTTP fallback, then reload MCP.',
    );
  }
}

/** Emit Muse post-write warnings only when this run actually wrote the Muse entry. */
function maybeWarnMuse(parsed: UseOptions, result: UseResult): void {
  if (result.mcp.some((entry) => entry.client === 'muse')) {
    warnMuseProjectEntry(parsed.workspaceRoot);
  }
}

/**
 * Workspace-only repair when the home store is unwritable but `.agent-deck/use.json`
 * already assigns the requested deck (typical Cursor agent sandbox).
 */
async function runUseWorkspaceOnlyRepair(
  parsed: UseOptions,
  assignment: AssignmentFields,
  endpoint: McpEndpoint,
  mcpUrl: string,
): Promise<UseResult | { error: string }> {
  const deck = { id: assignment.deckId, name: assignment.deckName };
  const manifestPath = await writeAssignment(parsed.workspaceRoot, {
    deckId: deck.id,
    deckName: deck.name,
    mcpUrl,
  });
  // NOT-567: `use` writes per-folder entries only. The global headerless
  // fallback is `setup`'s job and is never touched here.
  const mcpWritten = writeProjectMcpConfigs(parsed, endpoint);
  ensureGitExcluded(parsed.workspaceRoot);
  const stubs = emptyStubSync(parsed.workspaceRoot);
  const cleanup = cleanupLegacyStubs(parsed.workspaceRoot, stubTargets(parsed.clients));
  if ('error' in cleanup) {
    return cleanup;
  }
  stubs.cursor.removed += cleanup.cursor.removed;
  stubs.claude.removed += cleanup.claude.removed;
  stubs.claude.dirs.push(...cleanup.claude.dirs);
  console.log(
    'Sandbox-safe repair: updated workspace MCP / assignment without writing ~/.agent-deck (home store blocked).',
  );
  console.log('  Playbook discovery is runtime-only (get_bound_deck/get_playbook) — no stub refresh step.');
  return {
    deck,
    mcpUrl,
    manifestPath,
    mcp: mcpWritten,
    stubs,
    playbookCount: 0,
    sandboxSafeRepair: true,
  };
}

async function runUseFullPath(
  parsed: UseOptions,
  deckRef: string,
  endpoint: McpEndpoint,
  mcpUrl: string,
): Promise<UseResult | { error: string }> {
  const admin = createCollectionAdmin();
  const deck = await admin.resolveDeck(deckRef);
  if (!deck) {
    return { error: `Deck not found: ${deckRef}` };
  }

  const playbooks = await admin.listDeckPlaybookStubs(deck.id);

  const manifestPath = await writeAssignment(parsed.workspaceRoot, {
    deckId: deck.id,
    deckName: deck.name,
    mcpUrl,
  });

  const mcpWritten = writeProjectMcpConfigs(parsed, endpoint);

  const stubs = syncPlaybookStubs(parsed.workspaceRoot, playbooks, stubTargets(parsed.clients));
  const cleanup = cleanupLegacyStubs(parsed.workspaceRoot, stubTargets(parsed.clients));
  if ('error' in cleanup) {
    return cleanup;
  }
  stubs.cursor.removed += cleanup.cursor.removed;
  stubs.claude.removed += cleanup.claude.removed;
  stubs.claude.dirs.push(...cleanup.claude.dirs);
  ensureGitExcluded(parsed.workspaceRoot);

  return {
    deck,
    mcpUrl,
    manifestPath,
    mcp: mcpWritten,
    stubs,
    playbookCount: playbooks.length,
  };
}

export async function runUse(parsed: UseOptions): Promise<UseResult | { error: string }> {
  if (parsed.refresh) {
    const cleanup = cleanupLegacyStubs(parsed.workspaceRoot);
    if ('error' in cleanup) {
      return cleanup;
    }
    const assignment = await readAssignment(parsed.workspaceRoot);
    const legacy = readLegacyUseManifestV1(parsed.workspaceRoot);
    const inspection = inspectCursorMcpConfig({
      cwd: parsed.workspaceRoot,
      endpoint: { host: parsed.host, mcpPort: parsed.mcpPort },
    });
    console.log(formatCursorMcpInspection(inspection));
    if (assignment) {
      console.log(`Bound deck: ${assignment.deckName} (${assignment.deckId})`);
      console.log('Assignment: .agent-deck/use.json (folder → deck)');
      console.log('To change deck, run: agent-deck use <deck>');
      return { error: 'refresh-diagnosis-only' };
    }
    if (legacy) {
      console.log(`Legacy manifest deck: ${legacy.deckName} (${legacy.deckId})`);
      console.log(`Run explicitly: agent-deck use ${legacy.deckName}`);
      return { error: 'refresh-diagnosis-only' };
    }
    console.log('No deck assignment — run: agent-deck use <deck>');
    return { error: 'refresh-diagnosis-only' };
  }

  const deckRef = parsed.deckRef;
  if (!deckRef) {
    return { error: 'deck name or id is required' };
  }

  const endpoint = { host: parsed.host, mcpPort: parsed.mcpPort };
  const mcpUrl = buildMcpUrl(endpoint);

  try {
    const result = await runUseFullPath(parsed, deckRef, endpoint, mcpUrl);
    if (!('error' in result)) {
      maybeWarnMuse(parsed, result);
    }
    return result;
  } catch (error) {
    if (!isHomeStoreWriteError(error)) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const assignment = await readAssignment(parsed.workspaceRoot);
    if (assignment && assignmentMatchesDeckRef(assignment, deckRef)) {
      const repaired = await runUseWorkspaceOnlyRepair(parsed, assignment, endpoint, mcpUrl);
      if (!('error' in repaired)) {
        maybeWarnMuse(parsed, repaired);
      }
      return repaired;
    }
    return { error: formatHomeStoreWriteBlockedMessage(detail) };
  }
}

export function formatUseSummary(result: UseResult): string {
  const lines = [
    `Deck "${result.deck.name}" (${result.deck.id})`,
    `Manifest → ${result.manifestPath}`,
    `MCP → ${result.mcpUrl}`,
  ];
  for (const entry of result.mcp) {
    lines.push(`  ${entry.client}: ${entry.path}`);
  }
  if (result.sandboxSafeRepair) {
    lines.push('Mode: sandbox-safe workspace repair (home store not written)');
  }
  lines.push(
    `Stubs: ${result.playbookCount} playbook(s) — cursor +${result.stubs.cursor.created} ~${result.stubs.cursor.updated} -${result.stubs.cursor.removed}; claude +${result.stubs.claude.created} ~${result.stubs.claude.updated} -${result.stubs.claude.removed}`,
  );
  lines.push(`Cursor stubs → ${path.join('.cursor', 'rules', 'agent-deck-stubs')}`);
  lines.push(`Claude stubs → ${path.join('.claude', 'skills', 'agent-deck-<slug>')}`);
  const written = new Set(result.mcp.map((entry) => entry.client));
  if (written.has('cursor')) {
    lines.push(
      'Cursor: approve the project agent-deck server (.cursor/mcp.json) when prompted, then reload MCP.',
    );
  }
  if (written.has('claude')) {
    lines.push(
      'Claude Code: approve the project agent-deck entry (.mcp.json) when prompted, then reload MCP.',
    );
  }
  if (written.has('codex')) {
    lines.push(
      'Codex: trust this folder so .codex/config.toml applies, then reload MCP (start a new task).',
    );
  }
  if (written.has('muse')) {
    lines.push(
      'Muse: trust this folder so the project agent-deck entry (.mcp.json) loads, then reload MCP (restart Muse).',
    );
  }
  lines.push('Restart the IDE host so MCP and stub discovery reload.');
  return lines.join('\n');
}

export async function runUseCommand(args: string[]): Promise<number> {
  const parsed = parseUseArgs(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      console.log(`Usage:
  agent-deck use <deck> [--client cursor|claude|codex|muse|both] [--host HOST] [--mcp-port PORT] [--no-mcp]
  agent-deck use --refresh

Writes project MCP config (one agent-deck entry), .agent-deck/use.json, and thin playbook trigger stubs.
Bodies stay on the deck — stubs are pointers only.`);
      return 0;
    }
    console.error(parsed.error);
    return 1;
  }

  const result = await runUse(parsed);
  if ('error' in result) {
    if (result.error === 'refresh-diagnosis-only') {
      return 0;
    }
    console.error(result.error);
    return 1;
  }

  console.log(formatUseSummary(result));
  return 0;
}
