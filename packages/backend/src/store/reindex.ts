import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { StoreManifestSchema } from '@agent-deck/shared';
import {
  DatabaseManager,
  STORE_LAST_REINDEX,
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

/** Last reindex outcome, persisted in store meta so `status`/`doctor` can surface a silent failure. */
export type StoreReindexRecord = {
  at: string;
  ok: boolean;
  error?: string;
  warnings: string[];
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

function collisions<T>(
  kind: string,
  entries: ParsedFile<T>[],
  select: (value: T) => string,
): StoreConflict[] {
  const pathsByValue = new Map<string, string[]>();
  for (const entry of entries) {
    const value = select(entry.value);
    pathsByValue.set(value, [...(pathsByValue.get(value) ?? []), entry.path]);
  }
  return [...pathsByValue.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([value, paths]) => ({
      kind,
      value,
      paths: paths.sort(),
    }));
}

/**
 * Display names are cosmetic — ids are what the store keys on — so a collision
 * must not drop the whole store→sqlite import (NOT-123). SQLite still holds a
 * UNIQUE index per display name, so later files are imported under a suffixed
 * name (same policy as the dedupe migration) and every card survives.
 */
function dedupeDisplayNames<T>(
  kind: string,
  entries: ParsedFile<T>[],
  read: (value: T) => string,
  rename: (value: T, name: string) => T,
): { values: T[]; warnings: string[] } {
  const duplicated = new Set(
    collisions(kind, entries, read).map(({ value }) => value),
  );
  if (duplicated.size === 0) {
    return { values: entries.map(({ value }) => value), warnings: [] };
  }

  const used = new Set(entries.map(({ value }) => read(value)));
  const renamedByName = new Map<string, string[]>();
  const pathsByName = new Map<string, string[]>();
  const values: T[] = [];

  for (const entry of entries) {
    const name = read(entry.value);
    if (!duplicated.has(name)) {
      values.push(entry.value);
      continue;
    }

    pathsByName.set(name, [...(pathsByName.get(name) ?? []), entry.path]);
    // First file (store files are read in sorted order) keeps the name as written.
    if (pathsByName.get(name)?.length === 1) {
      values.push(entry.value);
      continue;
    }

    let candidate = `${name} (imported)`;
    for (let n = 2; used.has(candidate); n += 1) {
      candidate = `${name} (imported ${n})`;
    }
    used.add(candidate);
    renamedByName.set(name, [
      ...(renamedByName.get(name) ?? []),
      `${entry.path} -> "${candidate}"`,
    ]);
    values.push(rename(entry.value, candidate));
  }

  const warnings = [...pathsByName.entries()].map(
    ([name, paths]) =>
      `Duplicate ${kind} name "${name}" in ${paths.length} store files: ${paths.join(', ')}` +
      ` — ids are unique, so all were imported; renamed in SQLite: ` +
      `${(renamedByName.get(name) ?? []).join(', ')}`,
  );
  return { values, warnings };
}

function missingDeckReferences(snapshot: StoreSnapshot): string[] {
  const serviceIds = new Set(snapshot.services.map(({ id }) => id));
  const credentialIds = new Set(snapshot.credentials.map(({ id }) => id));
  const playbookIds = new Set(snapshot.playbooks.map(({ id }) => id));
  const errors: string[] = [];

  for (const service of snapshot.services) {
    if (service.credentialId && !credentialIds.has(service.credentialId)) {
      errors.push(
        `Service "${service.name}" references missing credential "${service.credentialId}"`,
      );
    }
  }

  for (const deck of snapshot.decks) {
    for (const serviceId of deck.serviceIds) {
      if (!serviceIds.has(serviceId)) {
        errors.push(`Deck "${deck.name}" references missing service "${serviceId}"`);
      }
    }
    for (const credentialId of deck.credentialIds) {
      if (!credentialIds.has(credentialId)) {
        errors.push(
          `Deck "${deck.name}" references missing credential "${credentialId}"`,
        );
      }
    }
    for (const playbookId of deck.playbookIds) {
      if (!playbookIds.has(playbookId)) {
        errors.push(
          `Deck "${deck.name}" references missing playbook "${playbookId}"`,
        );
      }
    }
  }

  return errors;
}

async function runReindex(
  db: DatabaseManager,
  opts: { home?: string; force?: boolean },
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

  // Two files claiming one id are genuinely ambiguous — one would silently
  // overwrite the other in the snapshot — so those still fail closed.
  const idConflicts = [
    ...collisions('service', services.entries, ({ id }) => id),
    ...collisions('credential', credentials.entries, ({ id }) => id),
    ...collisions('playbook', playbooks.entries, ({ id }) => id),
    ...collisions('deck', decks.entries, ({ id }) => id),
  ];
  if (idConflicts.length > 0) {
    return {
      ok: false,
      error: 'Duplicate ids found in store files',
      conflicts: idConflicts,
    };
  }

  const namedServices = dedupeDisplayNames(
    'service',
    services.entries,
    ({ name }) => name,
    (value, name) => ({ ...value, name }),
  );
  const namedCredentials = dedupeDisplayNames(
    'credential',
    credentials.entries,
    ({ label }) => label,
    (value, label) => ({ ...value, label }),
  );
  const namedPlaybooks = dedupeDisplayNames(
    'playbook',
    playbooks.entries,
    ({ title }) => title,
    (value, title) => ({ ...value, title }),
  );
  const namedDecks = dedupeDisplayNames(
    'deck',
    decks.entries,
    ({ name }) => name,
    (value, name) => ({ ...value, name }),
  );
  const warnings = [
    ...namedServices.warnings,
    ...namedCredentials.warnings,
    ...namedPlaybooks.warnings,
    ...namedDecks.warnings,
  ];

  const snapshot: StoreSnapshot = {
    services: namedServices.values,
    credentials: namedCredentials.values,
    playbooks: namedPlaybooks.values,
    decks: namedDecks.values,
  };
  const referenceErrors = missingDeckReferences(snapshot);
  if (referenceErrors.length > 0) {
    return {
      ok: false,
      error: `Store deck reference validation failed:\n${referenceErrors.join('\n')}`,
    };
  }

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
    warnings,
    contentHash,
  };
}

/**
 * Store→sqlite import. Records the outcome in store meta on every path so a
 * failure that only ever reached `backend.log` still shows up in `status`/`doctor`.
 */
export async function reindexStoreToSqlite(
  db: DatabaseManager,
  opts: { home?: string; force?: boolean } = {},
): Promise<StoreReindexResult> {
  const result = await runReindex(db, opts);
  recordReindexOutcome(db, result);
  return result;
}

export function recordReindexOutcome(
  db: DatabaseManager,
  result: StoreReindexResult | { ok: false; error: string },
): void {
  const record: StoreReindexRecord = result.ok
    ? { at: new Date().toISOString(), ok: true, warnings: result.warnings }
    : { at: new Date().toISOString(), ok: false, error: result.error, warnings: [] };
  try {
    db.setStoreMeta(STORE_LAST_REINDEX, JSON.stringify(record));
  } catch {
    // Never let bookkeeping mask the reindex result itself.
  }
}

export function readLastReindex(db: DatabaseManager): StoreReindexRecord | null {
  return parseReindexRecord(db.getStoreMeta(STORE_LAST_REINDEX));
}

/** Split out so a read-only reader can parse the meta row without a DatabaseManager. */
export function parseReindexRecord(raw: string | null): StoreReindexRecord | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoreReindexRecord>;
    if (typeof parsed?.at !== 'string' || typeof parsed?.ok !== 'boolean') {
      return null;
    }
    return {
      at: parsed.at,
      ok: parsed.ok,
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    };
  } catch {
    return null;
  }
}
