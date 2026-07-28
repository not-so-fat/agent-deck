import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager, STORE_CONTENT_HASH } from '../models/database';
import { hashStoreTree } from './content-hash';
import { storePaths } from './paths';
import { ensureStoreReady } from './startup';

const homes: string[] = [];
const databases: DatabaseManager[] = [];

async function createFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-startup-'));
  homes.push(home);
  const database = new DatabaseManager(path.join(home, 'agent_deck.db'));
  databases.push(database);
  return { home, database };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(
    homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })),
  );
});

describe('ensureStoreReady', () => {
  it('migrates a populated database and skips reindex when the hashes match', async () => {
    const { home, database } = await createFixture();
    await database.createService({
      name: 'Startup service',
      type: 'mcp',
      url: 'https://example.com/mcp',
    });

    await expect(ensureStoreReady(database, { home })).resolves.toEqual({
      migrated: true,
      reindexed: false,
    });
    await expect(fs.stat(storePaths(home).manifest)).resolves.toBeDefined();
    expect(database.getStoreMeta(STORE_CONTENT_HASH)).toBe(
      await hashStoreTree(home),
    );
  });

  it('keeps the previous database when changed store files fail validation', async () => {
    const { home, database } = await createFixture();
    const service = await database.createService({
      name: 'Previous service',
      type: 'mcp',
      url: 'https://example.com/mcp',
    });
    await ensureStoreReady(database, { home });
    await fs.writeFile(
      path.join(storePaths(home).servicesDir, `${service.id}.json`),
      '{ invalid json',
      'utf8',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(ensureStoreReady(database, { home })).resolves.toEqual({
      migrated: false,
      reindexed: false,
    });
    await expect(database.getService(service.id)).resolves.toMatchObject({
      name: 'Previous service',
    });
    expect(error).toHaveBeenCalledWith(
      'Store reindex failed:',
      expect.stringContaining('validation failed'),
      undefined,
    );
  });
});
