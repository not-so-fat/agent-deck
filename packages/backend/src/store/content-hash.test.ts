import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashStoreTree } from './content-hash';
import { writeFileAtomic } from './atomic-write';
import { storePaths } from './paths';

describe('hashStoreTree', () => {
  const originalHome = process.env.AGENT_DECK_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = originalHome;
    }
  });

  it('changes when a playbook file changes', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-hash-'));
    process.env.AGENT_DECK_HOME = home;
    const { playbooksDir, manifest } = storePaths(home);
    await fs.mkdir(playbooksDir, { recursive: true });
    await writeFileAtomic(manifest, JSON.stringify({ format: 'agent-deck-store', version: 1 }));
    await writeFileAtomic(path.join(playbooksDir, 'pb_a.md'), '---\nid: pb_a\n---\none');
    const h1 = await hashStoreTree(home);
    await writeFileAtomic(path.join(playbooksDir, 'pb_a.md'), '---\nid: pb_a\n---\ntwo');
    const h2 = await hashStoreTree(home);
    expect(h1).not.toBe(h2);
  });

  it('returns a stable hash for an empty tree', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-hash-empty-'));
    const h1 = await hashStoreTree(home);
    const h2 = await hashStoreTree(home);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });
});
