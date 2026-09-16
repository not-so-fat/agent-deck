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

/** The three card types a deck can hold. */
export type DeckCardKind = 'playbook' | 'service' | 'credential';

function withoutCard(deck: StoreDeck, kind: DeckCardKind, cardId: string): StoreDeck {
  const drop = (ids: string[]) => ids.filter((id) => id !== cardId);
  switch (kind) {
    case 'playbook':
      return { ...deck, playbookIds: drop(deck.playbookIds) };
    case 'service':
      return { ...deck, serviceIds: drop(deck.serviceIds) };
    case 'credential':
      return { ...deck, credentialIds: drop(deck.credentialIds) };
  }
}

function listDeckIdsForCard(
  db: DatabaseManager,
  kind: DeckCardKind,
  cardId: string,
): Promise<string[]> {
  switch (kind) {
    case 'playbook':
      return db.listDeckIdsForPlaybook(cardId);
    case 'service':
      return db.listDeckIdsForService(cardId);
    case 'credential':
      return db.listDeckIdsForCredential(cardId);
  }
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

/**
 * Delete a card from the file store first, then from SQLite.
 *
 * The files are the source of truth and SQLite is a rebuildable cache, so the
 * store has to be internally consistent at every instant: a deck file naming a
 * card whose file is gone aborts the *whole* reindex, not just that deck. So
 * every deck that held the card is rewritten without it and the card file is
 * removed before the row goes — and if any of that fails we put the deck files
 * we already rewrote back and rethrow with the row still there. The delete then
 * simply did not happen, and a plain retry redoes it from a clean state.
 *
 * Auxiliary cleanup a card may need (header vault, cached icon, keychain secret)
 * belongs *after* this call, via {@link cleanUpAfterCardDelete}: it can't be
 * undone, and losing it while the card survives is a worse trade than an orphan
 * the next delete removes.
 *
 * `writer` gates only the deck rewrites. `deleteCardFile` runs either way —
 * credential YAML, for one, is written through its own sync whether or not a
 * writer was injected, so skipping it here would strand the file and let the
 * next reindex resurrect the card.
 */
export async function deleteCardFromStoreThenDb(
  db: DatabaseManager,
  card: { kind: DeckCardKind; id: string },
  writer: FileStoreWriter | undefined,
  deleteCardFile: () => Promise<void>,
  deleteRow: () => Promise<boolean>,
): Promise<boolean> {
  const rewritten: StoreDeck[] = [];

  try {
    if (writer) {
      for (const deckId of new Set(await listDeckIdsForCard(db, card.kind, card.id))) {
        const deck = await db.getDeck(deckId);
        if (!deck) {
          throw new Error(`Deck not found while deleting ${card.kind} ${card.id}: ${deckId}`);
        }
        const before = storeDeckFromDb(deck);
        await writer.writeDeck(withoutCard(before, card.kind, card.id));
        // Only decks we actually changed — an atomic write that threw left the
        // old file in place and must not be "restored" over.
        rewritten.push(before);
      }
    }

    // Last, so nothing fallible runs between the card file going away and the
    // deck files that point at it already being clean.
    await deleteCardFile();
  } catch (error) {
    if (writer) {
      await restoreDeckFiles(writer, rewritten);
    }
    console.error(`Failed to remove ${card.kind} ${card.id} from the file store:`, error);
    throw error;
  }

  return deleteRow();
}

/**
 * Run a deleted card's leftover cleanup, after the delete has already committed.
 *
 * The row and the store files are gone by this point, so the delete *succeeded*;
 * what is left is the card's ancillary data — a keychain entry, a cached icon,
 * stored headers. Throwing here would both misreport that outcome and strand the
 * leftovers for good, because the retry it invites returns `false` on the missing
 * row and never reaches this code again. So we log what was left behind and let
 * the delete stand.
 */
export async function cleanUpAfterCardDelete(
  leftover: string,
  cleanUp: () => Promise<void>,
): Promise<void> {
  try {
    await cleanUp();
  } catch (error) {
    console.error(`Card deleted, but ${leftover} could not be removed:`, error);
  }
}

/**
 * Put back the deck files an aborted delete had already rewritten.
 *
 * Best effort on purpose: a deck file that stayed stripped still reindexes fine
 * — only a deck naming a *missing* card aborts the rebuild — so a restore that
 * itself fails costs one membership, never the whole store.
 */
async function restoreDeckFiles(
  writer: FileStoreWriter,
  decks: StoreDeck[],
): Promise<void> {
  for (const deck of decks) {
    try {
      await writer.writeDeck(deck);
    } catch (error) {
      console.error(`Failed to restore deck ${deck.id} after an aborted delete:`, error);
    }
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
