import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activateVersion, pruneOldVersions } from './activate';
import { currentLinkPath, localBinLauncherPath, versionDir } from './paths';

function seedVersion(ver: string) {
  const dir = versionDir(ver);
  const bin = path.join(dir, 'node_modules', '@agent-deck', 'cli', 'dist', 'bin.js');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, 'console.log("ok")\n');
}

describe('activateVersion', () => {
  let tmp: string;
  let localBin: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-act-'));
    localBin = path.join(tmp, 'local-bin');
    process.env.AGENT_DECK_HOME = tmp;
    process.env.AGENT_DECK_LOCAL_BIN = localBin;
  });
  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    delete process.env.AGENT_DECK_LOCAL_BIN;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('points current and writes launcher without touching sibling data files', () => {
    fs.writeFileSync(path.join(tmp, 'agent_deck.db'), 'keep-me');
    seedVersion('1.0.0');
    activateVersion('1.0.0');
    expect(fs.realpathSync(currentLinkPath())).toBe(fs.realpathSync(versionDir('1.0.0')));
    expect(fs.readFileSync(path.join(tmp, 'agent_deck.db'), 'utf8')).toBe('keep-me');
    expect(fs.existsSync(localBinLauncherPath())).toBe(true);
    const launcher = fs.readFileSync(localBinLauncherPath(), 'utf8');
    expect(launcher).toContain('node_modules/@agent-deck/cli/dist/bin.js');
  });

  it('prunes to last 3 versions', () => {
    for (const v of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) {
      seedVersion(v);
    }
    activateVersion('1.0.3');
    pruneOldVersions(3);
    expect(fs.existsSync(versionDir('1.0.0'))).toBe(false);
    expect(fs.existsSync(versionDir('1.0.1'))).toBe(true);
    expect(fs.existsSync(versionDir('1.0.2'))).toBe(true);
    expect(fs.existsSync(versionDir('1.0.3'))).toBe(true);
  });
});
