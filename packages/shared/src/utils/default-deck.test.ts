import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearDefaultDeck,
  readDefaultDeck,
  resolveDefaultDeckPath,
  writeDefaultDeck,
} from './default-deck';

describe('user default deck store (NOT-600)', () => {
  const tmpDirs: string[] = [];
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.AGENT_DECK_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-default-deck-'));
    tmpDirs.push(dir);
    process.env.AGENT_DECK_HOME = dir;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('reads null when no default is set', () => {
    expect(readDefaultDeck()).toBeNull();
  });

  it('writes then reads the default deck by id', () => {
    const target = writeDefaultDeck({ deckId: 'deck-1', deckName: 'alpha' });
    expect(target).toBe(resolveDefaultDeckPath());
    expect(target).toBe(path.join(process.env.AGENT_DECK_HOME!, 'default-deck.json'));

    const stored = readDefaultDeck();
    expect(stored).toMatchObject({ version: 1, deckId: 'deck-1', deckName: 'alpha' });
    expect(typeof stored?.updatedAt).toBe('string');

    const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>;
    expect(raw.version).toBe(1);
  });

  it('creates the home dir on write', () => {
    const nested = path.join(tmpDirs[0], 'nested', 'home');
    process.env.AGENT_DECK_HOME = nested;
    writeDefaultDeck({ deckId: 'deck-1', deckName: 'alpha' });
    expect(readDefaultDeck()?.deckId).toBe('deck-1');
  });

  it('clears an existing default and reports nothing to clear afterwards', () => {
    expect(clearDefaultDeck()).toBe(false);
    writeDefaultDeck({ deckId: 'deck-1', deckName: 'alpha' });
    expect(clearDefaultDeck()).toBe(true);
    expect(fs.existsSync(resolveDefaultDeckPath())).toBe(false);
    expect(readDefaultDeck()).toBeNull();
    expect(clearDefaultDeck()).toBe(false);
  });

  it('reads null for corrupt, wrong-version, or blank content without throwing', () => {
    const target = resolveDefaultDeckPath();
    for (const content of [
      '{not json',
      JSON.stringify({ version: 2, deckId: 'd', deckName: 'n', updatedAt: 't' }),
      JSON.stringify({ version: 1, deckId: '  ', deckName: 'n', updatedAt: 't' }),
      JSON.stringify({ version: 1, deckName: 'n', updatedAt: 't' }),
      JSON.stringify({ version: 1, deckId: 'd', deckName: 'n' }),
    ]) {
      fs.writeFileSync(target, content, 'utf8');
      expect(readDefaultDeck(), `content: ${content}`).toBeNull();
    }
    fs.rmSync(target);
    expect(readDefaultDeck()).toBeNull();
  });

  it('trims id and name on read and write', () => {
    writeDefaultDeck({ deckId: '  deck-1 ', deckName: ' alpha  ' });
    expect(readDefaultDeck()).toMatchObject({ deckId: 'deck-1', deckName: 'alpha' });
  });
});
