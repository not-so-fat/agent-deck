import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseManager, STORE_CONTENT_HASH } from '../models/database';
import { hashStoreTree } from './content-hash';
import { migrateSqliteToStore } from './migrate';
import { storePaths } from './paths';
import { reindexStoreToSqlite } from './reindex';
import { FileStoreWriter } from './writer';

const homes: string[] = [];
const databases = new Set<DatabaseManager>();

async function createFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-reindex-'));
  homes.push(home);
  const dbPath = path.join(home, 'agent_deck.db');
  const database = new DatabaseManager(dbPath);
  databases.add(database);

  const service = await database.createService({
    name: 'Remote',
    type: 'mcp',
    url: 'https://example.com/mcp',
  });
  const credential = await database.createCredential({
    id: 'cred_remote',
    label: 'Remote key',
    scheme: 'bearer',
    envName: 'REMOTE_API_KEY',
    keychainAccount: 'remote-keychain-account',
    tags: ['remote'],
    hasSecret: true,
  });
  const linkedService = await database.updateService(service.id, {
    credentialId: credential.id,
  });
  if (!linkedService) {
    throw new Error('Failed to link service credential');
  }
  const playbook = await database.createPlaybook({
    id: 'pb_remote',
    title: 'Use remote',
    body: 'Call the remote service.\n',
    triggers: ['remote'],
    dependsOnCredentialIds: [credential.id],
    dependsOnServiceIds: [service.id],
  });
  const deck = await database.createDeck({ name: 'Development' });
  await database.addServiceToDeck({
    deckId: deck.id,
    serviceId: service.id,
    position: 0,
  });
  await database.addCredentialToDeck({
    deckId: deck.id,
    credentialId: credential.id,
    position: 0,
  });
  await database.addPlaybookToDeck({
    deckId: deck.id,
    playbookId: playbook.id,
    position: 0,
  });

  await migrateSqliteToStore(database, { home });
  return {
    home,
    dbPath,
    database,
    service: linkedService,
    credential,
    playbook,
    deck,
  };
}

function closeDatabase(database: DatabaseManager): void {
  database.close();
  databases.delete(database);
}

afterEach(async () => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  await Promise.all(
    homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })),
  );
});

describe('reindexStoreToSqlite', () => {
  it('restores migrated cards and ordered deck layouts into a new database', async () => {
    const fixture = await createFixture();
    closeDatabase(fixture.database);
    await fs.unlink(fixture.dbPath);

    const restored = new DatabaseManager(fixture.dbPath);
    databases.add(restored);
    const result = await reindexStoreToSqlite(restored, { home: fixture.home });

    expect(result).toEqual({
      ok: true,
      counts: { playbooks: 1, services: 1, credentials: 1, decks: 1 },
      warnings: [],
      contentHash: await hashStoreTree(fixture.home),
    });
    expect((await restored.getAllServices()).map(({ id }) => id)).toEqual([
      fixture.service.id,
    ]);
    expect((await restored.getAllServices())[0].credentialId).toBe(
      fixture.credential.id,
    );
    expect((await restored.getAllCredentials()).map(({ id }) => id)).toEqual([
      fixture.credential.id,
    ]);
    expect((await restored.getAllCredentials())[0].keychainAccount).toBe(
      fixture.credential.id,
    );
    expect((await restored.getAllPlaybooks()).map(({ id }) => id)).toEqual([
      fixture.playbook.id,
    ]);

    const [deck] = await restored.getAllDecks();
    expect(deck.id).toBe(fixture.deck.id);
    expect(deck.services.map(({ id }) => id)).toEqual([fixture.service.id]);
    expect(deck.credentials.map(({ id }) => id)).toEqual([fixture.credential.id]);
    expect(deck.playbooks.map(({ id }) => id)).toEqual([fixture.playbook.id]);
    expect(restored.getStoreMeta(STORE_CONTENT_HASH)).toBe(result.contentHash);
  });

  it('replaces file-backed rows while preserving learning-loop tables', async () => {
    const fixture = await createFixture();
    await fixture.database.createService({
      name: 'Database only',
      type: 'mcp',
      url: 'https://db-only.example.com/mcp',
    });
    await fixture.database.createPlaybookPatch({
      id: 'pp_keep',
      kind: 'update',
      playbookId: fixture.playbook.id,
      opsJson: '[]',
      rationale: 'Keep this patch',
      source: 'ide',
      sourceRef: null,
      evidenceJson: null,
    });
    await fixture.database.createPlaybookVersion({
      id: 'pv_keep',
      playbookId: fixture.playbook.id,
      title: fixture.playbook.title,
      body: fixture.playbook.body,
      triggers: fixture.playbook.triggers,
      patchId: 'pp_keep',
      actor: 'agent',
    });
    await fixture.database.recordPlaybookEvent({
      id: 'pe_keep',
      playbookId: fixture.playbook.id,
      event: 'fetched',
      source: 'test',
    });
    await fixture.database.createFeedbackSignal({
      id: 'fs_keep',
      source: 'ide',
      sourceRef: null,
      failureSummary: 'Keep this signal',
      userFeedbackExcerpt: 'Do not wipe learning rows',
      correctedOutputHint: null,
      candidatePlaybookId: fixture.playbook.id,
      candidateDeckId: fixture.deck.id,
      linkedPatchId: 'pp_keep',
      status: 'open',
    });
    await fixture.database.createExecRun({
      deckId: fixture.deck.id,
      command: 'echo test',
      credentialIds: [fixture.credential.id],
      startedAt: new Date().toISOString(),
    });
    await fixture.database.upsertDeckWorkspace('/tmp/project', fixture.deck.id);

    const result = await reindexStoreToSqlite(fixture.database, {
      home: fixture.home,
      force: true,
    });

    expect(result.ok).toBe(true);
    expect((await fixture.database.getAllServices()).map(({ name }) => name)).toEqual([
      'Remote',
    ]);
    expect((await fixture.database.getAllCredentials())[0].keychainAccount).toBe(
      'remote-keychain-account',
    );
    const raw = new Database(fixture.dbPath, { readonly: true });
    for (const table of [
      'playbook_patches',
      'playbook_versions',
      'playbook_events',
      'feedback_signals',
      'exec_runs',
      'deck_workspaces',
    ]) {
      expect(
        (raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }).count,
        table,
      ).toBe(1);
    }
    raw.close();
  });

  it('aborts duplicate display titles without changing SQLite', async () => {
    const fixture = await createFixture();
    const before = {
      services: await fixture.database.getAllServices(),
      credentials: await fixture.database.getAllCredentials(),
      playbooks: await fixture.database.getAllPlaybooks(),
      decks: await fixture.database.getAllDecks(),
      hash: fixture.database.getStoreMeta(STORE_CONTENT_HASH),
    };
    await new FileStoreWriter(fixture.home).writePlaybook({
      ...fixture.playbook,
      id: 'pb_duplicate',
    });

    const result = await reindexStoreToSqlite(fixture.database, {
      home: fixture.home,
      force: true,
    });

    expect(result).toMatchObject({
      ok: false,
      conflicts: [
        {
          kind: 'playbook',
          value: fixture.playbook.title,
          paths: expect.arrayContaining([
            path.join(storePaths(fixture.home).playbooksDir, 'pb_remote.md'),
            path.join(storePaths(fixture.home).playbooksDir, 'pb_duplicate.md'),
          ]),
        },
      ],
    });
    expect(await fixture.database.getAllServices()).toEqual(before.services);
    expect(await fixture.database.getAllCredentials()).toEqual(before.credentials);
    expect(await fixture.database.getAllPlaybooks()).toEqual(before.playbooks);
    expect(await fixture.database.getAllDecks()).toEqual(before.decks);
    expect(fixture.database.getStoreMeta(STORE_CONTENT_HASH)).toBe(before.hash);
  });

  it('rejects a deck referencing a missing playbook without changing SQLite', async () => {
    const fixture = await createFixture();
    const before = {
      services: await fixture.database.getAllServices(),
      credentials: await fixture.database.getAllCredentials(),
      playbooks: await fixture.database.getAllPlaybooks(),
      decks: await fixture.database.getAllDecks(),
      hash: fixture.database.getStoreMeta(STORE_CONTENT_HASH),
    };
    const deckPath = path.join(
      storePaths(fixture.home).decksDir,
      `${fixture.deck.id}.json`,
    );
    const deck = JSON.parse(await fs.readFile(deckPath, 'utf8')) as {
      playbookIds: string[];
    };
    deck.playbookIds = ['pb_missing'];
    await fs.writeFile(deckPath, `${JSON.stringify(deck, null, 2)}\n`);

    const result = await reindexStoreToSqlite(fixture.database, {
      home: fixture.home,
      force: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('pb_missing'),
    });
    expect(await fixture.database.getAllServices()).toEqual(before.services);
    expect(await fixture.database.getAllCredentials()).toEqual(before.credentials);
    expect(await fixture.database.getAllPlaybooks()).toEqual(before.playbooks);
    expect(await fixture.database.getAllDecks()).toEqual(before.decks);
    expect(fixture.database.getStoreMeta(STORE_CONTENT_HASH)).toBe(before.hash);
  });

  it('rejects an unknown manifest version before changing SQLite', async () => {
    const fixture = await createFixture();
    const before = await fixture.database.getAllDecks();
    await fs.writeFile(
      storePaths(fixture.home).manifest,
      '{"format":"agent-deck-store","version":2}\n',
    );

    const result = await reindexStoreToSqlite(fixture.database, {
      home: fixture.home,
      force: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('manifest'),
    });
    expect(await fixture.database.getAllDecks()).toEqual(before);
  });
});
