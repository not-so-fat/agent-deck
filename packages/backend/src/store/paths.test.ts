import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { storePaths } from './paths';

describe('storePaths', () => {
  it('returns paths under the store root', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-paths-'));
    const paths = storePaths(home);
    expect(paths.root).toBe(home);
    expect(paths.playbooksDir).toBe(path.join(home, 'playbooks'));
    expect(paths.manifest).toBe(path.join(home, 'manifest.json'));
    expect(paths.servicesDir).toBe(path.join(home, 'services'));
    expect(paths.decksDir).toBe(path.join(home, 'decks'));
    expect(paths.credentialsDir).toBe(path.join(home, 'credentials'));
  });
});
