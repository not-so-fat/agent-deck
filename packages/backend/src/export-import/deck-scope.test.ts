import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../models/database';
import { buildExportBundle, ExportBundleError } from './export-bundle';

describe('deck-scoped export', () => {
  let dbPath: string;
  let db: DatabaseManager;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `agent-deck-deck-scope-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('includes only linked cards for the named deck', async () => {
    const linked = await db.createService({
      name: 'Linked',
      type: 'mcp',
      url: 'https://example.com/linked',
    });
    const unlinked = await db.createService({
      name: 'Unlinked',
      type: 'mcp',
      url: 'https://example.com/unlinked',
    });

    const linkedPlaybook = await db.createPlaybook({
      id: 'pb_linked',
      title: 'Linked PB',
      body: 'linked',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [linked.id, unlinked.id],
    });
    await db.createPlaybook({
      id: 'pb_unlinked',
      title: 'Unlinked PB',
      body: 'unlinked',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [unlinked.id],
    });

    const deck = await db.createDeck({ name: 'focus' });
    await db.addServiceToDeck({ deckId: deck.id, serviceId: linked.id });
    await db.addPlaybookToDeck({ deckId: deck.id, playbookId: linkedPlaybook.id });

    const other = await db.createDeck({ name: 'other' });
    await db.addServiceToDeck({ deckId: other.id, serviceId: unlinked.id });

    const bundle = await buildExportBundle(
      db,
      { scope: 'deck', deckId: deck.id },
      { agentDeckVersion: 'test' },
    );

    expect(bundle.scope).toBe('deck');
    expect(bundle.version).toBe(2);
    expect(bundle.decks).toHaveLength(1);
    expect(bundle.decks[0].name).toBe('focus');
    expect(bundle.decks[0].operatingInstructions).toBe('');
    expect(bundle.services.map((row) => row.name)).toEqual(['Linked']);
    expect(bundle.playbooks.map((row) => row.id)).toEqual(['pb_linked']);
    // Membership-only closure: drop service deps not in the exported set.
    expect(bundle.playbooks[0].dependsOnServiceIds).toEqual([linked.id]);
  });

  it('throws when deck is missing', async () => {
    await expect(
      buildExportBundle(db, {
        scope: 'deck',
        deckId: '22222222-2222-4222-8222-222222222222',
      }),
    ).rejects.toBeInstanceOf(ExportBundleError);
  });
});
