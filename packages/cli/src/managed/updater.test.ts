import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentLinkPath, versionDir } from './paths';
import { writeUpdateState } from './update-state';
import { maybeActivatePendingVersion } from './updater';

function seedVersion(ver: string) {
  const dir = versionDir(ver);
  const bin = path.join(dir, 'node_modules', '@agent-deck', 'cli', 'dist', 'bin.js');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, 'ok\n');
}

describe('maybeActivatePendingVersion', () => {
  let tmp: string;
  let localBin: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-upd-'));
    localBin = path.join(tmp, 'local-bin');
    process.env.AGENT_DECK_HOME = tmp;
    process.env.AGENT_DECK_LOCAL_BIN = localBin;
    delete process.env.AGENT_DECK_DISABLE_AUTOUPDATER;
  });
  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    delete process.env.AGENT_DECK_LOCAL_BIN;
    delete process.env.AGENT_DECK_DISABLE_AUTOUPDATER;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('activates pending when version dir is complete', () => {
    seedVersion('1.0.0');
    seedVersion('1.0.1');
    fs.symlinkSync(versionDir('1.0.0'), currentLinkPath(), 'dir');
    writeUpdateState({
      checkedAt: new Date().toISOString(),
      latest: '1.0.1',
      pendingVersion: '1.0.1',
    });

    const result = maybeActivatePendingVersion();
    expect(result.activated).toBe('1.0.1');
    expect(fs.realpathSync(currentLinkPath())).toBe(fs.realpathSync(versionDir('1.0.1')));
  });

  it('does nothing when DISABLE_AUTOUPDATER=1', () => {
    process.env.AGENT_DECK_DISABLE_AUTOUPDATER = '1';
    seedVersion('1.0.0');
    seedVersion('1.0.1');
    fs.symlinkSync(versionDir('1.0.0'), currentLinkPath(), 'dir');
    writeUpdateState({
      checkedAt: new Date().toISOString(),
      latest: '1.0.1',
      pendingVersion: '1.0.1',
    });

    const result = maybeActivatePendingVersion();
    expect(result.activated).toBeNull();
    expect(fs.realpathSync(currentLinkPath())).toBe(fs.realpathSync(versionDir('1.0.0')));
  });
});
