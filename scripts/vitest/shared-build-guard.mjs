import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * NOT-138: every package except @agent-deck/shared itself loads the real-store guard
 * (NOT-122) from `packages/shared/dist`, not from source. When that build lags the
 * source the guard is simply absent at runtime and store writes go to the developer's
 * real ~/.agent-deck — the guard fails open, and its own tests are the ones that fail,
 * so the symptom reads as "3 broken tests" rather than "your store was just written to".
 *
 * These checks run from the vitest global setup, before any suite is collected.
 */

/** The guard's own error text — the string a build must contain to be protecting anything. */
const GUARD_ERROR = /Refusing to use the real Agent Deck store/;

/** Skips the mtime freshness check only. The guard probe below is never skippable. */
const SKIP_FRESHNESS_ENV = 'AGENT_DECK_SKIP_SHARED_BUILD_CHECK';

/** Module resolution reports realpaths; a caller's root may still be a symlink. */
function canonical(target) {
  try {
    return fs.realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

/**
 * The one `exclude` pattern in packages/shared/tsconfig.json that matches a source
 * file: editing a test emits nothing, so it cannot make a build stale. Everything
 * else under src/ — `.spec.ts` included, since that tsconfig's `exclude` replaces
 * the root one rather than extending it — does.
 */
function isSourceOnly(file) {
  return file.endsWith('.test.ts');
}

/** Newest file in `dir`, or null when the tree is missing or empty. */
export function newestFile(dir, isIgnored = () => false) {
  let newest = null;

  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') {
          walk(full);
        }
        continue;
      }
      if (!entry.isFile() || isIgnored(full)) {
        continue;
      }
      let mtimeMs;
      try {
        ({ mtimeMs } = fs.statSync(full));
      } catch {
        continue; // A `tsc --watch` rewriting dist under us is not a reason to fail.
      }
      if (!newest || mtimeMs > newest.mtimeMs) {
        newest = { path: full, mtimeMs };
      }
    }
  };

  walk(dir);
  return newest;
}

/**
 * Path to @agent-deck/shared's package.json, or null only when the package is genuinely
 * not installed. Reading it through the `package.json` subpath is the cheap way in, but
 * an `exports` map would hide that subpath — falling back to the package entry keeps a
 * future ESM migration from turning this whole check into a silent no-op, which is the
 * failure mode it exists to prevent.
 */
function resolveSharedManifest(require) {
  try {
    return require.resolve('@agent-deck/shared/package.json');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw error;
    }
  }

  let entry;
  try {
    entry = require.resolve('@agent-deck/shared');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
    // An unbuilt package resolves far enough to name the manifest it read; an absent
    // one does not. Only the latter means "this package is not a consumer".
    return typeof error.path === 'string' && fs.existsSync(error.path) ? error.path : null;
  }

  for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`Resolved @agent-deck/shared to ${entry}, which sits in no package.`);
    }
  }
}

/**
 * Locate the @agent-deck/shared a consumer package would load at runtime. Resolving
 * from the consumer (rather than assuming a path) is what makes the check honest: in a
 * git worktree without its own node_modules, resolution walks up into another checkout,
 * and this reports the build that is actually loaded there.
 */
export function findSharedPackage(consumerRoot) {
  const require = createRequire(path.join(path.resolve(consumerRoot), 'package.json'));
  const manifestPath = resolveSharedManifest(require);
  if (!manifestPath) {
    return null; // Not a consumer of the shared package.
  }

  const root = path.dirname(manifestPath);
  const main = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).main ?? 'index.js';
  return { root, entry: path.join(root, main), srcDir: path.join(root, 'src') };
}

/**
 * Is the build older than the source it was built from? Returns the two offending
 * files so the message can name them, or null when the build is current.
 */
export function findStaleBuild({ entry, srcDir }) {
  const distDir = path.dirname(entry);
  if (path.resolve(distDir) === path.resolve(srcDir)) {
    return null; // Aliased straight at source — there is no build to go stale.
  }

  const newestSource = newestFile(srcDir, isSourceOnly);
  const newestBuild = newestFile(distDir);
  if (!newestSource || !newestBuild || newestBuild.mtimeMs >= newestSource.mtimeMs) {
    return null;
  }
  return { newestSource, newestBuild };
}

function when(mtimeMs) {
  return new Date(mtimeMs).toISOString();
}

function rebuildHint(root) {
  return [
    `Rebuild it:  npm run build --workspace @agent-deck/shared   (in ${path.dirname(path.dirname(root))})`,
    'or rebuild everything:  npm run build',
  ].join('\n  ');
}

/** Load the built module the way a consumer does — CJS today, ESM-tolerant anyway. */
async function loadShared(entry) {
  const require = createRequire(entry);
  try {
    return require(entry);
  } catch (error) {
    if (error?.code !== 'ERR_REQUIRE_ESM') {
      throw error;
    }
    const namespace = await import(pathToFileURL(entry).href);
    return namespace.default ?? namespace;
  }
}

/**
 * Does the loaded build still refuse the real store? Runs `resolveAgentDeckHome()`
 * under the conditions the guard exists for — test runner, no isolated home — which
 * reads paths and writes nothing.
 */
async function probeGuard(entry) {
  let shared;
  try {
    shared = await loadShared(entry);
  } catch (error) {
    // A half-written build (interrupted `tsc`) belongs in the rebuild message, not
    // as a raw SyntaxError out of the global setup.
    return { ok: false, detail: `loading the build threw: ${error?.message}` };
  }
  if (typeof shared?.resolveAgentDeckHome !== 'function') {
    return { ok: false, detail: 'the build does not export resolveAgentDeckHome()' };
  }

  const saved = {
    VITEST: process.env.VITEST,
    NODE_ENV: process.env.NODE_ENV,
    AGENT_DECK_HOME: process.env.AGENT_DECK_HOME,
    AGENT_DECK_DEV: process.env.AGENT_DECK_DEV,
    AGENT_DECK_ALLOW_REAL_HOME_IN_TESTS: process.env.AGENT_DECK_ALLOW_REAL_HOME_IN_TESTS,
  };
  process.env.VITEST = 'true';
  delete process.env.AGENT_DECK_HOME;
  delete process.env.AGENT_DECK_DEV;
  delete process.env.AGENT_DECK_ALLOW_REAL_HOME_IN_TESTS;

  try {
    const home = shared.resolveAgentDeckHome();
    return { ok: false, detail: `resolveAgentDeckHome() returned ${home} instead of throwing` };
  } catch (error) {
    if (GUARD_ERROR.test(error?.message ?? '')) {
      return { ok: true };
    }
    return { ok: false, detail: `resolveAgentDeckHome() threw an unrelated error: ${error?.message}` };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Throw unless the @agent-deck/shared build this package will load still carries the
 * real-store guard. Call before any suite runs; a store write must never be the thing
 * that discovers a stale build.
 */
export async function assertSharedBuildGuardsRealStore(consumerRoot) {
  const shared = findSharedPackage(consumerRoot);
  if (!shared) {
    return { checked: false, reason: 'no @agent-deck/shared dependency' };
  }
  if (canonical(shared.root) === canonical(consumerRoot)) {
    // @agent-deck/shared testing itself: its suites import source, not the build.
    return { checked: false, reason: 'shared package tests its own source' };
  }

  if (!fs.existsSync(shared.entry)) {
    throw new Error(
      [
        '@agent-deck/shared has not been built, so these tests cannot load it.',
        '',
        `  missing: ${shared.entry}`,
        '',
        `  ${rebuildHint(shared.root)}`,
      ].join('\n'),
    );
  }

  const stale = findStaleBuild(shared);
  if (stale && process.env[SKIP_FRESHNESS_ENV]?.trim() !== '1') {
    throw new Error(
      [
        'The @agent-deck/shared build is stale — these tests would run against outdated code.',
        '',
        `  newest source: ${stale.newestSource.path} (${when(stale.newestSource.mtimeMs)})`,
        `  newest build:  ${stale.newestBuild.path} (${when(stale.newestBuild.mtimeMs)})`,
        '',
        'Tests load @agent-deck/shared from its build, so a stale build silently reverts',
        'source changes — including the guard that keeps store writes out of your real',
        '~/.agent-deck (NOT-122, NOT-138).',
        '',
        `  ${rebuildHint(shared.root)}`,
        '',
        `To run anyway (the real-store guard is still checked): ${SKIP_FRESHNESS_ENV}=1`,
      ].join('\n'),
    );
  }

  const probe = await probeGuard(shared.entry);
  if (!probe.ok) {
    throw new Error(
      [
        'The @agent-deck/shared build is missing the real-store guard — refusing to run tests.',
        '',
        `  loaded: ${shared.entry}`,
        `  guard:  ${path.join(shared.srcDir, 'utils', 'agent-deck-home.ts')}`,
        `  probe:  ${probe.detail}`,
        '',
        'Without the guard, any test that writes to the store writes into your real',
        '~/.agent-deck instead of the isolated test home (NOT-122, NOT-138).',
        '',
        `  ${rebuildHint(shared.root)}`,
      ].join('\n'),
    );
  }

  return { checked: true, entry: shared.entry };
}
