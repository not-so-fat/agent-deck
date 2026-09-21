import fs from 'node:fs';
import path from 'node:path';
import { ensureGitExcluded } from '@agent-deck/shared';

/**
 * NOT-206: bind/switch-time synchronization no longer generates deck-specific
 * playbook stub files. Playbook triggers and bodies live only on the bound
 * deck and are discovered at runtime (`get_bound_deck` lists triggers,
 * `get_playbook` fetches bodies), so switching decks never requires
 * regenerating workspace files. Legacy stub files already present in a
 * workspace are removed by `removeLegacyPlaybookStubs` (NOT-208), which
 * `agent-deck setup` / `agent-deck use` run as a one-time migration.
 */
export const CURSOR_STUBS_DIR = 'agent-deck-stubs';
export const CLAUDE_SKILL_PREFIX = 'agent-deck-';

/**
 * Markers written by the pre-NOT-206 stub generator. A file carrying both
 * markers is provably Agent Deck-managed; anything else is user-authored
 * (or foreign) and must never be touched by cleanup.
 */
export const STUB_MARKER_START_PREFIX = '<!-- agent-deck:stub:start';
export const STUB_MARKER_END = '<!-- agent-deck:stub:end -->';

/** True only for content the Agent Deck stub generator wrote. */
export function isManagedStubContent(content: string): boolean {
  return content.includes(STUB_MARKER_START_PREFIX) && content.includes(STUB_MARKER_END);
}

export type PlaybookStubInput = {
  id: string;
  title: string;
  triggers: string[];
};

export type StubSyncCounts = {
  created: number;
  updated: number;
  removed: number;
};

export type StubSyncResult = {
  cursor: StubSyncCounts & { dir: string };
  claude: StubSyncCounts & { dirs: string[] };
};

export type StubBindSyncResult = {
  stubs: StubSyncResult;
  host_reload_required: boolean;
  manifestPath?: string;
};

export type StubSyncOptions = {
  cursor?: boolean;
  claude?: boolean;
};

export function isStubSyncEnabled(): boolean {
  return process.env.AGENT_DECK_STUB_SYNC?.toLowerCase() !== 'off';
}

/**
 * Static no-op: report zero stub changes without reading or writing any
 * per-playbook files. Callers (bind/switch handlers, `agent-deck use`,
 * patch-accept sync) keep their call sites and payload shapes; runtime
 * discovery through `get_bound_deck` / `get_playbook` needs nothing on disk.
 */
export function syncPlaybookStubs(
  workspaceRoot: string,
  _playbooks: PlaybookStubInput[],
  _options: StubSyncOptions = {},
): StubSyncResult {
  return {
    cursor: {
      created: 0,
      updated: 0,
      removed: 0,
      dir: path.join(workspaceRoot, '.cursor', 'rules', CURSOR_STUBS_DIR),
    },
    claude: { created: 0, updated: 0, removed: 0, dirs: [] },
  };
}

export type LegacyStubCleanupOptions = {
  cursor?: boolean;
  claude?: boolean;
};

export type LegacyStubCleanupResult = {
  cursor: { removed: number; dir: string };
  claude: { removed: number; dirs: string[] };
  removedPaths: string[];
};

function cleanupFailureMessage(failures: Array<{ path: string; reason: string }>): string {
  const details = failures.map((failure) => `${failure.path}: ${failure.reason}`).join('; ');
  return `Failed to remove legacy Agent Deck playbook stub(s): ${details}`;
}

/**
 * NOT-208: one-time migration that removes Agent Deck-managed legacy
 * playbook stubs left by the pre-NOT-206 generator. Only files whose
 * content carries both stub markers are removed:
 *
 * - `<workspace>/.cursor/rules/agent-deck-stubs/` entries (regular files only)
 * - `<workspace>/.claude/skills/agent-deck-<slug>/SKILL.md` (whole skill dir)
 *
 * User-authored skills, rules, and instructions are preserved — including
 * similarly named files that lack the markers. Idempotent: absent
 * files/directories are a no-op. Throws an Error naming the exact
 * path(s) when a managed file cannot be removed; files already removed
 * before the failure stay removed, unrelated files are never touched.
 */
export function removeLegacyPlaybookStubs(
  workspaceRoot: string,
  options: LegacyStubCleanupOptions = {},
): LegacyStubCleanupResult {
  const cleanCursor = options.cursor !== false;
  const cleanClaude = options.claude !== false;
  const cursorDir = path.join(workspaceRoot, '.cursor', 'rules', CURSOR_STUBS_DIR);
  const claudeSkillsRoot = path.join(workspaceRoot, '.claude', 'skills');
  const result: LegacyStubCleanupResult = {
    cursor: { removed: 0, dir: cursorDir },
    claude: { removed: 0, dirs: [] },
    removedPaths: [],
  };
  const failures: Array<{ path: string; reason: string }> = [];

  if (cleanCursor && fs.existsSync(cursorDir)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(cursorDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(cursorDir, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        // Unreadable: cannot prove it is managed, so leave it untouched.
        continue;
      }
      if (!isManagedStubContent(content)) {
        continue;
      }
      try {
        fs.unlinkSync(filePath);
        result.cursor.removed += 1;
        result.removedPaths.push(filePath);
      } catch (error) {
        failures.push({
          path: filePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Drop the now-empty managed dir; never recurse or touch anything else.
    try {
      if (fs.existsSync(cursorDir) && fs.readdirSync(cursorDir).length === 0) {
        fs.rmdirSync(cursorDir);
      }
    } catch {
      // Best effort: a non-empty or locked dir simply stays.
    }
  }

  if (cleanClaude && fs.existsSync(claudeSkillsRoot)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(claudeSkillsRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(CLAUDE_SKILL_PREFIX)) {
        continue;
      }
      const skillDir = path.join(claudeSkillsRoot, entry.name);
      const skillPath = path.join(skillDir, 'SKILL.md');
      let content: string;
      try {
        if (!fs.existsSync(skillPath)) {
          continue;
        }
        content = fs.readFileSync(skillPath, 'utf8');
      } catch {
        // Unreadable: cannot prove it is managed, so leave it untouched.
        continue;
      }
      if (!isManagedStubContent(content)) {
        continue;
      }
      try {
        fs.rmSync(skillDir, { recursive: true, force: true });
        result.claude.removed += 1;
        result.claude.dirs.push(skillDir);
        result.removedPaths.push(skillDir);
      } catch (error) {
        failures.push({
          path: skillDir,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(cleanupFailureMessage(failures));
  }
  return result;
}

/** Folder→deck assignment written by `agent-deck use` and bind stub-sync (NOT-108). */
export type UseManifest = {
  version: 3;
  deckId: string;
  deckName: string;
  mcpUrl?: string;
};

export type LegacyUseManifestV1 = {
  version: 1;
  deckId: string;
  deckName: string;
  mcpUrl: string;
  updatedAt: string;
};

export const USE_MANIFEST_PATH = '.agent-deck/use.json';

function readRawUseJson(workspaceRoot: string): Record<string, unknown> | null {
  const manifestPath = path.join(workspaceRoot, USE_MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readUseManifest(workspaceRoot: string): UseManifest | null {
  const parsed = readRawUseJson(workspaceRoot);
  if (!parsed || parsed.version !== 3 || typeof parsed.deckId !== 'string') {
    return null;
  }
  if (typeof parsed.deckName !== 'string') {
    return null;
  }
  return {
    version: 3,
    deckId: parsed.deckId,
    deckName: parsed.deckName,
    ...(typeof parsed.mcpUrl === 'string' && parsed.mcpUrl.length > 0
      ? { mcpUrl: parsed.mcpUrl }
      : {}),
  };
}

/** Pre-assignment v1 manifest (diagnosis only). */
export function readLegacyUseManifestV1(workspaceRoot: string): LegacyUseManifestV1 | null {
  const parsed = readRawUseJson(workspaceRoot);
  if (!parsed || parsed.version !== 1 || typeof parsed.deckId !== 'string') {
    return null;
  }
  return {
    version: 1,
    deckId: parsed.deckId,
    deckName: typeof parsed.deckName === 'string' ? parsed.deckName : parsed.deckId,
    mcpUrl: typeof parsed.mcpUrl === 'string' ? parsed.mcpUrl : '',
    updatedAt:
      typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
  };
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

export function writeUseManifest(workspaceRoot: string, manifest: UseManifest): string {
  const next: UseManifest = {
    version: 3,
    deckId: manifest.deckId,
    deckName: manifest.deckName,
    ...(manifest.mcpUrl ? { mcpUrl: manifest.mcpUrl } : {}),
  };
  const manifestPath = path.join(workspaceRoot, USE_MANIFEST_PATH);
  writeText(manifestPath, JSON.stringify(next, null, 2));
  return manifestPath;
}

export function stubSyncChanged(result: StubSyncResult): boolean {
  const cursorChanged =
    result.cursor.created + result.cursor.updated + result.cursor.removed > 0;
  const claudeChanged =
    result.claude.created + result.claude.updated + result.claude.removed > 0;
  return cursorChanged || claudeChanged;
}

export function healUseManifest(
  workspaceRoot: string,
  deck: { id: string; name: string },
  mcpUrl?: string,
): string | undefined {
  const existing = readUseManifest(workspaceRoot);
  const raw = readRawUseJson(workspaceRoot);
  const priorMcpUrl =
    mcpUrl ??
    existing?.mcpUrl ??
    (typeof raw?.mcpUrl === 'string' && raw.mcpUrl.length > 0 ? raw.mcpUrl : undefined);
  const next: UseManifest = {
    version: 3,
    deckId: deck.id,
    deckName: deck.name,
    ...(priorMcpUrl ? { mcpUrl: priorMcpUrl } : {}),
  };
  if (
    existing &&
    existing.deckId === next.deckId &&
    existing.deckName === next.deckName &&
    (existing.mcpUrl ?? undefined) === (next.mcpUrl ?? undefined)
  ) {
    return undefined;
  }
  const written = writeUseManifest(workspaceRoot, next);
  ensureGitExcluded(workspaceRoot);
  return written;
}
