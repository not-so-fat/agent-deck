import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isAgentDeckDevMode,
  resolveAgentDeckHome,
  resolveDatabasePath,
} from './paths';

describe('agent deck paths', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-paths-'));
    delete process.env.AGENT_DECK_HOME;
    delete process.env.AGENT_DECK_DB_PATH;
    delete process.env.AGENT_DECK_USE_CWD_DB;
    delete process.env.AGENT_DECK_DEV;
    delete process.env.NODE_ENV;
    // These cases assert default path resolution only; nothing here writes a store.
    process.env.AGENT_DECK_ALLOW_REAL_HOME_IN_TESTS = '1';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses production home by default', () => {
    const expected = path.join(os.homedir(), '.agent-deck', 'agent_deck.db');
    expect(resolveDatabasePath()).toBe(expected);
    expect(resolveAgentDeckHome()).toBe(path.join(os.homedir(), '.agent-deck'));
  });

  it('uses ~/.agent-deck/dev when AGENT_DECK_DEV=1', () => {
    process.env.AGENT_DECK_DEV = '1';
    const home = path.join(os.homedir(), '.agent-deck', 'dev');
    expect(resolveAgentDeckHome()).toBe(home);
    expect(resolveDatabasePath()).toBe(path.join(home, 'agent_deck.db'));
    expect(isAgentDeckDevMode()).toBe(true);
  });

  it('forces production home when AGENT_DECK_DEV=0 even if NODE_ENV=development', () => {
    process.env.AGENT_DECK_DEV = '0';
    process.env.NODE_ENV = 'development';
    expect(isAgentDeckDevMode()).toBe(false);
    expect(resolveAgentDeckHome()).toBe(path.join(os.homedir(), '.agent-deck'));
  });

  it('uses ~/.agent-deck even when cwd has agent_deck.db', () => {
    const cwdDb = path.join(process.cwd(), 'agent_deck.db');
    const hadCwdDb = fs.existsSync(cwdDb);
    const homeDb = path.join(os.homedir(), '.agent-deck', 'agent_deck.db');

    try {
      if (!hadCwdDb) {
        fs.writeFileSync(cwdDb, '');
      }

      expect(resolveDatabasePath()).toBe(homeDb);
    } finally {
      if (!hadCwdDb && fs.existsSync(cwdDb)) {
        fs.unlinkSync(cwdDb);
      }
    }
  });

  it('honors AGENT_DECK_DB_PATH', () => {
    const custom = path.join(tempDir, 'custom.db');
    process.env.AGENT_DECK_DB_PATH = custom;
    expect(resolveDatabasePath()).toBe(custom);
  });

  it('uses cwd db only when AGENT_DECK_USE_CWD_DB=1', () => {
    const cwdDb = path.join(process.cwd(), 'agent_deck.db');
    const hadCwdDb = fs.existsSync(cwdDb);

    try {
      if (!hadCwdDb) {
        fs.writeFileSync(cwdDb, '');
      }
      process.env.AGENT_DECK_USE_CWD_DB = '1';
      expect(resolveDatabasePath()).toBe(cwdDb);
    } finally {
      if (!hadCwdDb && fs.existsSync(cwdDb)) {
        fs.unlinkSync(cwdDb);
      }
    }
  });
});
