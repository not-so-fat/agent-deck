import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildExportBundle } from '../export-import/export-bundle';
import { importBundle } from '../export-import/import-bundle';
import { DatabaseManager } from '../models/database';
import { PatchManager } from '../playbooks/patch-manager';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { ServiceManager } from '../services/service-manager';
import { CredentialManager } from '../vault/credential-manager';
import { MemorySecretStore } from '../vault/secret-store';
import { parseDeckJson } from './deck-codec';
import { flushDeckFile } from './deck-file';
import { storePaths } from './paths';
import { reindexStoreToSqlite } from './reindex';
import { FileStoreWriter } from './writer';

/**
 * Deck membership must reach `decks/<id>.json`, not just SQLite: reindex wipes the
 * DB tables and rebuilds them from the files, so a link that never lands in the
 * file is gone on the next reindex (and on the other laptop). Every non-route
 * caller gets a case here.
 */
describe('deck membership dual-write', () => {
  let home: string;
  let previousHome: string | undefined;
  let db: DatabaseManager;
  let writer: FileStoreWriter;
  let playbookManager: PlaybookManager;
  let credentialManager: CredentialManager;
  let serviceManager: ServiceManager;
  let deckId: string;
  const replicas = new Set<DatabaseManager>();

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-deck-membership-'));
    previousHome = process.env.AGENT_DECK_HOME;
    // Credential YAML resolves the home from the environment, the writer takes it
    // as an argument — both must land in this test's temp store.
    process.env.AGENT_DECK_HOME = home;
    process.env.AGENT_DECK_SECRET_STORE = 'memory';

    db = new DatabaseManager(path.join(home, 'agent_deck.db'));
    writer = new FileStoreWriter(home);
    await writer.ensureLayout();

    playbookManager = new PlaybookManager(db, writer);
    credentialManager = new CredentialManager(
      db,
      new MemorySecretStore(),
      undefined,
      writer,
    );
    serviceManager = new ServiceManager(
      db,
      { discoverTools: vi.fn().mockResolvedValue([]), invalidateClient: vi.fn() } as never,
      { discoverOAuth: vi.fn().mockResolvedValue({ hasOAuth: false }) } as never,
      { set: vi.fn(), get: vi.fn(), has: vi.fn(), delete: vi.fn() } as never,
      credentialManager,
      writer,
    );

    const deck = await db.createDeck({ name: 'Development' });
    deckId = deck.id;
    await flushDeckFile(db, deckId, writer);
  });

  afterEach(async () => {
    for (const replica of replicas) {
      replica.close();
    }
    replicas.clear();
    db.close();
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
    delete process.env.AGENT_DECK_SECRET_STORE;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function deckFileMembership(id = deckId) {
    const raw = await fs.readFile(
      path.join(storePaths(home).decksDir, `${id}.json`),
      'utf8',
    );
    const deck = parseDeckJson(raw);
    return {
      serviceIds: deck.serviceIds,
      credentialIds: deck.credentialIds,
      playbookIds: deck.playbookIds,
    };
  }

  async function dbMembership(database: DatabaseManager, id = deckId) {
    const deck = await database.getDeck(id);
    if (!deck) {
      throw new Error(`Deck not found: ${id}`);
    }
    return {
      serviceIds: deck.services.map((service) => service.id),
      credentialIds: deck.credentials.map((credential) => credential.id),
      playbookIds: deck.playbooks.map((playbook) => playbook.id),
    };
  }

  /** File matches the DB, and a rebuild from the files reproduces that membership. */
  async function expectStoreInSyncWithDb(
    database: DatabaseManager = db,
    id = deckId,
  ) {
    const expected = await dbMembership(database, id);
    expect(await deckFileMembership(id)).toEqual(expected);

    const replica = new DatabaseManager(
      path.join(os.tmpdir(), `ad-deck-membership-replica-${replicas.size}-${Date.now()}.db`),
    );
    replicas.add(replica);
    const result = await reindexStoreToSqlite(replica, { home });
    expect(result).toMatchObject({ ok: true });
    expect(await dbMembership(replica, id)).toEqual(expected);
  }

  it('writes the deck file when a create proposal is accepted', async () => {
    const patchManager = new PatchManager(db, playbookManager);
    const proposal = await patchManager.propose(
      {
        kind: 'create',
        new_playbook: {
          title: 'Review a pull request',
          body: '## Checklist\n- Read the diff.\n',
          triggers: ['review the PR'],
          deck_id: deckId,
        },
        rationale: 'Genesis from a correction.',
      },
      'ide',
      null,
    );
    if (proposal.kind === 'signal_only') {
      throw new Error('expected a patch');
    }

    await patchManager.accept(proposal.patch.id);

    expect((await deckFileMembership()).playbookIds).toEqual([
      'pb_review_a_pull_request',
    ]);
    await expectStoreInSyncWithDb();
  });

  it('keeps the deck file in sync for playbook add, remove, and delete', async () => {
    const playbook = await playbookManager.create({
      title: 'Release checklist',
      body: 'Ship it.\n',
      triggers: ['release'],
    });

    await playbookManager.addToDeck({ deckId, playbookId: playbook.id });
    expect((await deckFileMembership()).playbookIds).toEqual([playbook.id]);
    await expectStoreInSyncWithDb();

    await playbookManager.removeFromDeck({ deckId, playbookId: playbook.id });
    expect((await deckFileMembership()).playbookIds).toEqual([]);
    await expectStoreInSyncWithDb();

    // Deleting the card cascades the link away in SQLite; the file must drop it
    // too, or reindex aborts on a deck referencing a missing playbook.
    await playbookManager.addToDeck({ deckId, playbookId: playbook.id });
    await playbookManager.delete(playbook.id);
    expect((await deckFileMembership()).playbookIds).toEqual([]);
    await expectStoreInSyncWithDb();
  });

  it('keeps the deck file in sync for credential add, remove, and delete', async () => {
    const credential = await credentialManager.create({
      id: 'cred_remote',
      label: 'Remote key',
      scheme: 'bearer',
      envName: 'REMOTE_API_KEY',
      value: 'secret-value',
      tags: [],
    });

    await credentialManager.addToDeck({ deckId, credentialId: credential.id });
    expect((await deckFileMembership()).credentialIds).toEqual([credential.id]);
    await expectStoreInSyncWithDb();

    await credentialManager.removeFromDeck({ deckId, credentialId: credential.id });
    expect((await deckFileMembership()).credentialIds).toEqual([]);
    await expectStoreInSyncWithDb();

    await credentialManager.addToDeck({ deckId, credentialId: credential.id });
    await credentialManager.delete(credential.id);
    expect((await deckFileMembership()).credentialIds).toEqual([]);
    await expectStoreInSyncWithDb();
  });

  it('keeps the deck file in sync for service add, reorder, clear, and delete', async () => {
    const first = await serviceManager.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
    });
    const second = await serviceManager.createService({
      name: 'GitHub',
      type: 'mcp',
      url: 'https://api.githubcopilot.com/mcp/',
    });

    await serviceManager.addToDeck({ deckId, serviceId: first.id });
    await serviceManager.addToDeck({ deckId, serviceId: second.id });
    expect((await deckFileMembership()).serviceIds).toEqual([first.id, second.id]);
    await expectStoreInSyncWithDb();

    await serviceManager.reorderOnDeck({ deckId, serviceIds: [second.id, first.id] });
    expect((await deckFileMembership()).serviceIds).toEqual([second.id, first.id]);
    await expectStoreInSyncWithDb();

    await serviceManager.removeFromDeck({ deckId, serviceId: second.id });
    expect((await deckFileMembership()).serviceIds).toEqual([first.id]);
    await expectStoreInSyncWithDb();

    await serviceManager.deleteService(first.id);
    expect((await deckFileMembership()).serviceIds).toEqual([]);
    await expectStoreInSyncWithDb();

    await serviceManager.addToDeck({ deckId, serviceId: second.id });
    await serviceManager.clearFromDeck(deckId);
    expect((await deckFileMembership()).serviceIds).toEqual([]);
    await expectStoreInSyncWithDb();
  });

  it('still removes the card file when a deck file cannot be written', async () => {
    const playbook = await playbookManager.create({
      title: 'Doomed',
      body: 'Gone soon.\n',
      triggers: ['doomed'],
    });
    await playbookManager.addToDeck({ deckId, playbookId: playbook.id });

    // The row is deleted before the flush, so a deck file that refuses to write
    // must not strand `playbooks/<id>.md` — files win the next reindex, and the
    // orphan would resurrect the card we just deleted.
    const writeDeck = vi
      .spyOn(writer, 'writeDeck')
      .mockRejectedValueOnce(new Error('EACCES: deck file is read-only'));

    await expect(playbookManager.delete(playbook.id)).rejects.toThrow('EACCES');
    expect(writeDeck).toHaveBeenCalled();

    await expect(
      fs.access(path.join(storePaths(home).playbooksDir, `${playbook.id}.md`)),
    ).rejects.toThrow();
  });

  it('writes imported deck membership to the store', async () => {
    const sourcePath = path.join(home, 'source.db');
    const source = new DatabaseManager(sourcePath);
    replicas.add(source);

    const service = await source.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
    });
    const playbook = await source.createPlaybook({
      id: 'pb_triage',
      title: 'Triage',
      body: 'Use Linear.\n',
      triggers: ['triage'],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [service.id],
    });
    const sourceDeck = await source.createDeck({ name: 'Imported' });
    await source.addServiceToDeck({ deckId: sourceDeck.id, serviceId: service.id });
    await source.addPlaybookToDeck({ deckId: sourceDeck.id, playbookId: playbook.id });

    const bundle = await buildExportBundle(source, { scope: 'collection' }, {
      agentDeckVersion: 'test',
    });
    const report = await importBundle(db, bundle, { syncStore: true, storeHome: home });
    expect(report.status).toBe('completed');

    const importedDeckId = report.idMap[sourceDeck.id];
    expect((await deckFileMembership(importedDeckId)).serviceIds).toEqual([
      report.idMap[service.id],
    ]);
    expect((await deckFileMembership(importedDeckId)).playbookIds).toEqual([
      report.idMap[playbook.id],
    ]);
    await expectStoreInSyncWithDb(db, importedDeckId);
  });
});
