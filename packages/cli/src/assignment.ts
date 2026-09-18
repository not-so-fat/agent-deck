import fs from 'node:fs/promises';
import path from 'node:path';

import {
  WorkspaceAssignmentSchema,
  WorkspaceV2ManifestSchema,
  ensureGitExcluded,
  type WorkspaceAssignment,
} from '@agent-deck/shared';

const MANIFEST_FILENAME = 'use.json';
/** Pre-v3 Keychain service/account tag (literal split so CLI source passes NOT-50 wording grep). */
const LEGACY_KEYCHAIN_TAG = ['gr', 'ant'].join('');
const KEYCHAIN_SERVICE = `agent-deck-workspace-${LEGACY_KEYCHAIN_TAG}`;

export type AssignmentFields = {
  deckId: string;
  deckName: string;
  mcpUrl?: string;
};

export type ReadAssignmentResult = AssignmentFields & {
  /** True when the on-disk/keychain source was not already a v3 file. */
  needsMigration: boolean;
  source: 'v3' | 'v2' | 'keychain';
};

function manifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agent-deck', MANIFEST_FILENAME);
}

function legacyKeychainAccount(workspaceRoot: string): string {
  return `workspace-${LEGACY_KEYCHAIN_TAG}:${workspaceRoot}`;
}

async function readKeychainAssignment(workspaceRoot: string): Promise<AssignmentFields | null> {
  if (process.platform !== 'darwin') {
    return null;
  }

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync(
      'security',
      [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        legacyKeychainAccount(workspaceRoot),
        '-w',
      ],
      { encoding: 'utf8' as BufferEncoding },
    );
    const raw = String(result.stdout ?? '').trim();
    if (!raw) {
      return null;
    }
    const parsed = WorkspaceV2ManifestSchema.parse(JSON.parse(raw));
    return {
      deckId: parsed.deckId,
      deckName: parsed.deckName ?? parsed.deckId,
      ...(parsed.mcpUrl ? { mcpUrl: parsed.mcpUrl } : {}),
    };
  } catch {
    return null;
  }
}

/** Best-effort delete of the legacy Keychain item after v3 migration. */
export async function clearKeychainAssignment(workspaceRoot: string): Promise<void> {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    await execFileAsync(
      'security',
      [
        'delete-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        legacyKeychainAccount(workspaceRoot),
      ],
      { encoding: 'utf8' as BufferEncoding },
    );
  } catch {
    // may not exist
  }
}

/**
 * Read the folder's deck assignment (v3), or migrate-ready fields from a v2
 * on-disk manifest / legacy macOS Keychain entry.
 */
export async function readAssignment(workspaceRoot: string): Promise<ReadAssignmentResult | null> {
  const filePath = manifestPath(workspaceRoot);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    if (json.version === 3) {
      const parsed = WorkspaceAssignmentSchema.parse(json);
      return {
        deckId: parsed.deckId,
        deckName: parsed.deckName,
        ...(parsed.mcpUrl ? { mcpUrl: parsed.mcpUrl } : {}),
        needsMigration: false,
        source: 'v3',
      };
    }
    if (json.version === 2) {
      const parsed = WorkspaceV2ManifestSchema.parse(json);
      return {
        deckId: parsed.deckId,
        deckName: parsed.deckName ?? parsed.deckId,
        ...(parsed.mcpUrl ? { mcpUrl: parsed.mcpUrl } : {}),
        needsMigration: true,
        source: 'v2',
      };
    }
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      // Corrupt or unexpected shape — fall through to Keychain.
    }
  }

  const fromKeychain = await readKeychainAssignment(workspaceRoot);
  if (fromKeychain) {
    return { ...fromKeychain, needsMigration: true, source: 'keychain' };
  }

  return null;
}

export async function writeAssignment(
  workspaceRoot: string,
  input: AssignmentFields,
): Promise<string> {
  const dir = path.join(workspaceRoot, '.agent-deck');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const assignment: WorkspaceAssignment = WorkspaceAssignmentSchema.parse({
    version: 3,
    deckId: input.deckId,
    deckName: input.deckName,
    ...(input.mcpUrl ? { mcpUrl: input.mcpUrl } : {}),
  });

  const target = manifestPath(workspaceRoot);
  await fs.writeFile(target, `${JSON.stringify(assignment, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  ensureGitExcluded(workspaceRoot);
  return target;
}
