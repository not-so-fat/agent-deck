import fs from 'node:fs/promises';
import { resolveAgentDeckHome } from '../lib/paths';
import { DatabaseManager, STORE_CONTENT_HASH } from '../models/database';
import { hashStoreTree } from './content-hash';
import { migrateSqliteToStore } from './migrate';
import { storePaths } from './paths';
import { reindexStoreToSqlite } from './reindex';

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
          reindexed = true;
        }
      }
    } catch (error: unknown) {
      console.error(
        'Store reindex failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return { migrated, reindexed };
}
