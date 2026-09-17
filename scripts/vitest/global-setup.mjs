import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assertRealDeckSurvived, readRealDeckPids } from './real-deck-canary.mjs';
import { CLI_DEFAULT_BACKEND_PORT, CLI_DEFAULT_MCP_PORT } from './deck-default-ports.mjs';
import { assertSharedBuildGuardsRealStore } from './shared-build-guard.mjs';
import { TEST_HOME_PREFIX } from './test-home.mjs';

/** Only a tmpdir path this repo minted is safe to create and rm -rf. */
function isolatedHome() {
  const home = process.env.AGENT_DECK_HOME;
  if (!home) {
    throw new Error(
      'AGENT_DECK_HOME is unset — call useIsolatedAgentDeckHome() in vitest.config.ts before tests run.',
    );
  }
  const expectedParent = path.resolve(os.tmpdir());
  if (
    path.dirname(path.resolve(home)) !== expectedParent ||
    !path.basename(home).startsWith(TEST_HOME_PREFIX)
  ) {
    throw new Error(
      `AGENT_DECK_HOME (${home}) is not an isolated test store; expected ${expectedParent}/${TEST_HOME_PREFIX}*.`,
    );
  }
  return home;
}

/** Real-deck pids observed before the suite ran; empty when no deck is up. */
let realDeckPids = [];

/**
 * A test process that keeps the default ports can reach the developer's own
 * deck no matter which home it uses, because `stop`/`status` resolve ports from
 * the environment and `runStop` kills whatever listens on them. Fail before a
 * single test runs rather than after one has stopped the deck.
 */
function assertPortsCannotReachRealDeck() {
  const pairs = [
    ['AGENT_DECK_BACKEND_PORT', CLI_DEFAULT_BACKEND_PORT],
    ['AGENT_DECK_MCP_PORT', CLI_DEFAULT_MCP_PORT],
  ];
  for (const [name, realPort] of pairs) {
    const value = process.env[name];
    if (!value) {
      throw new Error(
        `${name} is unset — call useUnreachableDeckPorts() in vitest.config.ts. ` +
          'Without it the CLI falls back to the real deck\'s ports.',
      );
    }
    if (Number(value) === realPort) {
      throw new Error(
        `${name}=${value} is the developer's own deck. A test run must never be able to reach it.`,
      );
    }
  }
}

export async function setup(ctx) {
  assertPortsCannotReachRealDeck();
  // Before anything can write: the guard that keeps writes out of the real store
  // ships in a build, and a stale build drops it silently (NOT-138).
  const guard = await assertSharedBuildGuardsRealStore(ctx?.config?.root ?? process.cwd());
  if (!guard.checked) {
    // Say so out loud: a check that quietly decided not to run is how NOT-138 happened.
    console.log(`[agent-deck] shared build check skipped — ${guard.reason}`);
  }
  await fs.mkdir(isolatedHome(), { recursive: true });
  // Independent of how any individual test is written: if this run stops the
  // developer's own deck, teardown says so instead of leaving a dead daemon and
  // a stuck queue for someone to discover hours later.
  realDeckPids = readRealDeckPids();
}

export async function teardown() {
  // Before the store cleanup, so a suite that killed the real deck fails loudly
  // even if the rm below were to throw.
  assertRealDeckSurvived(realDeckPids);

  const home = isolatedHome();
  if (process.env.AGENT_DECK_KEEP_TEST_HOME === '1') {
    // Debugging aid: inspect what the run wrote instead of dropping it.
    console.log(`[agent-deck] keeping test store at ${home}`);
    return;
  }
  await fs.rm(home, { recursive: true, force: true });
}
