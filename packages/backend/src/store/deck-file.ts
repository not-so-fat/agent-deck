import type { Deck, StoreDeck } from '@agent-deck/shared';
import type { DatabaseManager } from '../models/database';
import type { FileStoreWriter } from './writer';

/** Deck file shape: name plus the ordered card ids, straight from the DB join. */
export function storeDeckFromDb(deck: Deck): StoreDeck {
  return {
    id: deck.id,
    name: deck.name,
    serviceIds: deck.services.map(({ id }) => id),
    credentialIds: deck.credentials.map(({ id }) => id),
    playbookIds: deck.playbooks.map(({ id }) => id),
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
  };
}

/**
 * Rewrite `decks/<id>.json` from the DB after a membership change.
 *
 * Files are the source of truth: `reindex` wipes the DB tables and rebuilds them
 * from the store tree, so a membership row that never reaches the deck file is
 * lost on the next reindex (and never reaches a second laptop). Every caller that
 * adds or removes a deck card must flush — no-op when the store is disabled.
 */
export async function flushDeckFile(
  db: DatabaseManager,
  deckId: string,
  writer?: FileStoreWriter,
): Promise<void> {
  if (!writer) {
    return;
  }

  try {
    const deck = await db.getDeck(deckId);
    if (!deck) {
      throw new Error(`Deck not found after mutation: ${deckId}`);
    }
    await writer.writeDeck(storeDeckFromDb(deck));
  } catch (error) {
    console.error(`Failed to write deck ${deckId} to file store:`, error);
    throw error;
  }
}

/** Flush several decks — e.g. every deck that held a card being deleted. */
export async function flushDeckFiles(
  db: DatabaseManager,
  deckIds: Iterable<string>,
  writer?: FileStoreWriter,
): Promise<void> {
  if (!writer) {
    return;
  }

  for (const deckId of new Set(deckIds)) {
    await flushDeckFile(db, deckId, writer);
  }
}

/** Remove `decks/<id>.json` after the deck row is gone. */
export async function deleteDeckFile(
  deckId: string,
  writer?: FileStoreWriter,
): Promise<void> {
  if (!writer) {
    return;
  }

  try {
    await writer.deleteDeck(deckId);
  } catch (error) {
    console.error(`Failed to delete deck ${deckId} from file store:`, error);
    throw error;
  }
}
