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
