import {
  clearDefaultDeck,
  readDefaultDeck,
  readDefaultDeckState,
  writeDefaultDeck,
  type DefaultDeckFile,
} from '@agent-deck/shared';
import { createCollectionAdmin, type CliCollectionAdmin } from './backend-runtime';

export interface DefaultOptions {
  /** Deck name or id to set; absent means show (unless --clear). */
  deckRef?: string;
  clear: boolean;
}

export type DefaultResult = {
  action: 'show' | 'set' | 'clear';
  previous: DefaultDeckFile | null;
  current: DefaultDeckFile | null;
  cleared: boolean;
  /**
   * NOT-606, show only: `default-deck.json` exists but is corrupt or an
   * unknown version. `current` stays null; this carries the path for the
   * message. Exit code stays 0 — the file is reported, not an error.
   */
  unreadablePath?: string;
  /**
   * NOT-606, show only: the saved deck id is no longer in the store.
   * `current` still carries the saved record (name is display-only).
   */
  currentMissing?: boolean;
};

export type DefaultDeps = {
  resolveDeck(ref: string): Promise<{ id: string; name: string } | null>;
};

function defaultDeps(): DefaultDeps {
  const admin: CliCollectionAdmin = createCollectionAdmin();
  return { resolveDeck: (ref) => admin.resolveDeck(ref) };
}

export function parseDefaultArgs(args: string[]): DefaultOptions | { error: string } {
  let deckRef: string | undefined;
  let clear = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--clear') {
      clear = true;
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown default option: ${arg}` };
    } else if (!deckRef) {
      deckRef = arg;
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }

  if (clear && deckRef) {
    return { error: 'Pass either a deck or --clear, not both' };
  }

  return { deckRef, clear };
}

export async function runDefault(
  parsed: DefaultOptions,
  deps: DefaultDeps = defaultDeps(),
): Promise<DefaultResult | { error: string }> {
  const previous = readDefaultDeck();

  if (parsed.clear) {
    const cleared = clearDefaultDeck();
    return { action: 'clear', previous, current: null, cleared };
  }

  if (!parsed.deckRef) {
    // NOT-606: a saved default that is corrupt or names a deleted deck is
    // reported, not silently treated as no default. The store check is
    // show-only; set/clear keep their existing behaviour.
    const state = readDefaultDeckState();
    if (state.status === 'unreadable') {
      return {
        action: 'show',
        previous: null,
        current: null,
        cleared: false,
        unreadablePath: state.path,
      };
    }
    if (state.status === 'none') {
      return { action: 'show', previous: null, current: null, cleared: false };
    }
    const stored = await deps.resolveDeck(state.deck.deckId);
    if (!stored) {
      return {
        action: 'show',
        previous: state.deck,
        current: state.deck,
        cleared: false,
        currentMissing: true,
      };
    }
    return {
      action: 'show',
      previous: state.deck,
      current: state.deck,
      cleared: false,
    };
  }

  const deck = await deps.resolveDeck(parsed.deckRef);
  if (!deck) {
    return { error: `Deck not found: ${parsed.deckRef}` };
  }
  writeDefaultDeck({ deckId: deck.id, deckName: deck.name });
  return { action: 'set', previous, current: readDefaultDeck(), cleared: false };
}

export function formatDefaultResult(result: DefaultResult): string {
  if (result.action === 'clear') {
    return result.cleared
      ? 'Default deck cleared.'
      : 'No default deck was set.';
  }
  if (result.unreadablePath) {
    return `Default deck file is unreadable: ${result.unreadablePath}`;
  }
  const current = result.current;
  if (!current) {
    return 'No default deck set.';
  }
  if (result.currentMissing) {
    return `Default deck: ${current.deckName} (deck no longer exists, run agent-deck default <deck>)`;
  }
  const prefix = result.action === 'set' ? 'Default deck set to' : 'Default deck:';
  return `${prefix} ${current.deckName} (${current.deckId})`;
}

export async function runDefaultCommand(args: string[]): Promise<number> {
  const parsed = parseDefaultArgs(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      console.log(`Usage:
  agent-deck default                Show the default deck (headerless sessions bind to it)
  agent-deck default <deck>         Set the default deck by name or id
  agent-deck default --clear        Clear the default deck

Headerless local sessions (no deck header, no folder assignment) bind to the
default deck instead of landing in the explain-only session.`);
      return 0;
    }
    console.error(parsed.error);
    return 1;
  }

  const result = await runDefault(parsed);
  if ('error' in result) {
    console.error(result.error);
    return 1;
  }

  console.log(formatDefaultResult(result));
  return 0;
}
