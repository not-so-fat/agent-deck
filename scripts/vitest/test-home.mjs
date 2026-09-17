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

/**
 * Ports every test process starts with. `stop`/`status` resolve ports from the
 * environment, and `runStop` kills whatever listens on them — so an isolated
 * AGENT_DECK_HOME alone never protected the developer's deck: with no port pin
 * the CLI falls back to 1111/1110 and acts on the real daemon (NOT-135).
 *
 * Port 0 is not a listening port, so a probe can never find a deck here and
 * `stop` can never match a pid. A test that genuinely needs a running deck
 * reserves free ports through the integration harness, which overrides these.
 */
export const UNREACHABLE_DECK_PORTS = Object.freeze({
  AGENT_DECK_BACKEND_PORT: '0',
  AGENT_DECK_MCP_PORT: '0',
});

/** Set the unreachable defaults on this process and return them for `test.env`. */
export function useUnreachableDeckPorts() {
  Object.assign(process.env, UNREACHABLE_DECK_PORTS);
  return { ...UNREACHABLE_DECK_PORTS };
}
