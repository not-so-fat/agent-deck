import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { realAgentDeckHome } from '@agent-deck/shared';
import { storePaths } from './paths';
import { FileStoreWriter } from './writer';

/**
 * Regression guard for NOT-122: an un-isolated test used to write stray decks and
 * services into the developer's real ~/.agent-deck, which then failed every reindex.
 */
describe('store writes without an isolated AGENT_DECK_HOME', () => {
  const originalHome = process.env.AGENT_DECK_HOME;

  beforeEach(() => {
    delete process.env.AGENT_DECK_HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = originalHome;
    }
  });

  it('throws instead of writing a deck into the real store', async () => {
    const decksBefore = listDecks();

    await expect(
      new FileStoreWriter().writeDeck({
        id: '99999999-9999-4999-8999-999999999999',
        name: 'dev',
        serviceIds: [],
        credentialIds: [],
        playbookIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/Refusing to use the real Agent Deck store/);

    expect(listDecks()).toEqual(decksBefore);
  });

  it('throws before ensureLayout can create the real store dirs', async () => {
    await expect(new FileStoreWriter().ensureLayout()).rejects.toThrow(
      /Refusing to use the real Agent Deck store/,
    );
  });

  it('throws when resolving store paths', () => {
    expect(() => storePaths()).toThrow(/Refusing to use the real Agent Deck store/);
  });
});

function listDecks(): string[] {
  try {
    return fs.readdirSync(`${realAgentDeckHome()}/decks`).sort();
  } catch {
    return [];
  }
}
