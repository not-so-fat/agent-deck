import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUnderStoreRoot, realAgentDeckHome, resolveAgentDeckHome } from './agent-deck-home';

describe('resolveAgentDeckHome under a test runner', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AGENT_DECK_HOME;
    delete process.env.AGENT_DECK_DEV;
    delete process.env.AGENT_DECK_ALLOW_REAL_HOME_IN_TESTS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('refuses to fall back to the real store', () => {
    expect(() => resolveAgentDeckHome()).toThrow(/Refusing to use the real Agent Deck store/);
  });

  it('refuses the dev subdir of the real store', () => {
    process.env.AGENT_DECK_DEV = '1';
    expect(() => resolveAgentDeckHome()).toThrow(/Refusing to use the real Agent Deck store/);
  });

  it('refuses an AGENT_DECK_HOME pointed at the real store', () => {
    process.env.AGENT_DECK_HOME = path.join(realAgentDeckHome(), 'dev');
    expect(() => resolveAgentDeckHome()).toThrow(/Refusing to use the real Agent Deck store/);
  });

  it('allows an isolated AGENT_DECK_HOME', () => {
    const home = path.join(os.tmpdir(), 'agent-deck-home-spec');
    process.env.AGENT_DECK_HOME = home;
    expect(resolveAgentDeckHome()).toBe(home);
  });

  it('allows the real store only behind the explicit opt-out', () => {
    process.env.AGENT_DECK_ALLOW_REAL_HOME_IN_TESTS = '1';
    expect(resolveAgentDeckHome()).toBe(realAgentDeckHome());
  });
});

describe('isUnderStoreRoot', () => {
  // The store root is routinely a symlink into a git-synced tree, so a lexical-only
  // check would let a realpath of it — or a link pointing back at it — look isolated.
  // Both sides live in tmp here: the real ~/.agent-deck is never read or created.
  let dir: string;
  let root: string;
  let link: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-root-spec-'));
    root = path.join(dir, 'store');
    link = path.join(dir, 'link-to-store');
    fs.mkdirSync(path.join(root, 'decks'), { recursive: true });
    fs.symlinkSync(root, link);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('matches the root itself and paths inside it', () => {
    expect(isUnderStoreRoot(root, root)).toBe(true);
    expect(isUnderStoreRoot(path.join(root, 'decks'), root)).toBe(true);
  });

  it('matches a symlink that resolves to the root', () => {
    expect(isUnderStoreRoot(link, root)).toBe(true);
    expect(isUnderStoreRoot(path.join(link, 'decks'), root)).toBe(true);
  });

  it('matches the root when the root itself is the symlink', () => {
    expect(isUnderStoreRoot(root, link)).toBe(true);
  });

  it('does not match an unrelated directory', () => {
    expect(isUnderStoreRoot(path.join(dir, 'elsewhere'), root)).toBe(false);
  });

  it('falls back to a lexical compare for a path that does not exist yet', () => {
    const missing = path.join(dir, 'not-created');
    expect(isUnderStoreRoot(path.join(missing, 'decks'), missing)).toBe(true);
    expect(isUnderStoreRoot(path.join(dir, 'other'), missing)).toBe(false);
  });
});
