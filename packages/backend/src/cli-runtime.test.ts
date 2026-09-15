import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCliCollectionAdmin } from './cli-runtime';
import { DatabaseManager } from './models/database';
import { parseDeckJson } from './store/deck-codec';
import { storePaths } from './store/paths';
import { FileStoreWriter } from './store/writer';

describe('createCliCollectionAdmin', () => {
  let dbPath: string;
  let home: string;
  let previousDbPath: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-cli-admin-'));
    dbPath = path.join(home, 'agent_deck.db');
    previousDbPath = process.env.AGENT_DECK_DB_PATH;
    previousHome = process.env.AGENT_DECK_HOME;
    process.env.AGENT_DECK_DB_PATH = dbPath;
    process.env.AGENT_DECK_HOME = home;

    const db = new DatabaseManager(dbPath);
    // Seed via direct DB so admin only exercises delete/list paths.
    void db;
    db.close();
  });

  afterEach(() => {
    if (previousDbPath === undefined) {
      delete process.env.AGENT_DECK_DB_PATH;
    } else {
      process.env.AGENT_DECK_DB_PATH = previousDbPath;
    }
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('lists and deletes a deck', async () => {
    const seed = new DatabaseManager(dbPath);
    const deck = await seed.createDeck({ name: 'scratch' });
    seed.close();

    const admin = createCliCollectionAdmin();
    const decks = await admin.listDecks();
    expect(decks.some((row) => row.id === deck.id)).toBe(true);

    const deleted = await admin.deleteDeck(deck.id);
    expect(deleted).toEqual({ ok: true });

    const after = await admin.listDecks();
    expect(after.some((row) => row.id === deck.id)).toBe(false);
  });

  it('S9: blocks service delete when a playbook depends on it', async () => {
    const seed = new DatabaseManager(dbPath);
    const service = await seed.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
    });
    await seed.createPlaybook({
      id: 'pb_linear',
      title: 'Linear triage',
      body: 'Use Linear',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [service.id],
    });
    seed.close();

    const admin = createCliCollectionAdmin();
    const result = await admin.deleteService(service.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('referenced by playbook');
    }
  });

  it('drops a deleted service from the deck file', async () => {
    const seed = new DatabaseManager(dbPath);
    const service = await seed.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
    });
    const deck = await seed.createDeck({ name: 'scratch' });
    await seed.addServiceToDeck({ deckId: deck.id, serviceId: service.id });

    const writer = new FileStoreWriter(home);
    await writer.ensureLayout();
    await writer.writeDeck({
      id: deck.id,
      name: deck.name,
      serviceIds: [service.id],
      credentialIds: [],
      playbookIds: [],
      createdAt: deck.createdAt,
      updatedAt: deck.updatedAt,
    });
    seed.close();

    expect(await createCliCollectionAdmin().deleteService(service.id)).toEqual({ ok: true });

    const deckFile = parseDeckJson(
      fs.readFileSync(path.join(storePaths(home).decksDir, `${deck.id}.json`), 'utf8'),
    );
    expect(deckFile.serviceIds).toEqual([]);
  });

  it('S10: deletes a playbook', async () => {
    const seed = new DatabaseManager(dbPath);
    const playbook = await seed.createPlaybook({
      id: 'pb_temp',
      title: 'Temp',
      body: 'body',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [],
    });
    seed.close();

    const admin = createCliCollectionAdmin();
    expect(await admin.deletePlaybook(playbook.id)).toEqual({ ok: true });
    expect(await admin.deletePlaybook(playbook.id)).toMatchObject({ ok: false });
  });
});

