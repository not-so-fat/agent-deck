import fs from 'node:fs/promises';
import path from 'node:path';
import {
  StoreManifestSchema,
  type StoreDeck,
  type StoreManifest,
} from '@agent-deck/shared';
import { resolveAgentDeckHome } from '../lib/paths';
import { writeFileAtomic } from './atomic-write';
import { parseDeckJson, parseDeckMarkdown, serializeDeck } from './deck-codec';
import { storePaths } from './paths';

export type StoreV1ToV2Result = {
  migrated: boolean;
  /** Number of v1 deck files converted (0 when already v2). */
  decks: number;
  /** Files written or removed by the migration (empty on no-op). */
  paths: string[];
};

const NOOP: StoreV1ToV2Result = { migrated: false, decks: 0, paths: [] };

function metadataOf(deck: StoreDeck) {
  return {
    id: deck.id,
    name: deck.name,
    serviceIds: deck.serviceIds,
    credentialIds: deck.credentialIds,
    playbookIds: deck.playbookIds,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
  };
}

function sameMetadata(a: StoreDeck, b: StoreDeck): boolean {
  return JSON.stringify(metadataOf(a)) === JSON.stringify(metadataOf(b));
}

async function readManifestVersion(
  manifestPath: string,
): Promise<{ version: 1 | 2; migratedFrom?: 'sqlite' } | null> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid store manifest JSON at ${manifestPath}: ${detail}`);
  }
  const manifest = StoreManifestSchema.safeParse(json);
  if (!manifest.success) {
    throw new Error(
      `Unsupported or invalid store manifest at ${manifestPath}: ${manifest.error.message}`,
    );
  }
  return {
    version: manifest.data.version,
    ...(manifest.data.migratedFrom
      ? { migratedFrom: manifest.data.migratedFrom }
      : {}),
  };
}

async function listDeckJsonFiles(decksDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(decksDir);
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(decksDir, name));
}

/**
 * Convert a v1 store (`decks/<id>.json`, manifest version 1) to v2
 * (`decks/<id>.md` with an empty instructions body, manifest version 2).
 *
 * Deterministic (sorted file order, byte-identical metadata), idempotent (a
 * v2 manifest is a no-op), and crash-recoverable: each deck is converted with
 * an atomic Markdown write followed by the legacy JSON delete, and the
 * manifest bump lands last — so rerunning after a crash either resumes the
 * remaining files or finishes by deleting a JSON whose Markdown twin already
 * carries identical metadata. Anything ambiguous (unparseable JSON, duplicate
 * deck ids, a Markdown twin with different metadata) fails closed naming the
 * concrete paths, before the manifest is touched.
 */
export async function migrateStoreV1ToV2(
  home = resolveAgentDeckHome(),
): Promise<StoreV1ToV2Result> {
  const paths = storePaths(home);
  const manifest = await readManifestVersion(paths.manifest);
  if (!manifest || manifest.version === 2) {
    return { ...NOOP };
  }

  const jsonFiles = await listDeckJsonFiles(paths.decksDir);

  // Parse everything first so a broken file aborts before anything is written.
  const records = new Map<string, { source: string; deck: StoreDeck }>();
  for (const source of jsonFiles) {
    let deck: StoreDeck;
    try {
      deck = parseDeckJson(await fs.readFile(source, 'utf8'));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot migrate legacy deck file ${source}: ${detail}`);
    }
    const seen = records.get(deck.id);
    if (seen) {
      throw new Error(
        `Cannot migrate legacy deck files: duplicate deck id "${deck.id}" in ${seen.source} and ${source}`,
      );
    }
    records.set(deck.id, { source, deck });
  }

  const changed: string[] = [];
  let converted = 0;
  // Records were inserted in sorted source order, so this loop is deterministic.
  for (const { source, deck } of records.values()) {
    const target = path.join(paths.decksDir, `${deck.id}.md`);
    let twin: string | null = null;
    try {
      twin = await fs.readFile(target, 'utf8');
    } catch (error: unknown) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
    if (twin !== null) {
      // Crash-recovery resume: the Markdown twin is only trusted when its
      // metadata is exactly what the JSON convert would have written.
      let existing: StoreDeck;
      try {
        existing = parseDeckMarkdown(twin);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Cannot migrate legacy deck file ${source}: existing ${target} is invalid: ${detail}`,
        );
      }
      if (!sameMetadata(existing, deck)) {
        throw new Error(
          `Cannot migrate legacy deck file ${source}: existing ${target} carries different deck metadata`,
        );
      }
    } else {
      await writeFileAtomic(target, serializeDeck(deck));
      changed.push(target);
    }
    await fs.unlink(source);
    changed.push(source);
    converted += 1;
  }

  const next: StoreManifest = {
    format: 'agent-deck-store',
    version: 2,
    ...(manifest.migratedFrom ? { migratedFrom: manifest.migratedFrom } : {}),
  };
  await writeFileAtomic(paths.manifest, `${JSON.stringify(next, null, 2)}\n`);
  changed.push(paths.manifest);

  return { migrated: true, decks: converted, paths: changed };
}
