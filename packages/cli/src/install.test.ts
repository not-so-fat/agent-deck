import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInstall } from './install';
import { currentLinkPath, localBinLauncherPath, versionDir } from './managed';

function seedVersion(home: string, ver: string) {
  const dir = path.join(home, 'versions', ver);
  const bin = path.join(dir, 'node_modules', '@agent-deck', 'cli', 'dist', 'bin.js');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, 'ok\n');
}

describe('runInstall', () => {
  let tmp: string;
  let localBin: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-inst-'));
    localBin = path.join(tmp, 'local-bin');
    process.env.AGENT_DECK_HOME = tmp;
    process.env.AGENT_DECK_LOCAL_BIN = localBin;
  });
  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    delete process.env.AGENT_DECK_LOCAL_BIN;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('activates version without deleting existing home data', async () => {
    fs.writeFileSync(path.join(tmp, 'agent_deck.db'), 'keep-me');
    seedVersion(tmp, '2.0.0');

    const code = await runInstall(['--to', '2.0.0'], {
      installVersion: async () => {
        throw new Error('should not call npm');
      },
      fetchLatest: async () => '2.0.0',
    });

    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'agent_deck.db'), 'utf8')).toBe('keep-me');
    expect(fs.realpathSync(currentLinkPath())).toBe(fs.realpathSync(versionDir('2.0.0')));
    expect(fs.existsSync(localBinLauncherPath())).toBe(true);
  });
});
