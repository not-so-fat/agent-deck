import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StoreManifestSchema } from '@agent-deck/shared';
import { DatabaseManager, STORE_CONTENT_HASH } from '../models/database';
import { hashStoreTree } from './content-hash';
import { parseCredentialYaml } from './credential-codec';
import { parseDeckJson } from './deck-codec';
import { migrateSqliteToStore } from './migrate';
import { storePaths } from './paths';
import { parsePlaybookMarkdown } from './playbook-codec';
import { parseServiceJson } from './service-codec';

const homes: string[] = [];
const databases: DatabaseManager[] = [];

async function createDatabase() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-migrate-'));
  homes.push(home);
  const database = new DatabaseManager(path.join(home, 'agent_deck.db'));
  databases.push(database);
  return { home, database };
}

async function seedDatabase(database: DatabaseManager) {
  const remote = await database.createService({
    name: 'Remote',
    type: 'mcp',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer secret', 'X-Public': 'visible' },
    oauthClientSecret: 'client-secret',
  });
  const local = await database.createService({
    name: 'Local',
    type: 'local-mcp',
    url: 'local://demo',
    localCommand: 'node',
    localArgs: ['server.js'],
    localEnv: { SECRET: 'hidden' },
  });
  const credentialA = await database.createCredential({
    id: 'cred_a',
    label: 'Credential A',
    scheme: 'bearer',
    envName: 'CRED_A',
    keychainAccount: 'account-a',
    tags: ['a'],
    hasSecret: false,
  });
  const credentialB = await database.createCredential({
    id: 'cred_b',
    label: 'Credential B',
    scheme: 'header',
    headerName: 'X-Key',
    envName: 'CRED_B',
    keychainAccount: 'account-b',
    tags: ['b'],
    hasSecret: false,
  });
  const playbookA = await database.createPlaybook({
    id: 'pb_a',
    title: 'Playbook A',
    body: 'First body\n',
    triggers: ['first'],
    dependsOnCredentialIds: [credentialA.id],
    dependsOnServiceIds: [remote.id],
  });
  const playbookB = await database.createPlaybook({
    id: 'pb_b',
    title: 'Playbook B',
    body: 'Second body\n',
    triggers: ['second'],
  });
  const deck = await database.createDeck({ name: 'Demo' });

  await database.addServiceToDeck({
    deckId: deck.id,
    serviceId: local.id,
    position: 0,
  });
  await database.addServiceToDeck({
    deckId: deck.id,
    serviceId: remote.id,
    position: 1,
  });
  await database.addCredentialToDeck({
    deckId: deck.id,
    credentialId: credentialB.id,
    position: 0,
  });
  await database.addCredentialToDeck({
    deckId: deck.id,
    credentialId: credentialA.id,
    position: 1,
  });
  await database.addPlaybookToDeck({
    deckId: deck.id,
    playbookId: playbookB.id,
    position: 0,
  });
  await database.addPlaybookToDeck({
    deckId: deck.id,
    playbookId: playbookA.id,
    position: 1,
  });

  return {
    remote,
    local,
    credentialA,
    credentialB,
    playbookA,
    playbookB,
    deck,
  };
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
  }
  await Promise.all(
    homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })),
  );
});

describe('migrateSqliteToStore', () => {
  it('writes every SQLite entity with preserved ids, ordering, and safe data', async () => {
    const { home, database } = await createDatabase();
    const seeded = await seedDatabase(database);
    const paths = storePaths(home);

    const result = await migrateSqliteToStore(database, { home });

    expect(result).toEqual({
      wrote: { playbooks: 2, services: 2, credentials: 2, decks: 1 },
      dryRun: false,
      paths: expect.arrayContaining([
        paths.manifest,
        path.join(paths.playbooksDir, 'pb_a.md'),
        path.join(paths.servicesDir, `${seeded.remote.id}.json`),
        path.join(paths.credentialsDir, 'cred_a.yaml'),
        path.join(paths.decksDir, `${seeded.deck.id}.json`),
      ]),
    });
    expect(result.paths).toHaveLength(8);

    expect(
      StoreManifestSchema.parse(
        JSON.parse(await fs.readFile(paths.manifest, 'utf8')),
      ),
    ).toEqual({
      format: 'agent-deck-store',
      version: 1,
      migratedFrom: 'sqlite',
    });
    expect(
      parsePlaybookMarkdown(
        await fs.readFile(path.join(paths.playbooksDir, 'pb_a.md'), 'utf8'),
      ),
    ).toEqual(seeded.playbookA);
    expect(
      parseCredentialYaml(
        await fs.readFile(
          path.join(paths.credentialsDir, 'cred_a.yaml'),
          'utf8',
        ),
      ),
    ).toEqual({
      id: seeded.credentialA.id,
      label: seeded.credentialA.label,
      scheme: seeded.credentialA.scheme,
      headerName: null,
      envName: seeded.credentialA.envName,
      tags: seeded.credentialA.tags,
    });
    expect(
      parseDeckJson(
        await fs.readFile(
          path.join(paths.decksDir, `${seeded.deck.id}.json`),
          'utf8',
        ),
      ),
    ).toEqual({
      id: seeded.deck.id,
      name: seeded.deck.name,
      serviceIds: [seeded.local.id, seeded.remote.id],
      credentialIds: [seeded.credentialB.id, seeded.credentialA.id],
      playbookIds: [seeded.playbookB.id, seeded.playbookA.id],
      createdAt: seeded.deck.createdAt,
      updatedAt: seeded.deck.updatedAt,
    });

    const remoteRaw = await fs.readFile(
      path.join(paths.servicesDir, `${seeded.remote.id}.json`),
      'utf8',
    );
    expect(parseServiceJson(remoteRaw).headers).toEqual({
      'X-Public': 'visible',
    });
    expect(remoteRaw).not.toContain('Bearer secret');
    expect(remoteRaw).not.toContain('client-secret');
    expect(
      await fs.readFile(
        path.join(paths.servicesDir, `${seeded.local.id}.json`),
        'utf8',
      ),
    ).not.toContain('hidden');
    expect(database.getStoreMeta(STORE_CONTENT_HASH)).toBe(
      await hashStoreTree(home),
    );
  });

  it('reports all paths in dry-run mode without writing files or hash', async () => {
    const { home, database } = await createDatabase();
    await seedDatabase(database);

    const result = await migrateSqliteToStore(database, {
      home,
      dryRun: true,
    });

    expect(result.wrote).toEqual({
      playbooks: 2,
      services: 2,
      credentials: 2,
      decks: 1,
    });
    expect(result.dryRun).toBe(true);
    expect(result.paths).toHaveLength(8);
    await expect(fs.access(storePaths(home).manifest)).rejects.toThrow();
    expect(database.getStoreMeta(STORE_CONTENT_HASH)).toBeNull();
  });

  it('is a no-op when the store is complete and repairs only missing files', async () => {
    const { home, database } = await createDatabase();
    await seedDatabase(database);
    const paths = storePaths(home);
    await migrateSqliteToStore(database, { home });

    await expect(migrateSqliteToStore(database, { home })).resolves.toEqual({
      wrote: { playbooks: 0, services: 0, credentials: 0, decks: 0 },
      dryRun: false,
      paths: [],
    });

    const missing = path.join(paths.playbooksDir, 'pb_b.md');
    await fs.unlink(missing);
    await expect(migrateSqliteToStore(database, { home })).resolves.toEqual({
      wrote: { playbooks: 1, services: 0, credentials: 0, decks: 0 },
      dryRun: false,
      paths: [missing],
    });
    await expect(fs.access(missing)).resolves.toBeUndefined();
  });
});
