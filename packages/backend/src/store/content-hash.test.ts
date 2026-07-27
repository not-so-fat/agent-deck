import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashStoreTree } from './content-hash';
import { writeFileAtomic } from './atomic-write';
import { storePaths } from './paths';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('hashStoreTree', () => {
  it('changes when a playbook file changes', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-hash-'));
    const { playbooksDir, manifest } = storePaths(home);
    await fs.mkdir(playbooksDir, { recursive: true });
    await writeFileAtomic(manifest, JSON.stringify({ format: 'agent-deck-store', version: 1 }));
    await writeFileAtomic(path.join(playbooksDir, 'pb_a.md'), '---\nid: pb_a\n---\none');
    const h1 = await hashStoreTree(home);
    await writeFileAtomic(path.join(playbooksDir, 'pb_a.md'), '---\nid: pb_a\n---\ntwo');
    const h2 = await hashStoreTree(home);
    expect(h1).not.toBe(h2);
  });

  it('returns the stable empty digest for an empty tree', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-hash-empty-'));
    const h1 = await hashStoreTree(home);
    const h2 = await hashStoreTree(home);
    expect(h1).toBe(h2);
    expect(h1).toBe(EMPTY_SHA256);
  });

  it('ignores agent_deck.db and icons at store root', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-hash-exclude-'));
    const { playbooksDir, manifest } = storePaths(home);
    await fs.mkdir(playbooksDir, { recursive: true });
    await writeFileAtomic(manifest, JSON.stringify({ format: 'agent-deck-store', version: 1 }));
    await writeFileAtomic(path.join(playbooksDir, 'pb_a.md'), '---\nid: pb_a\n---\ntest');
    const hashWithStoreOnly = await hashStoreTree(home);

    await writeFileAtomic(path.join(home, 'agent_deck.db'), 'sqlite bytes');
    await fs.mkdir(path.join(home, 'icons'), { recursive: true });
    await writeFileAtomic(path.join(home, 'icons', 'foo.png'), 'png bytes');

    const hashWithExcludedFiles = await hashStoreTree(home);
    expect(hashWithExcludedFiles).toBe(hashWithStoreOnly);
  });
});
