import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Escape hatch for the test guard below. Only for tests that assert default path
 * resolution and never write — never for tests that touch the store.
 */
const ALLOW_REAL_HOME_IN_TESTS_ENV = 'AGENT_DECK_ALLOW_REAL_HOME_IN_TESTS';

/** Dev monorepo / tsx — separate data dir from production `agent-deck start`. */
export function isAgentDeckDevMode(): boolean {
  const flag = process.env.AGENT_DECK_DEV?.trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') {
    return true;
  }
  if (flag === '0' || flag === 'false' || flag === 'no') {
    return false;
  }
  return process.env.NODE_ENV === 'development';
}

/** The user's real store root. Both this and its `dev/` subdir are real user data. */
export function realAgentDeckHome(): string {
  return path.join(os.homedir(), '.agent-deck');
}

/** Vitest sets VITEST=true and NODE_ENV=test; either marks a test process. */
function isTestRunnerProcess(): boolean {
  const vitest = process.env.VITEST?.trim().toLowerCase();
  return vitest === '1' || vitest === 'true' || process.env.NODE_ENV === 'test';
}

function containsOrEquals(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * `realpathSync` throws on a path that does not exist yet; the literal path is then
 * all there is to compare, and the lexical pass has already used it.
 */
function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Exported for tests: is `target` the store root at `root`, or inside it?
 *
 * Compares lexically first, then again through `realpathSync`, because this store root
 * is routinely a symlink into a git-synced tree (and so are its children). A
 * lexical-only check lets `AGENT_DECK_HOME=<realpath of ~/.agent-deck>`, or a link
 * pointing back at it, write to the real store while looking isolated.
 */
export function isUnderStoreRoot(target: string, root: string): boolean {
  if (containsOrEquals(root, target)) {
    return true;
  }
  return containsOrEquals(realpathOrSelf(root), realpathOrSelf(target));
}

function isRealAgentDeckHome(target: string): boolean {
  return isUnderStoreRoot(target, realAgentDeckHome());
}

function agentDeckHomeFromEnv(): string {
  if (process.env.AGENT_DECK_HOME?.trim()) {
    return path.resolve(process.env.AGENT_DECK_HOME.trim());
  }

  const base = realAgentDeckHome();
  return isAgentDeckDevMode() ? path.join(base, 'dev') : base;
}

/**
 * Agent Deck data root: SQLite, credential yaml metadata, dev secret files.
 * Production CLI → ~/.agent-deck
 * Monorepo dev (AGENT_DECK_DEV=1) → ~/.agent-deck/dev
 *
 * Under a test runner this throws rather than hand back the real store, so a test
 * that forgets to isolate `AGENT_DECK_HOME` fails loudly instead of writing stray
 * decks and services into the developer's (often git-synced) store.
 */
export function resolveAgentDeckHome(): string {
  const home = agentDeckHomeFromEnv();

  // Test-runner check first: production never pays for the realpath syscalls.
  if (
    isTestRunnerProcess() &&
    process.env[ALLOW_REAL_HOME_IN_TESTS_ENV]?.trim() !== '1' &&
    isRealAgentDeckHome(home)
  ) {
    throw new Error(
      `Refusing to use the real Agent Deck store (${home}) from a test process. ` +
        'Set AGENT_DECK_HOME to a temp dir for this test — each package vitest config ' +
        'already points the whole run at one. If the test only asserts default path ' +
        `resolution and writes nothing, set ${ALLOW_REAL_HOME_IN_TESTS_ENV}=1.`,
    );
  }

  return home;
}
