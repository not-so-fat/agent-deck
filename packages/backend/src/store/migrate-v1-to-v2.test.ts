import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../models/database';
import { parseDeckMarkdown, serializeDeck } from './deck-codec';
import { migrateStoreV1ToV2 } from './migrate-v1-to-v2';
import { storePaths } from './paths';
import { reindexStoreToSqlite } from './reindex';
import { FileStoreWriter } from './writer';

const homes: string[] = [];
const databases = new Set<DatabaseManager>();

afterEach(async () => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  await Promise.all(
    homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })),
  );
});

const V1_DECKS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'dev',
    serviceIds: ['svc-b', 'svc-a'],
    credentialIds: ['cred_x'],
    playbookIds: ['pb_demo', 'pb_other'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'ops',
    serviceIds: [],
    credentialIds: [],
    playbookIds: [],
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-03-03T00:00:00.000Z',
  },
];

async function writeV1Store(home: string): Promise<void> {
  const paths = storePaths(home);
  await fs.mkdir(paths.decksDir, { recursive: true });
  await fs.writeFile(
    paths.manifest,
    `${JSON.stringify({ format: 'agent-deck-store', version: 1, migratedFrom: 'sqlite' }, null, 2)}\n`,
    'utf8',
  );
  for (const deck of V1_DECKS) {
    await fs.writeFile(
      path.join(paths.decksDir, `${deck.id}.json`),
      `${JSON.stringify(deck, null, 2)}\n`,
      'utf8',
    );
  }
}

async function createV1Home(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-v1-to-v2-'));
  homes.push(home);
  await writeV1Store(home);
  return home;
}

describe('migrateStoreV1ToV2', () => {
  it('converts v1 deck JSON to v2 Markdown with identical metadata and empty bodies', async () => {
    const home = await createV1Home();
    const paths = storePaths(home);

    const result = await migrateStoreV1ToV2(home);

    expect(result.migrated).toBe(true);
    expect(result.decks).toBe(2);
    expect(
      JSON.parse(await fs.readFile(paths.manifest, 'utf8')),
    ).toEqual({
      format: 'agent-deck-store',
      version: 2,
      migratedFrom: 'sqlite',
    });

    for (const original of V1_DECKS) {
      const mdPath = path.join(paths.decksDir, `${original.id}.md`);
      expect(parseDeckMarkdown(await fs.readFile(mdPath, 'utf8'))).toEqual({
        ...original,
        operatingInstructions: '',
      });
      await expect(
        fs.access(path.join(paths.decksDir, `${original.id}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('is a no-op when rerun against the migrated store', async () => {
    const home = await createV1Home();
    const paths = storePaths(home);
    await migrateStoreV1ToV2(home);
    const before = await Promise.all(
      V1_DECKS.map((deck) =>
        fs.readFile(path.join(paths.decksDir, `${deck.id}.md`), 'utf8'),
      ),
    );
    const manifestBefore = await fs.readFile(paths.manifest, 'utf8');

    const result = await migrateStoreV1ToV2(home);

    expect(result).toEqual({ migrated: false, decks: 0, paths: [] });
    await expect(
      Promise.all(
        V1_DECKS.map((deck) =>
          fs.readFile(path.join(paths.decksDir, `${deck.id}.md`), 'utf8'),
        ),
      ),
    ).resolves.toEqual(before);
    await expect(fs.readFile(paths.manifest, 'utf8')).resolves.toBe(
      manifestBefore,
    );
  });

  it('resumes after a crash between the Markdown write and the JSON delete', async () => {
    const home = await createV1Home();
    const paths = storePaths(home);
    // Simulate the crash window: first deck has both twins, second is untouched.
    const [first] = V1_DECKS;
    await fs.writeFile(
      path.join(paths.decksDir, `${first.id}.md`),
      serializeDeck({ ...first, operatingInstructions: '' }),
      'utf8',
    );

    const result = await migrateStoreV1ToV2(home);

    expect(result).toEqual({
      migrated: true,
      decks: 2,
      paths: expect.arrayContaining([paths.manifest]),
    });
    for (const original of V1_DECKS) {
      expect(
        parseDeckMarkdown(
          await fs.readFile(
            path.join(paths.decksDir, `${original.id}.md`),
            'utf8',
          ),
        ),
      ).toEqual({ ...original, operatingInstructions: '' });
      await expect(
        fs.access(path.join(paths.decksDir, `${original.id}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('fails closed on duplicate deck ids without touching the manifest', async () => {
    const home = await createV1Home();
    const paths = storePaths(home);
    const stray = path.join(paths.decksDir, 'zzz-stray-copy.json');
    await fs.copyFile(
      path.join(paths.decksDir, `${V1_DECKS[0].id}.json`),
      stray,
    );

    await expect(migrateStoreV1ToV2(home)).rejects.toThrow(
      `${V1_DECKS[0].id}.json`,
    );
    await expect(migrateStoreV1ToV2(home)).rejects.toThrow(stray);
    expect(JSON.parse(await fs.readFile(paths.manifest, 'utf8')).version).toBe(
      1,
    );
  });

  it('fails closed on malformed JSON and conflicting Markdown twins', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-v1-to-v2-'));
    homes.push(home);
    const paths = storePaths(home);
    await fs.mkdir(paths.decksDir, { recursive: true });
    await fs.writeFile(
      paths.manifest,
      `${JSON.stringify({ format: 'agent-deck-store', version: 1 }, null, 2)}\n`,
      'utf8',
    );
    const badJson = path.join(paths.decksDir, 'bad.json');
    await fs.writeFile(badJson, '{ nope\n', 'utf8');
    await expect(migrateStoreV1ToV2(home)).rejects.toThrow(badJson);
    await fs.unlink(badJson);

    const [deck] = V1_DECKS;
    const jsonPath = path.join(paths.decksDir, `${deck.id}.json`);
    const mdPath = path.join(paths.decksDir, `${deck.id}.md`);
    await fs.writeFile(jsonPath, `${JSON.stringify(deck, null, 2)}\n`, 'utf8');
    await fs.writeFile(
      mdPath,
      serializeDeck({ ...deck, name: 'different', operatingInstructions: '' }),
      'utf8',
    );
    await expect(migrateStoreV1ToV2(home)).rejects.toThrow(jsonPath);
    await expect(migrateStoreV1ToV2(home)).rejects.toThrow(mdPath);
    expect(JSON.parse(await fs.readFile(paths.manifest, 'utf8')).version).toBe(
      1,
    );
  });

  it('bumps an empty v1 store and ignores a missing manifest', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-v1-to-v2-'));
    homes.push(home);
    const paths = storePaths(home);
    await fs.mkdir(paths.decksDir, { recursive: true });
    await fs.writeFile(
      paths.manifest,
      `${JSON.stringify({ format: 'agent-deck-store', version: 1 }, null, 2)}\n`,
      'utf8',
    );
    await expect(migrateStoreV1ToV2(home)).resolves.toMatchObject({
      migrated: true,
      decks: 0,
    });
    expect(JSON.parse(await fs.readFile(paths.manifest, 'utf8')).version).toBe(
      2,
    );

    const missing = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-v1-to-v2-'));
    homes.push(missing);
    await expect(migrateStoreV1ToV2(missing)).resolves.toEqual({
      migrated: false,
      decks: 0,
      paths: [],
    });
  });
});

/**
 * Realistic local-first layout: the runtime home holds only links (plus
 * machine-local SQLite), while a separate `yusuke-decks` checkout is the
 * Git-backed source of truth:
 *
 *   <tmp>/runtime-home/manifest.json -> ../yusuke-decks/manifest.json
 *   <tmp>/runtime-home/{decks,playbooks,services,credentials} -> ../yusuke-decks/...
 *   <tmp>/yusuke-decks/            <- v1 store files live here
 */
const LINKED_STORE_NAMES = [
  'manifest.json',
  'decks',
  'playbooks',
  'services',
  'credentials',
];

async function createLinkedV1Layout(): Promise<{
  home: string;
  repo: string;
}> {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-v1-to-v2-link-'));
  homes.push(sandbox);
  const home = path.join(sandbox, 'runtime-home');
  const repo = path.join(sandbox, 'yusuke-decks');
  await fs.mkdir(home, { recursive: true });

  await writeV1Store(repo);
  // Cards referenced by the v1 decks, so reindex can rebuild the full layout.
  const writer = new FileStoreWriter(repo);
  for (const id of ['svc-a', 'svc-b']) {
    await writer.writeService({
      id,
      name: `Service ${id}`,
      type: 'mcp',
      url: `https://${id}.example.com/mcp`,
      disabledToolNames: [],
    });
  }
  await writer.writeCredential({
    id: 'cred_x',
    label: 'Cred X',
    scheme: 'bearer',
    envName: 'CRED_X_API_KEY',
    tags: [],
  });
  for (const id of ['pb_demo', 'pb_other']) {
    await writer.writePlaybook({
      id,
      title: `Playbook ${id}`,
      body: `${id} body.\n`,
      triggers: [id],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  for (const name of LINKED_STORE_NAMES) {
    await fs.symlink(path.join('..', 'yusuke-decks', name), path.join(home, name));
  }
  return { home, repo };
}

async function expectAllLinksIntact(home: string): Promise<void> {
  for (const name of LINKED_STORE_NAMES) {
    const linkPath = path.join(home, name);
    expect(
      (await fs.lstat(linkPath)).isSymbolicLink(),
      `${linkPath} is still a symlink`,
    ).toBe(true);
    expect(await fs.readlink(linkPath)).toBe(
      path.join('..', 'yusuke-decks', name),
    );
  }
}

describe('migrateStoreV1ToV2 over a symlinked store layout', () => {
  it('migrates the linked checkout and leaves every runtime-home link intact', async () => {
    const { home, repo } = await createLinkedV1Layout();
    const homePaths = storePaths(home);
    const repoPaths = storePaths(repo);

    const result = await migrateStoreV1ToV2(home);

    expect(result.migrated).toBe(true);
    expect(result.decks).toBe(2);

    // The Git-store target carries the v2 result...
    expect(JSON.parse(await fs.readFile(repoPaths.manifest, 'utf8'))).toEqual({
      format: 'agent-deck-store',
      version: 2,
      migratedFrom: 'sqlite',
    });
    for (const original of V1_DECKS) {
      expect(
        parseDeckMarkdown(
          await fs.readFile(
            path.join(repoPaths.decksDir, `${original.id}.md`),
            'utf8',
          ),
        ),
      ).toEqual({ ...original, operatingInstructions: '' });
      await expect(
        fs.access(path.join(repoPaths.decksDir, `${original.id}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    // ...and it is visible through the runtime-home links.
    expect(JSON.parse(await fs.readFile(homePaths.manifest, 'utf8')).version).toBe(2);

    // No shadow store files beside the links, no temp residue anywhere.
    expect((await fs.readdir(home)).sort()).toEqual(
      [...LINKED_STORE_NAMES].sort(),
    );
    await expectAllLinksIntact(home);
    for (const dir of [home, repoPaths.root, repoPaths.decksDir]) {
      expect(
        (await fs.readdir(dir)).filter((name) => name.includes('.tmp')),
      ).toEqual([]);
    }
  });

  it('is idempotent on rerun and rebuilds the same decks after a cache wipe', async () => {
    const { home, repo } = await createLinkedV1Layout();
    const repoPaths = storePaths(repo);

    expect(await migrateStoreV1ToV2(home)).toMatchObject({ migrated: true });
    expect(await migrateStoreV1ToV2(home)).toEqual({
      migrated: false,
      decks: 0,
      paths: [],
    });

    const dbPath = path.join(home, 'agent_deck.db');
    const snapshotOf = async (database: DatabaseManager) =>
      (await database.getAllDecks()).map((deck) => ({
        id: deck.id,
        name: deck.name,
        serviceIds: deck.services.map(({ id }) => id),
        credentialIds: deck.credentials.map(({ id }) => id),
        playbookIds: deck.playbooks.map(({ id }) => id),
        operatingInstructions: deck.operatingInstructions,
      }));

    const database = new DatabaseManager(dbPath);
    databases.add(database);
    const first = await reindexStoreToSqlite(database, { home });
    expect(first).toMatchObject({
      ok: true,
      counts: { playbooks: 2, services: 2, credentials: 1, decks: 2 },
    });
    const before = await snapshotOf(database);
    expect(before).toHaveLength(2);
    database.close();
    databases.delete(database);

    // Machine-local SQLite is wiped; the linked checkout stays the source of truth.
    await fs.unlink(dbPath);
    const rebuilt = new DatabaseManager(dbPath);
    databases.add(rebuilt);
    const second = await reindexStoreToSqlite(rebuilt, { home });
    expect(second).toMatchObject({ ok: true });
    expect(await snapshotOf(rebuilt)).toEqual(before);

    // The cache lives in the runtime home, never in the Git checkout.
    expect((await fs.readdir(home)).sort()).toEqual(
      [...LINKED_STORE_NAMES, 'agent_deck.db'].sort(),
    );
    expect(
      (await fs.readdir(repo)).some((name) => name.endsWith('.db')),
    ).toBe(false);
    expect(
      JSON.parse(await fs.readFile(repoPaths.manifest, 'utf8')).version,
    ).toBe(2);
    await expectAllLinksIntact(home);
  });
});
