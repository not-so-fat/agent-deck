import os from 'node:os';
import path from 'node:path';

/** Prefix every isolated store root shares — teardown refuses to delete anything else. */
export const TEST_HOME_PREFIX = 'agent-deck-test-';

/**
 * Per-run Agent Deck home for one package's vitest process, so tests never touch
 * the developer's real ~/.agent-deck. Call from vitest.config.ts: it sets the
 * variable for the main process (config + globalSetup) and returns the path so
 * the caller can also hand it to workers via `test.env`.
 */
export function useIsolatedAgentDeckHome(pkg) {
  const home = path.join(os.tmpdir(), `${TEST_HOME_PREFIX}${pkg}-${process.pid}`);
  process.env.AGENT_DECK_HOME = home;
  return home;
}
