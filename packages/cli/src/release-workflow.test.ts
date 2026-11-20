import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * NOT-642: the tag-pushed release workflow publishes with no npm credential,
 * so the pre-publish guard (release-guard.mjs) and the ordered,
 * skip-if-present publisher (release-publish.mjs) must be right. These tests
 * run both scripts as black boxes against temp fixtures: a minimal version
 * tree (+ temp git repo for the guard's on-main check), and a stub `npm`
 * on PATH for the publisher (the real registry is unreachable from tests).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const guardScript = path.join(repoRoot, 'scripts', 'release-guard.mjs');
const publishScript = path.join(repoRoot, 'scripts', 'release-publish.mjs');
const releaseScript = path.join(repoRoot, 'scripts', 'release.mjs');
const syncScript = path.join(repoRoot, 'scripts', 'sync-versions.mjs');

const VERSION = '9.9.9';
const TAG = `v${VERSION}`;
const WORKSPACE_MANIFESTS = [
  'packages/shared/package.json',
  'packages/backend/package.json',
  'packages/cli/package.json',
  'apps/agent-deck/package.json',
];

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function trackTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

interface FixtureOptions {
  rootVersion?: string;
  workspaceVersions?: Record<string, string>;
  serverVersion?: string;
  serverPackageVersion?: string;
  changelogSections?: string[];
  changelogFile?: boolean;
}

function makeReleaseFixture(options: FixtureOptions = {}): string {
  const dir = trackTemp('release-fixture-');
  const rootVersion = options.rootVersion ?? VERSION;
  writeJson(path.join(dir, 'package.json'), { name: 'agent-deck', version: rootVersion, private: true });
  for (const manifest of WORKSPACE_MANIFESTS) {
    writeJson(path.join(dir, manifest), {
      name: manifest,
      version: options.workspaceVersions?.[manifest] ?? VERSION,
    });
  }
  writeJson(path.join(dir, 'server.json'), {
    version: options.serverVersion ?? VERSION,
    packages: [{ identifier: '@agent-deck/cli', version: options.serverPackageVersion ?? VERSION }],
  });
  if (options.changelogFile !== false) {
    const sections = options.changelogSections ?? [rootVersion];
    const body = ['# Changelog', '', ...sections.flatMap((v) => [`## ${v} — 2026-11-19`, '', `- Release ${v}.`, ''])].join(
      '\n',
    );
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), body);
  }
  return dir;
}

/** Hermetic git env: temp repos must not read the developer's gitconfig. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
  };
}

function git(dir: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.email=release-test@example.test', '-c', 'user.name=release-test', ...args],
    { cwd: dir, stdio: 'ignore', env: gitEnv() },
  );
}

/** Fixture repo with the tag on main (the shippable shape). */
function initGitTagOnMain(dir: string, tag: string): void {
  git(dir, 'init', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', `Ship ${VERSION}: test release`);
  git(dir, 'tag', '-a', tag, '-m', `Agent Deck ${VERSION}`);
}

/** Fixture repo where main moved before the tagged commit (unshippable). */
function initGitTagOffMain(dir: string, tag: string): void {
  git(dir, 'init', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'before ship');
  fs.writeFileSync(path.join(dir, 'ship.txt'), 'ship\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', `Ship ${VERSION}: test release`);
  git(dir, 'tag', '-a', tag, '-m', `Agent Deck ${VERSION}`);
  git(dir, 'reset', '--hard', 'HEAD~1');
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

function runGuard(dir: string, tag: string, extraArgs: string[] = []): RunResult {
  return runScript(guardScript, [tag, '--root', dir, ...extraArgs], gitEnv());
}

/** Executable stub `npm` answering `view` from $STUB_NPM_PUBLISHED and logging `publish` to $STUB_NPM_CALLS. */
function installStubNpm(): { bin: string; callsFile: string; env: NodeJS.ProcessEnv } {
  const bin = trackTemp('stub-npm-bin-');
  const callsFile = path.join(trackTemp('stub-npm-calls-'), 'calls.log');
  const stub = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const [cmd, ...rest] = process.argv.slice(2);',
    'if (cmd === "view") {',
    '  const spec = rest[0];',
    '  if (process.env.STUB_NPM_VIEW_FAIL === "network") {',
    '    console.error("npm error code ECONNRESET\\nnpm error network request failed");',
    '    process.exit(1);',
    '  }',
    '  const published = (process.env.STUB_NPM_PUBLISHED ?? "").split(",").filter(Boolean);',
    '  if (published.includes(spec)) {',
    '    console.log(JSON.stringify(spec.slice(spec.lastIndexOf("@") + 1)));',
    '    process.exit(0);',
    '  }',
    '  console.error(`npm error code E404\\nnpm error 404 Not Found - ${spec} (stub)`);',
    '  process.exit(1);',
    '}',
    'if (cmd === "publish") {',
    '  fs.appendFileSync(process.env.STUB_NPM_CALLS, `publish ${rest.join(" ")}\\n`);',
    '  process.exit(0);',
    '}',
    'console.error(`stub npm: unexpected command ${cmd}`);',
    'process.exit(2);',
  ].join('\n');
  const stubPath = path.join(bin, 'npm');
  fs.writeFileSync(stubPath, stub);
  fs.chmodSync(stubPath, 0o755);
  return {
    bin,
    callsFile,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      STUB_NPM_CALLS: callsFile,
      STUB_NPM_PUBLISHED: '',
      NODE_AUTH_TOKEN: '',
    },
  };
}

function readCalls(callsFile: string): string[] {
  if (!fs.existsSync(callsFile)) {
    return [];
  }
  return fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean);
}

describe('release-guard.mjs', () => {
  it('passes for a consistent release tagged on main', () => {
    const dir = makeReleaseFixture();
    initGitTagOnMain(dir, TAG);
    const result = runGuard(dir, TAG, ['--main-ref', 'main']);
    expect(`${result.stdout}\n${result.stderr}`).toContain('All checks passed');
    expect(result.status).toBe(0);
  });

  it('defaults to main when origin/main is absent', () => {
    const dir = makeReleaseFixture();
    initGitTagOnMain(dir, TAG);
    const result = runGuard(dir, TAG);
    expect(result.status).toBe(0);
  });

  it('fails when the tag does not match the root version', () => {
    const dir = makeReleaseFixture({
      rootVersion: '9.9.8',
      workspaceVersions: Object.fromEntries(WORKSPACE_MANIFESTS.map((m) => [m, '9.9.8'])),
      serverVersion: '9.9.8',
      serverPackageVersion: '9.9.8',
      changelogSections: ['9.9.8', VERSION],
    });
    initGitTagOnMain(dir, TAG);
    const result = runGuard(dir, TAG, ['--main-ref', 'main']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`tag ${TAG} does not match root package.json version 9.9.8`);
  });

  it('fails when a workspace version differs', () => {
    const dir = makeReleaseFixture({
      workspaceVersions: { 'packages/cli/package.json': '9.9.8' },
    });
    initGitTagOnMain(dir, TAG);
    const result = runGuard(dir, TAG, ['--main-ref', 'main']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/cli/package.json');
    expect(result.stderr).toContain('differs from root');
  });

  it('fails when server.json differs', () => {
    const dir = makeReleaseFixture({ serverVersion: '9.9.8' });
    initGitTagOnMain(dir, TAG);
    const result = runGuard(dir, TAG, ['--main-ref', 'main']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('server.json version "9.9.8" differs from root');
  });

  it('fails when the tagged commit is not on main', () => {
    const dir = makeReleaseFixture();
    initGitTagOffMain(dir, TAG);
    const result = runGuard(dir, TAG, ['--main-ref', 'main']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`tag ${TAG} is not on main`);
  });

  it('fails when the CHANGELOG section is missing', () => {
    const dir = makeReleaseFixture({ changelogSections: ['9.9.8'] });
    initGitTagOnMain(dir, TAG);
    const result = runGuard(dir, TAG, ['--main-ref', 'main']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`CHANGELOG.md has no ## ${VERSION} section`);
  });

  it('rejects a hostile tag without running shell metacharacters', () => {
    const dir = makeReleaseFixture();
    initGitTagOnMain(dir, TAG);
    const canaryDir = trackTemp('release-guard-canary-');
    const payloads = [
      (canary: string) => `v${VERSION}$(touch ${canary})`,
      (canary: string) => `v${VERSION};touch ${canary}`,
      (canary: string) => `v${VERSION}\`touch ${canary}\``,
    ];
    payloads.forEach((makeTag, index) => {
      const canary = path.join(canaryDir, `pwned-${index}`);
      const hostile = makeTag(canary);
      const result = runGuard(dir, hostile, ['--main-ref', 'main']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is not v<semver>');
      expect(result.stderr).toContain('Skipping git checks');
      expect(fs.existsSync(canary)).toBe(false);
    });
  });
});

describe('release-publish.mjs', () => {
  const ORDER = ['@agent-deck/shared', '@agent-deck/backend', '@agent-deck/cli'];

  function publishEnv(published: string[]): { callsFile: string; env: NodeJS.ProcessEnv } {
    const stub = installStubNpm();
    return {
      callsFile: stub.callsFile,
      env: { ...stub.env, STUB_NPM_PUBLISHED: published.map((name) => `${name}@${VERSION}`).join(',') },
    };
  }

  it('dry run skips every package already on npm and publishes nothing', () => {
    const dir = makeReleaseFixture();
    const { callsFile, env } = publishEnv(ORDER);
    const result = runScript(publishScript, ['--root', dir, '--dry-run'], env);
    expect(result.status).toBe(0);
    for (const name of ORDER) {
      expect(result.stdout).toContain(`Skip ${name}@${VERSION} — already on npm.`);
    }
    expect(readCalls(callsFile)).toEqual([]);
  });

  it('dry run reports publishes in order without publishing', () => {
    const dir = makeReleaseFixture();
    const { callsFile, env } = publishEnv([]);
    const result = runScript(publishScript, ['--root', dir, '--dry-run'], env);
    expect(result.status).toBe(0);
    const lines = result.stdout.split('\n');
    const positions = ORDER.map((name) =>
      lines.findIndex((line) => line.includes(`Would publish ${name}@${VERSION}`)),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(readCalls(callsFile)).toEqual([]);
  });

  it('publishes the missing packages in order and skips the live one', () => {
    const dir = makeReleaseFixture();
    const { callsFile, env } = publishEnv(['@agent-deck/backend']);
    const result = runScript(publishScript, ['--root', dir], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Skip @agent-deck/backend@${VERSION} — already on npm.`);
    expect(readCalls(callsFile)).toEqual([
      `publish -w @agent-deck/shared --access public --provenance`,
      `publish -w @agent-deck/cli --access public --provenance`,
    ]);
  });

  it('refuses to run when NODE_AUTH_TOKEN is set', () => {
    const dir = makeReleaseFixture();
    const { callsFile, env } = publishEnv([]);
    const result = runScript(publishScript, ['--root', dir], { ...env, NODE_AUTH_TOKEN: 'npm_deadbeef' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NODE_AUTH_TOKEN is set');
    expect(readCalls(callsFile)).toEqual([]);
  });

  it('fails closed when the registry check errors unexpectedly', () => {
    const dir = makeReleaseFixture();
    const { callsFile, env } = publishEnv([]);
    const result = runScript(
      publishScript,
      ['--root', dir],
      { ...env, STUB_NPM_VIEW_FAIL: 'network' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not check @agent-deck/shared@9.9.9 on npm');
    expect(readCalls(callsFile)).toEqual([]);
  });
});

/** Full version tree for release.mjs check: manifests, pins, server.json, plugins, lockfile, changelog. */
function makeCheckFixture(version: string = VERSION): string {
  const dir = trackTemp('release-check-fixture-');
  writeJson(path.join(dir, 'package.json'), { name: 'agent-deck', version, private: true });
  for (const manifest of WORKSPACE_MANIFESTS) {
    const dependencies: Record<string, string> = {};
    if (manifest === 'packages/cli/package.json') {
      dependencies['@agent-deck/backend'] = `^${version}`;
      dependencies['@agent-deck/shared'] = `^${version}`;
    }
    if (manifest === 'packages/backend/package.json') {
      dependencies['@agent-deck/shared'] = `^${version}`;
    }
    writeJson(path.join(dir, manifest), {
      name: manifest,
      version,
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    });
  }
  writeJson(path.join(dir, 'server.json'), {
    version,
    packages: [{ identifier: '@agent-deck/cli', version }],
  });
  for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    writeJson(path.join(dir, manifest), { name: 'agent-deck', version });
  }
  writeJson(path.join(dir, '.claude-plugin/marketplace.json'), {
    name: 'agent-deck',
    plugins: [{ name: 'agent-deck', version }],
  });
  const lockPackages: Record<string, unknown> = { '': { name: 'agent-deck', version } };
  for (const manifest of WORKSPACE_MANIFESTS) {
    const key = path.dirname(manifest);
    const entry: Record<string, unknown> = { name: manifest, version };
    if (manifest === 'packages/cli/package.json') {
      entry.dependencies = {
        '@agent-deck/backend': `^${version}`,
        '@agent-deck/shared': `^${version}`,
      };
    }
    if (manifest === 'packages/backend/package.json') {
      entry.dependencies = { '@agent-deck/shared': `^${version}` };
    }
    lockPackages[key] = entry;
  }
  writeJson(path.join(dir, 'package-lock.json'), {
    name: 'agent-deck',
    version,
    lockfileVersion: 3,
    packages: lockPackages,
  });
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), `# Changelog\n\n## ${version} — 2026-11-19\n\n- Release ${version}.\n`);
  return dir;
}

function setJson(file: string, mutate: (value: any) => void): void {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(value);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe('release.mjs check', () => {
  function runCheck(dir: string, extraArgs: string[] = []): RunResult {
    return runScript(releaseScript, ['check', '--root', dir, ...extraArgs]);
  }

  it('passes for a fully synced tree', () => {
    const result = runCheck(makeCheckFixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All checks passed');
  });

  it('fails when a workspace version differs', () => {
    const dir = makeCheckFixture();
    setJson(path.join(dir, 'packages/cli/package.json'), (v) => {
      v.version = '9.9.8';
    });
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/cli/package.json');
    expect(result.stderr).toContain('differs from root');
  });

  it('fails when an internal pin differs', () => {
    const dir = makeCheckFixture();
    setJson(path.join(dir, 'packages/backend/package.json'), (v) => {
      v.dependencies['@agent-deck/shared'] = '^9.9.8';
    });
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pins @agent-deck/shared at "^9.9.8", want ^9.9.9');
  });

  it('fails when server.json differs', () => {
    const dir = makeCheckFixture();
    setJson(path.join(dir, 'server.json'), (v) => {
      v.packages[0].version = '9.9.8';
    });
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('server.json package @agent-deck/cli');
    expect(result.stderr).toContain('differs from root');
  });

  it('fails when a plugin manifest differs', () => {
    const dir = makeCheckFixture();
    setJson(path.join(dir, '.cursor-plugin/plugin.json'), (v) => {
      v.version = '9.9.8';
    });
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.cursor-plugin/plugin.json');
    expect(result.stderr).toContain('differs from root');
  });

  it('fails when a lockfile version differs', () => {
    const dir = makeCheckFixture();
    setJson(path.join(dir, 'package-lock.json'), (v) => {
      v.packages['packages/cli'].version = '9.9.8';
    });
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package-lock.json packages[packages/cli]');
    expect(result.stderr).toContain('differs from root');
  });

  it('fails when a lockfile pin differs', () => {
    const dir = makeCheckFixture();
    setJson(path.join(dir, 'package-lock.json'), (v) => {
      v.packages['packages/cli'].dependencies['@agent-deck/backend'] = '^9.9.8';
    });
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages[packages/cli] pins @agent-deck/backend at "^9.9.8", want ^9.9.9');
  });

  it('fails when the CHANGELOG section is missing', () => {
    const dir = makeCheckFixture();
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## 9.9.8 — 2026-11-19\n\n- Old.\n');
    const result = runCheck(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CHANGELOG.md has no ## 9.9.9 section');
  });
});

describe('release.mjs argument validation', () => {
  // None of these reach git or the network: they fail on arguments alone.
  it('rejects an unknown command', () => {
    const result = runScript(releaseScript, ['bogus']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown command: bogus');
  });

  it('requires --summary for prepare', () => {
    const result = runScript(releaseScript, ['prepare', 'patch']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--summary "<why>" is required');
  });

  it('rejects a bad prepare level', () => {
    const result = runScript(releaseScript, ['prepare', 'sideways', '--summary', 'x']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('patch, minor, major or X.Y.Z');
  });

  it('rejects arguments to finish', () => {
    const result = runScript(releaseScript, ['finish', 'extra']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('finish takes no arguments');
  });

  it('rejects stray arguments to check', () => {
    const result = runScript(releaseScript, ['check', 'extra']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('check takes only --root DIR');
  });
});

describe('release.mjs finish', () => {
  // NOT-646 round 2: finish must resume a MERGED PR at the tag step (a merge
  // followed by a failed fetch/tag push, or a lost gh response, otherwise
  // leaves main bumped without the tag and forces hand-derived tag steps).
  // These tests run release.mjs as a black box with stub git/gh on PATH, so
  // the real repo is never touched: every git/gh call is answered from env
  // and the mutating calls (fetch/tag/push, checks/merge) are logged to files.
  const MERGE_OID = 'abcdef0123456789abcdef0123456789abcdef01';
  const MAIN_OID = '1234567890abcdef1234567890abcdef12345678';
  const OTHER_OID = 'ffffffffffffffffffffffffffffffffffffffff';
  const BRANCH = `release/${VERSION}`;
  const SHIP_SUBJECT = `Ship ${VERSION}: test`;

  const STUB_GIT = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'const version = process.env.STUB_GIT_VERSION;',
    'const tagRef = `refs/tags/v${version}`;',
    'const log = (line) => fs.appendFileSync(process.env.STUB_GIT_CALLS, `${line}\\n`);',
    'const [cmd, ...rest] = args;',
    'if (cmd === "rev-parse" && rest.join(" ") === "--abbrev-ref HEAD") {',
    '  console.log(process.env.STUB_GIT_BRANCH);',
    '  process.exit(0);',
    '}',
    'if (cmd === "status") {',
    '  process.stdout.write(process.env.STUB_GIT_STATUS ?? "");',
    '  process.exit(0);',
    '}',
    'if (cmd === "rev-parse" && rest[0] === "--verify" && rest[1] === "--quiet") {',
    '  const ref = rest[2];',
    '  const known = [process.env.STUB_GIT_MERGE_OID, process.env.STUB_GIT_MAIN].filter(Boolean);',
    '  if (known.includes(ref) || (ref === tagRef && process.env.STUB_GIT_TAG_EXISTS === "1")) {',
    '    process.exit(0);',
    '  }',
    '  process.exit(1);',
    '}',
    'if (cmd === "rev-parse" && rest.length === 1) {',
    '  if (rest[0] === `v${version}^{}`) {',
    '    console.log(process.env.STUB_GIT_TAG_TARGET);',
    '    process.exit(0);',
    '  }',
    '  if (rest[0] === "origin/main") {',
    '    console.log(process.env.STUB_GIT_MAIN);',
    '    process.exit(0);',
    '  }',
    '  console.error(`stub git: unexpected rev-parse ${rest[0]}`);',
    '  process.exit(2);',
    '}',
    'if (cmd === "log") {',
    '  console.log(process.env.STUB_GIT_SUBJECT ?? `Ship ${version}: test`);',
    '  process.exit(0);',
    '}',
    'if (cmd === "merge-base") {',
    '  process.exit(process.env.STUB_GIT_ANCESTOR_FAIL === "1" ? 1 : 0);',
    '}',
    'if (cmd === "fetch" || cmd === "tag" || cmd === "push") {',
    '  log(`${cmd} ${rest.join(" ")}`);',
    '  process.exit(0);',
    '}',
    'console.error(`stub git: unexpected ${args.join(" ")}`);',
    'process.exit(2);',
  ].join('\n');

  const STUB_GH = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'if (args[0] === "--version") {',
    '  console.log("gh version 9.9.9-stub");',
    '  process.exit(0);',
    '}',
    'const log = (line) => fs.appendFileSync(process.env.STUB_GH_CALLS, `${line}\\n`);',
    'if (args[0] === "pr" && args[1] === "view" && args[3] === "--json") {',
    '  if (args[4] === "mergeCommit") {',
    '  console.log(process.env.STUB_GH_MERGECOMMIT ?? `{"mergeCommit":{"oid":"${process.env.STUB_GIT_MERGE_OID}"}}`);',
    '    process.exit(0);',
    '  }',
    '  console.log(process.env.STUB_GH_PR);',
    '  process.exit(0);',
    '}',
    'if (args[0] === "pr" && (args[1] === "checks" || args[1] === "merge")) {',
    '  log(`pr ${args.slice(1).join(" ")}`);',
    '  process.exit(0);',
    '}',
    'console.error(`stub gh: unexpected ${args.join(" ")}`);',
    'process.exit(2);',
  ].join('\n');

  interface FinishOptions {
    prState?: string;
    subject?: string;
    tagExists?: boolean;
    tagTarget?: string;
    mergeCommitJson?: string;
  }

  function installFinishStubs(options: FinishOptions = {}): {
    env: NodeJS.ProcessEnv;
    gitCallsFile: string;
    ghCallsFile: string;
  } {
    const bin = trackTemp('stub-finish-bin-');
    const gitPath = path.join(bin, 'git');
    fs.writeFileSync(gitPath, STUB_GIT);
    fs.chmodSync(gitPath, 0o755);
    const ghPath = path.join(bin, 'gh');
    fs.writeFileSync(ghPath, STUB_GH);
    fs.chmodSync(ghPath, 0o755);
    const gitCallsFile = path.join(trackTemp('stub-finish-git-calls-'), 'calls.log');
    const ghCallsFile = path.join(trackTemp('stub-finish-gh-calls-'), 'calls.log');
    return {
      gitCallsFile,
      ghCallsFile,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        STUB_GIT_CALLS: gitCallsFile,
        STUB_GH_CALLS: ghCallsFile,
        STUB_GIT_BRANCH: BRANCH,
        STUB_GIT_STATUS: '',
        STUB_GIT_VERSION: VERSION,
        STUB_GIT_MERGE_OID: MERGE_OID,
        STUB_GIT_MAIN: MAIN_OID,
        STUB_GIT_SUBJECT: options.subject ?? SHIP_SUBJECT,
        STUB_GIT_TAG_EXISTS: options.tagExists ? '1' : '0',
        STUB_GIT_TAG_TARGET: options.tagTarget ?? MERGE_OID,
        STUB_GH_PR: JSON.stringify({
          number: 123,
          state: options.prState ?? 'MERGED',
          baseRefName: 'main',
          headRefName: BRANCH,
          url: 'https://example.test/pr/123',
        }),
        ...(options.mergeCommitJson !== undefined ? { STUB_GH_MERGECOMMIT: options.mergeCommitJson } : {}),
      },
    };
  }

  function runFinish(env: NodeJS.ProcessEnv): RunResult {
    return runScript(releaseScript, ['finish'], env);
  }

  it('merges an OPEN PR, then tags the merge commit and pushes', () => {
    const { env, gitCallsFile, ghCallsFile } = installFinishStubs({ prState: 'OPEN' });
    const result = runFinish(env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Done: v${VERSION} pushed`);
    // NOT-647: the closing message must not ask for an approval step.
    expect(result.stdout).not.toMatch(/approve/i);
    expect(result.stdout).toContain('watch the run, then check npm view for each package');
    expect(readCalls(ghCallsFile)).toEqual(['pr checks 123 --watch', 'pr merge 123 --squash']);
    expect(readCalls(gitCallsFile)).toEqual([
      'fetch origin --tags',
      `tag -a v${VERSION} ${MERGE_OID} -m Agent Deck ${VERSION}`,
      `push origin v${VERSION}`,
    ]);
  });

  it('resumes a MERGED PR at the tag step without merging again', () => {
    const { env, gitCallsFile, ghCallsFile } = installFinishStubs({ prState: 'MERGED' });
    const result = runFinish(env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already MERGED');
    expect(result.stdout).toContain('resuming at the tag step');
    expect(readCalls(ghCallsFile)).toEqual([]);
    expect(readCalls(gitCallsFile)).toEqual([
      'fetch origin --tags',
      `tag -a v${VERSION} ${MERGE_OID} -m Agent Deck ${VERSION}`,
      `push origin v${VERSION}`,
    ]);
  });

  it('re-running after the tag exists only ensures the push', () => {
    const { env, gitCallsFile } = installFinishStubs({ prState: 'MERGED', tagExists: true, tagTarget: MERGE_OID });
    const result = runFinish(env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('already exists on the merge commit');
    expect(readCalls(gitCallsFile)).toEqual(['fetch origin --tags', `push origin v${VERSION}`]);
  });

  it('refuses to move a tag pointing at another commit', () => {
    const { env, gitCallsFile } = installFinishStubs({ prState: 'MERGED', tagExists: true, tagTarget: OTHER_OID });
    const result = runFinish(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to move it');
    expect(readCalls(gitCallsFile)).toEqual(['fetch origin --tags']);
  });

  it('refuses a CLOSED PR', () => {
    const { env, gitCallsFile, ghCallsFile } = installFinishStubs({ prState: 'CLOSED' });
    const result = runFinish(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is CLOSED, not OPEN');
    expect(readCalls(ghCallsFile)).toEqual([]);
    expect(readCalls(gitCallsFile)).toEqual([]);
  });

  it('falls back to the main tip when gh reports no merge commit', () => {
    const { env, gitCallsFile } = installFinishStubs({ prState: 'MERGED', mergeCommitJson: '{}' });
    const result = runFinish(env);
    expect(result.status).toBe(0);
    expect(readCalls(gitCallsFile)).toEqual([
      'fetch origin --tags',
      `tag -a v${VERSION} ${MAIN_OID} -m Agent Deck ${VERSION}`,
      `push origin v${VERSION}`,
    ]);
  });

  it('refuses to tag when the merge commit is not the Ship commit', () => {
    const { env, gitCallsFile } = installFinishStubs({ prState: 'MERGED', subject: 'Unrelated change' });
    const result = runFinish(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`not the Ship ${VERSION} commit`);
    expect(readCalls(gitCallsFile)).toEqual(['fetch origin --tags']);
  });
});

describe('sync-versions.mjs', () => {
  const ALL_MANIFESTS = ['package.json', ...WORKSPACE_MANIFESTS];

  it('syncs manifests, pins, server.json, plugins and the lockfile in one pass', () => {
    const dir = makeCheckFixture('9.9.8');
    const result = runScript(syncScript, ['--root', dir, '9.9.9']);
    expect(result.status).toBe(0);
    for (const manifest of ALL_MANIFESTS) {
      expect(JSON.parse(fs.readFileSync(path.join(dir, manifest), 'utf8')).version).toBe('9.9.9');
    }
    const cli = JSON.parse(fs.readFileSync(path.join(dir, 'packages/cli/package.json'), 'utf8'));
    expect(cli.dependencies['@agent-deck/backend']).toBe('^9.9.9');
    expect(cli.dependencies['@agent-deck/shared']).toBe('^9.9.9');
    const backend = JSON.parse(fs.readFileSync(path.join(dir, 'packages/backend/package.json'), 'utf8'));
    expect(backend.dependencies['@agent-deck/shared']).toBe('^9.9.9');
    const server = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
    expect(server.version).toBe('9.9.9');
    expect(server.packages[0].version).toBe('9.9.9');
    for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
      expect(JSON.parse(fs.readFileSync(path.join(dir, manifest), 'utf8')).version).toBe('9.9.9');
    }
    const marketplace = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/marketplace.json'), 'utf8'));
    expect(marketplace.plugins[0].version).toBe('9.9.9');
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    expect(lock.version).toBe('9.9.9');
    for (const key of ['', 'packages/shared', 'packages/backend', 'packages/cli', 'apps/agent-deck']) {
      expect(lock.packages[key].version, `lock packages[${key}]`).toBe('9.9.9');
    }
    expect(lock.packages['packages/cli'].dependencies['@agent-deck/backend']).toBe('^9.9.9');
    expect(lock.packages['packages/cli'].dependencies['@agent-deck/shared']).toBe('^9.9.9');
    expect(lock.packages['packages/backend'].dependencies['@agent-deck/shared']).toBe('^9.9.9');
    // The sync covers everything check looks at except the changelog stub,
    // which prepare writes next — so check must fail on that alone.
    const check = runScript(releaseScript, ['check', '--root', dir]);
    expect(check.status).toBe(1);
    expect(check.stderr).toContain('CHANGELOG.md has no ## 9.9.9 section');
    expect(check.stderr).toContain('1 check(s) failed');
  });

  it('rejects a missing version', () => {
    const result = runScript(syncScript, ['--root', makeCheckFixture('9.9.8')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });
});

describe('published package metadata', () => {
  // `npm publish --provenance` from release.yml is rejected (E422) unless
  // package.json repository.url names the repo the workflow ran in.
  it('every published package points repository.url at the canonical repo', () => {
    for (const dir of ['shared', 'backend', 'cli']) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'packages', dir, 'package.json'), 'utf8'),
      );
      expect(manifest.repository?.url, `@agent-deck/${dir}`).toBe(
        'git+https://github.com/not-so-fat/agent-deck.git',
      );
      expect(manifest.repository?.directory, `@agent-deck/${dir}`).toBe(`packages/${dir}`);
    }
  });
});
