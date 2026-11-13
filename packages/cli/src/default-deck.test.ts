import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDefaultDeck } from '@agent-deck/shared';

import {
  formatDefaultResult,
  parseDefaultArgs,
  runDefault,
  type DefaultDeps,
} from './default-deck';

const DECKS = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'alpha' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'beta' },
];

const deps: DefaultDeps = {
  resolveDeck: async (ref: string) => {
    const trimmed = ref.trim();
    return (
      DECKS.find((deck) => deck.id === trimmed || deck.name === trimmed) ?? null
    );
  },
};

describe('agent-deck default (NOT-600)', () => {
  let tempHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.AGENT_DECK_HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-default-cli-'));
    process.env.AGENT_DECK_HOME = tempHome;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('bare shows none when no default is set', async () => {
    const result = await runDefault({ clear: false }, deps);
    expect(result).toMatchObject({ action: 'show', current: null });
    if ('error' in result) throw new Error('unexpected error');
    expect(formatDefaultResult(result)).toBe('No default deck set.');
  });

  it('sets by name then bare shows id plus name', async () => {
    const set = await runDefault({ deckRef: 'alpha', clear: false }, deps);
    expect(set).toMatchObject({ action: 'set' });
    if ('error' in set) throw new Error('unexpected error');
    expect(set.current).toMatchObject({ deckId: DECKS[0].id, deckName: 'alpha' });
    expect(formatDefaultResult(set)).toBe(
      `Default deck set to alpha (${DECKS[0].id})`,
    );

    const show = await runDefault({ clear: false }, deps);
    if ('error' in show) throw new Error('unexpected error');
    expect(formatDefaultResult(show)).toBe(`Default deck: alpha (${DECKS[0].id})`);
    expect(readDefaultDeck()?.deckId).toBe(DECKS[0].id);
  });

  it('sets by id and overwrites the previous default', async () => {
    await runDefault({ deckRef: 'alpha', clear: false }, deps);
    const set = await runDefault({ deckRef: DECKS[1].id, clear: false }, deps);
    if ('error' in set) throw new Error('unexpected error');
    expect(set.previous?.deckId).toBe(DECKS[0].id);
    expect(set.current).toMatchObject({ deckId: DECKS[1].id, deckName: 'beta' });
  });

  it('rejects an unknown deck without touching the stored default', async () => {
    await runDefault({ deckRef: 'alpha', clear: false }, deps);
    const result = await runDefault({ deckRef: 'nope', clear: false }, deps);
    expect(result).toEqual({ error: 'Deck not found: nope' });
    expect(readDefaultDeck()?.deckId).toBe(DECKS[0].id);
  });

  it('clears the default; clearing again reports nothing to clear', async () => {
    await runDefault({ deckRef: 'alpha', clear: false }, deps);
    const cleared = await runDefault({ clear: true }, deps);
    if ('error' in cleared) throw new Error('unexpected error');
    expect(cleared).toMatchObject({ action: 'clear', cleared: true, current: null });
    expect(formatDefaultResult(cleared)).toBe('Default deck cleared.');
    expect(readDefaultDeck()).toBeNull();

    const again = await runDefault({ clear: true }, deps);
    if ('error' in again) throw new Error('unexpected error');
    expect(again.cleared).toBe(false);
    expect(formatDefaultResult(again)).toBe('No default deck was set.');
  });

  it('rejects a deck plus --clear and unknown options', () => {
    expect(parseDefaultArgs(['alpha', '--clear'])).toEqual({
      error: 'Pass either a deck or --clear, not both',
    });
    expect(parseDefaultArgs(['--bogus'])).toEqual({
      error: 'Unknown default option: --bogus',
    });
    expect(parseDefaultArgs(['alpha', 'beta'])).toEqual({
      error: 'Unexpected argument: beta',
    });
    expect(parseDefaultArgs(['--clear'])).toEqual({ clear: true, deckRef: undefined });
    expect(parseDefaultArgs([])).toEqual({ clear: false, deckRef: undefined });
  });
});
