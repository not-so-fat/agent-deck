import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../models/database';
import { backendAgentRunDeps } from './host';

/**
 * The headerless deck lookup (used for clients that cannot carry the launch
 * deck header) must match the daemon: a folder assignment naming a deleted
 * deck falls through to the user default deck.
 */
describe('backend run host headerless deck resolution', () => {
  const dbs: DatabaseManager[] = [];
  afterEach(() => {
    while (dbs.length) dbs.pop()?.close();
  });

  function workspaceWithManifest(deckId: string, deckName: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-host-'));
    fs.mkdirSync(path.join(dir, '.agent-deck'));
    fs.writeFileSync(
      path.join(dir, '.agent-deck', 'use.json'),
      JSON.stringify({ version: 3, deckId, deckName }),
    );
    return dir;
  }

  it('uses an assignment that names an existing deck', async () => {
    const db = new DatabaseManager(':memory:');
    dbs.push(db);
    const deck = await db.createDeck({ name: 'pinned' });
    const deps = backendAgentRunDeps(db, os.tmpdir());
    expect(await deps.resolveHeaderlessDeck!(workspaceWithManifest(deck.id, deck.name))).toBe(deck.id);
  });

  it('falls through past an assignment that names a deleted deck', async () => {
    const db = new DatabaseManager(':memory:');
    dbs.push(db);
    const deps = backendAgentRunDeps(db, os.tmpdir());
    expect(await deps.resolveHeaderlessDeck!(workspaceWithManifest('deleted-deck-id', 'gone'))).not.toBe(
      'deleted-deck-id',
    );
  });
});
