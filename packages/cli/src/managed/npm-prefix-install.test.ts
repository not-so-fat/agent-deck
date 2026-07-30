import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCliVersionToPrefix } from './npm-prefix-install';
import { cliEntryInVersionDir, versionDir } from './paths';

describe('installCliVersionToPrefix', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-npm-'));
    process.env.AGENT_DECK_HOME = tmp;
  });
  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('renames partial to version dir after mocked npm install', async () => {
    const result = await installCliVersionToPrefix('9.9.9', {
      npmSpawn: async (args) => {
        const prefixIdx = args.indexOf('--prefix');
        const prefix = args[prefixIdx + 1];
        const entry = cliEntryInVersionDir(prefix);
        fs.mkdirSync(path.dirname(entry), { recursive: true });
        fs.writeFileSync(entry, 'ok\n');
        return { code: 0, stderr: '' };
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dir).toBe(versionDir('9.9.9'));
      expect(fs.existsSync(cliEntryInVersionDir(result.dir))).toBe(true);
    }
  });

  it('cleans partial on npm failure', async () => {
    const result = await installCliVersionToPrefix('9.9.8', {
      npmSpawn: async () => ({ code: 1, stderr: 'boom' }),
    });
    expect(result).toEqual({ ok: false, error: 'boom' });
    expect(fs.existsSync(path.join(tmp, 'versions', '.partial-9.9.8'))).toBe(false);
  });
});
