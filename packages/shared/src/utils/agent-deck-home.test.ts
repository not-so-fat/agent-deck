import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { realAgentDeckHome, resolveAgentDeckHome } from './agent-deck-home';

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
