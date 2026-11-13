import {
  clearDefaultDeck,
  readDefaultDeck,
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
    return { action: 'show', previous, current: previous, cleared: false };
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
  const current = result.current;
  if (!current) {
    return 'No default deck set.';
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
