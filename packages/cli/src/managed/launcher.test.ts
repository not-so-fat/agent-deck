import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeLocalBinLauncher } from './launcher';
import { currentLinkPath, localBinLauncherPath, versionDir } from './paths';

describe('managed launcher guard', () => {
  let tmp: string;
  const seed = (ver: string, shared?: string) => {
    const scope = path.join(versionDir(ver), 'node_modules', '@agent-deck');
    fs.mkdirSync(path.join(scope, 'cli', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(scope, 'cli', 'dist', 'bin.js'), `console.log('ran-${ver}');\n`);
    if (shared !== undefined) {
      fs.mkdirSync(path.join(scope, 'shared', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(scope, 'shared', 'dist', 'x.js'), shared);
    }
  };
  const run = () =>
    spawnSync('bash', [localBinLauncherPath()], {
      encoding: 'utf8',
      env: { ...process.env, AGENT_DECK_HOME: tmp, AGENT_DECK_LOCAL_BIN: path.join(tmp, 'lb') },
    });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-launch-'));
    process.env.AGENT_DECK_HOME = tmp;
    process.env.AGENT_DECK_LOCAL_BIN = path.join(tmp, 'lb');
  });
  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    delete process.env.AGENT_DECK_LOCAL_BIN;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('runs an intact current and marks it verified', () => {
    seed('1.0.1', 'exports.a = 1;\n');
    fs.symlinkSync(versionDir('1.0.1'), currentLinkPath(), 'dir');
    writeLocalBinLauncher();
    const r = run();
    expect(r.stdout.trim()).toBe('ran-1.0.1');
    expect(fs.existsSync(path.join(versionDir('1.0.1'), '.verified'))).toBe(true);
  });

  it('falls back to the newest intact version and repoints current when current is truncated', () => {
    seed('1.0.0', 'exports.a = 1;\n');
    seed('1.0.1', 'const warnings = ');
    fs.symlinkSync(versionDir('1.0.1'), currentLinkPath(), 'dir');
    writeLocalBinLauncher();
    const r = run();
    expect(r.stdout.trim()).toBe('ran-1.0.0');
    expect(r.stderr).toContain('1.0.1 is broken; falling back to 1.0.0');
    expect(fs.realpathSync(currentLinkPath())).toBe(fs.realpathSync(versionDir('1.0.0')));
  });

  it('fails clearly when no version is loadable', () => {
    seed('1.0.1', 'const warnings = ');
    fs.symlinkSync(versionDir('1.0.1'), currentLinkPath(), 'dir');
    writeLocalBinLauncher();
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no loadable managed install');
  });
});
