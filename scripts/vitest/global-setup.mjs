import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

export async function setup() {
  await fs.mkdir(isolatedHome(), { recursive: true });
}

export async function teardown() {
  const home = isolatedHome();
  if (process.env.AGENT_DECK_KEEP_TEST_HOME === '1') {
    // Debugging aid: inspect what the run wrote instead of dropping it.
    console.log(`[agent-deck] keeping test store at ${home}`);
    return;
  }
  await fs.rm(home, { recursive: true, force: true });
}
