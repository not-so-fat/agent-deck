import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — repo script, consumed by vitest configs; not part of the TS build.
import { assertSharedBuildGuardsRealStore } from '../../../../scripts/vitest/shared-build-guard.mjs';

/**
 * NOT-138: the real-store guard (NOT-122) lives in @agent-deck/shared's build, so a
 * stale build silently removes it and tests write into the developer's ~/.agent-deck.
 * These cases exercise the check against a synthetic shared package; the backend suite
 * you are reading this in already ran it for real, from the vitest global setup.
 */
describe('assertSharedBuildGuardsRealStore', () => {
  const originalSkip = process.env.AGENT_DECK_SKIP_SHARED_BUILD_CHECK;
  let dir: string;
  let consumer: string;
  let shared: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-build-guard-'));
    consumer = path.join(dir, 'consumer');
    shared = path.join(consumer, 'node_modules', '@agent-deck', 'shared');
    fs.mkdirSync(path.join(shared, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(shared, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer' }));
    fs.writeFileSync(
      path.join(shared, 'package.json'),
      JSON.stringify({ name: '@agent-deck/shared', main: 'dist/index.js' }),
    );
    writeSource('// the guard');
    writeBuild(GUARDED_BUILD);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (originalSkip === undefined) {
      delete process.env.AGENT_DECK_SKIP_SHARED_BUILD_CHECK;
    } else {
      process.env.AGENT_DECK_SKIP_SHARED_BUILD_CHECK = originalSkip;
    }
  });

  it('passes when the build is current and still refuses the real store', async () => {
    await expect(assertSharedBuildGuardsRealStore(consumer)).resolves.toMatchObject({
      checked: true,
    });
  });

  it('names the rebuild when the build predates the source', async () => {
    touchSourceAfterBuild();

    await expect(assertSharedBuildGuardsRealStore(consumer)).rejects.toThrow(
      /build is stale[\s\S]*npm run build/,
    );
  });

  it('ignores test sources, which the build never emits, when dating the build', async () => {
    const spec = path.join(shared, 'src', 'utils', 'agent-deck-home.test.ts');
    fs.writeFileSync(spec, '// edited long after the last build');
    fs.utimesSync(spec, LATER, LATER);

    await expect(assertSharedBuildGuardsRealStore(consumer)).resolves.toMatchObject({
      checked: true,
    });
  });

  it('dates the build against a .spec.ts source, which the build does emit', async () => {
    const spec = path.join(shared, 'src', 'utils', 'agent-deck-home.spec.ts');
    fs.writeFileSync(spec, '// edited long after the last build');
    fs.utimesSync(spec, LATER, LATER);

    await expect(assertSharedBuildGuardsRealStore(consumer)).rejects.toThrow(/build is stale/);
  });

  it('checks a build hidden behind an exports map instead of skipping the package', async () => {
    fs.writeFileSync(
      path.join(shared, 'package.json'),
      JSON.stringify({
        name: '@agent-deck/shared',
        main: 'dist/index.js',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeBuild('exports.resolveAgentDeckHome = () => "/anywhere";');

    await expect(assertSharedBuildGuardsRealStore(consumer)).rejects.toThrow(
      /missing the real-store guard/,
    );
  });

  it('reports a half-written build as a rebuild, not as a raw syntax error', async () => {
    writeBuild('exports.resolveAgentDeckHome = function () {');

    await expect(assertSharedBuildGuardsRealStore(consumer)).rejects.toThrow(
      /missing the real-store guard[\s\S]*loading the build threw[\s\S]*npm run build/,
    );
  });

  it('refuses a build whose resolveAgentDeckHome hands back the real store', async () => {
    writeBuild("exports.resolveAgentDeckHome = () => require('node:os').homedir() + '/.agent-deck';");

    await expect(assertSharedBuildGuardsRealStore(consumer)).rejects.toThrow(
      /missing the real-store guard[\s\S]*npm run build/,
    );
  });

  it('refuses a build too old to export resolveAgentDeckHome at all', async () => {
    writeBuild('exports.somethingElse = 1;');

    await expect(assertSharedBuildGuardsRealStore(consumer)).rejects.toThrow(
      /does not export resolveAgentDeckHome/,
    );
  });

  it('refuses a package that was never built', async () => {
    fs.rmSync(path.join(shared, 'dist'), { recursive: true });

    await expect(assertSharedBuildGuardsRealStore(consumer)).rejects.toThrow(
      /has not been built[\s\S]*npm run build/,
    );
  });

  it('still refuses a guardless build when the freshness check is opted out of', async () => {
    process.env.AGENT_DECK_SKIP_SHARED_BUILD_CHECK = '1';
    writeBuild('exports.resolveAgentDeckHome = () => "/anywhere";');
    touchSourceAfterBuild();

    await expect(assertSharedBuildGuardsRealStore(consumer)).rejects.toThrow(
      /missing the real-store guard/,
    );
  });

  it('runs a stale build once the freshness check is opted out of', async () => {
    process.env.AGENT_DECK_SKIP_SHARED_BUILD_CHECK = '1';
    touchSourceAfterBuild();

    await expect(assertSharedBuildGuardsRealStore(consumer)).resolves.toMatchObject({
      checked: true,
    });
  });

  it('skips a package that does not depend on @agent-deck/shared', async () => {
    const stranger = path.join(dir, 'stranger');
    fs.mkdirSync(stranger);
    fs.writeFileSync(path.join(stranger, 'package.json'), JSON.stringify({ name: 'stranger' }));

    await expect(assertSharedBuildGuardsRealStore(stranger)).resolves.toMatchObject({
      checked: false,
    });
  });

  it('skips the shared package checking its own build, since its tests import source', async () => {
    writeBuild('exports.resolveAgentDeckHome = () => "/anywhere";');

    await expect(assertSharedBuildGuardsRealStore(shared)).resolves.toMatchObject({
      checked: false,
    });
  });

  function writeSource(body: string): void {
    const file = path.join(shared, 'src', 'utils', 'agent-deck-home.ts');
    fs.writeFileSync(file, body);
    fs.utimesSync(file, EARLIER, EARLIER);
  }

  /** Every build file is written after every source file, as a real build leaves them. */
  function writeBuild(body: string): void {
    const file = path.join(shared, 'dist', 'index.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    fs.utimesSync(file, BUILT, BUILT);
  }

  function touchSourceAfterBuild(): void {
    fs.utimesSync(path.join(shared, 'src', 'utils', 'agent-deck-home.ts'), LATER, LATER);
  }
});

/** Fixed mtimes, so the check is never racing the clock of the machine running it. */
const EARLIER = new Date('2026-09-16T08:00:00Z');
const BUILT = new Date('2026-09-16T08:30:00Z');
const LATER = new Date('2026-09-16T09:00:00Z');

/** A build that still carries the NOT-122 guard, reduced to the part being probed. */
const GUARDED_BUILD = [
  'exports.resolveAgentDeckHome = function () {',
  '  if (process.env.AGENT_DECK_HOME) return process.env.AGENT_DECK_HOME;',
  '  throw new Error("Refusing to use the real Agent Deck store (~/.agent-deck) from a test process.");',
  '};',
].join('\n');
