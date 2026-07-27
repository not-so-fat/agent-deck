import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { StoreManifestSchema } from '@agent-deck/shared';
import {
  DatabaseManager,
  type StoreSnapshot,
} from '../models/database';
import { hashStoreTree } from './content-hash';
import { parseCredentialYaml } from './credential-codec';
import { parseDeckJson } from './deck-codec';
import { storePaths } from './paths';
import { parsePlaybookMarkdown } from './playbook-codec';
import { parseServiceJson } from './service-codec';

type StoreConflict = {
  kind: string;
  value: string;
  paths: string[];
};

export type StoreReindexResult =
  | {
      ok: true;
      counts: {
        playbooks: number;
        services: number;
        credentials: number;
        decks: number;
      };
      warnings: string[];
      contentHash: string;
    }
  | {
      ok: false;
      error: string;
      conflicts?: StoreConflict[];
    };

type ParsedFile<T> = {
  path: string;
  value: T;
};

async function readStoreFiles<T>(
  directory: string,
  parse: (raw: string) => T,
): Promise<{ entries: ParsedFile<T>[]; errors: string[] }> {
  let directoryEntries: Dirent[];
  try {
    directoryEntries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { entries: [], errors: [] };
    }
    throw error;
  }

  const entries: ParsedFile<T>[] = [];
  const errors: string[] = [];
  for (const directoryEntry of directoryEntries
    .filter((entry) => entry.isFile())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const filePath = path.join(directory, directoryEntry.name);
    try {
      entries.push({
        path: filePath,
        value: parse(await fs.readFile(filePath, 'utf8')),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${filePath}: ${message}`);
    }
  }
  return { entries, errors };
}

function displayNameConflicts<T>(
  kind: string,
  entries: ParsedFile<T>[],
  displayName: (value: T) => string,
): StoreConflict[] {
  const pathsByName = new Map<string, string[]>();
  for (const entry of entries) {
    const value = displayName(entry.value);
    pathsByName.set(value, [...(pathsByName.get(value) ?? []), entry.path]);
  }
  return [...pathsByName.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([value, paths]) => ({
      kind,
      value,
      paths: paths.sort(),
    }));
}

export async function reindexStoreToSqlite(
  db: DatabaseManager,
  opts: { home?: string; force?: boolean } = {},
): Promise<StoreReindexResult> {
  const paths = storePaths(opts.home);
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(paths.manifest, 'utf8');
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Store manifest is missing or unreadable: ${detail}` };
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid store manifest JSON: ${detail}` };
  }
  const manifest = StoreManifestSchema.safeParse(manifestJson);
  if (!manifest.success) {
    return {
      ok: false,
      error: `Unsupported or invalid store manifest: ${manifest.error.message}`,
    };
  }

  let parsed;
  try {
    parsed = await Promise.all([
      readStoreFiles(paths.servicesDir, parseServiceJson),
      readStoreFiles(paths.credentialsDir, parseCredentialYaml),
      readStoreFiles(paths.playbooksDir, parsePlaybookMarkdown),
      readStoreFiles(paths.decksDir, parseDeckJson),
    ]);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to read store files: ${detail}` };
  }
  const [services, credentials, playbooks, decks] = parsed;
  const parseErrors = [
    ...services.errors,
    ...credentials.errors,
    ...playbooks.errors,
    ...decks.errors,
  ];
  if (parseErrors.length > 0) {
    return {
      ok: false,
      error: `Store file validation failed:\n${parseErrors.join('\n')}`,
    };
  }

  const conflicts = [
    ...displayNameConflicts('service', services.entries, ({ name }) => name),
    ...displayNameConflicts(
      'credential',
      credentials.entries,
      ({ label }) => label,
    ),
    ...displayNameConflicts('playbook', playbooks.entries, ({ title }) => title),
    ...displayNameConflicts('deck', decks.entries, ({ name }) => name),
  ];
  if (conflicts.length > 0) {
    return {
      ok: false,
      error: 'Duplicate display names found in store files',
      conflicts,
    };
  }

  const snapshot: StoreSnapshot = {
    services: services.entries.map(({ value }) => value),
    credentials: credentials.entries.map(({ value }) => value),
    playbooks: playbooks.entries.map(({ value }) => value),
    decks: decks.entries.map(({ value }) => value),
  };
  const contentHash = await hashStoreTree(opts.home);
  try {
    db.applyStoreSnapshot(snapshot, contentHash);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to apply store snapshot: ${detail}` };
  }

  return {
    ok: true,
    counts: {
      playbooks: snapshot.playbooks.length,
      services: snapshot.services.length,
      credentials: snapshot.credentials.length,
      decks: snapshot.decks.length,
    },
    warnings: [],
    contentHash,
  };
}
