import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installCliVersionToPrefix } from './npm-prefix-install';
import { cliEntryInVersionDir, versionDir } from './paths';

function seedPackage(prefix: string, rel: string, body: string) {
  const file = path.join(prefix, 'node_modules', '@agent-deck', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

describe('installCliVersionToPrefix', () => {
  let tmp: string;
  const partials = () =>
    fs.readdirSync(path.join(tmp, 'versions')).filter((n) => n.startsWith('.partial-'));
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
    expect(partials()).toEqual([]);
  });

  it('rejects a truncated install and leaves no version dir', async () => {
    const result = await installCliVersionToPrefix('9.9.7', {
      npmSpawn: async (args) => {
        const prefix = args[args.indexOf('--prefix') + 1];
        seedPackage(prefix, 'cli/dist/bin.js', 'ok\n');
        seedPackage(prefix, 'shared/dist/utils/w.js', 'function f() {\n  const warnings = ');
        return { code: 0, stderr: '' };
      },
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(versionDir('9.9.7'))).toBe(false);
    expect(partials()).toEqual([]);
  });

  it('concurrent installs of one version use separate dirs and both end ok', async () => {
    const install = () =>
      installCliVersionToPrefix('9.9.6', {
        npmSpawn: async (args) => {
          const prefix = args[args.indexOf('--prefix') + 1];
          seedPackage(prefix, 'cli/dist/bin.js', 'ok\n');
          await new Promise((r) => setTimeout(r, 20));
          return { code: 0, stderr: '' };
        },
      });
    const [a, b] = await Promise.all([install(), install()]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fs.existsSync(cliEntryInVersionDir(versionDir('9.9.6')))).toBe(true);
    expect(partials()).toEqual([]);
  });
});
