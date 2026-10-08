import fs from 'node:fs/promises';
import { resolveAgentDeckHome } from '../lib/paths';
import { DatabaseManager, STORE_CONTENT_HASH } from '../models/database';
import { hashStoreTree } from './content-hash';
import { migrateSqliteToStore } from './migrate';
import { migrateStoreV1ToV2 } from './migrate-v1-to-v2';
import { storePaths } from './paths';
import { recordReindexOutcome, reindexStoreToSqlite } from './reindex';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

async function databaseHasData(db: DatabaseManager): Promise<boolean> {
  const [services, playbooks, credentials, decks] = await Promise.all([
    db.getAllServices(),
    db.getAllPlaybooks(),
    db.getAllCredentials(),
    db.getAllDecks(),
  ]);
  return (
    services.length > 0 ||
    playbooks.length > 0 ||
    credentials.length > 0 ||
    decks.length > 0
  );
}

export async function ensureStoreReady(
  db: DatabaseManager,
  opts: { home?: string } = {},
): Promise<{ migrated: boolean; reindexed: boolean }> {
  const home = opts.home ?? resolveAgentDeckHome();
  const { manifest } = storePaths(home);
  let migrated = false;
  let reindexed = false;

  // A v1 tree must be converted before the hash comparison: an untouched v1
  // tree hashes exactly as it did before the upgrade, so without this the
  // migration would never trigger and the store would stay v1 forever.
  try {
    await migrateStoreV1ToV2(home);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('Store migration failed:', detail);
    recordReindexOutcome(db, { ok: false, error: detail });
    return { migrated, reindexed };
  }

  if (!(await fileExists(manifest)) && (await databaseHasData(db))) {
    await migrateSqliteToStore(db, { home });
    migrated = true;
  }

  if (await fileExists(manifest)) {
    try {
      const diskHash = await hashStoreTree(home);
      if (diskHash !== db.getStoreMeta(STORE_CONTENT_HASH)) {
        const result = await reindexStoreToSqlite(db, { home, force: true });
        if (!result.ok) {
          console.error('Store reindex failed:', result.error, result.conflicts);
        } else {
          for (const warning of result.warnings) {
            console.warn('Store reindex warning:', warning);
          }
          reindexed = true;
        }
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('Store reindex failed:', detail);
      recordReindexOutcome(db, { ok: false, error: detail });
    }
  }

  return { migrated, reindexed };
}
