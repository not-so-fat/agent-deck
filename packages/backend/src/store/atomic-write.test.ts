import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write';

describe('writeFileAtomic', () => {
  it('writes final file and leaves no .tmp sibling', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-atomic-'));
    const file = path.join(dir, 'x.json');
    await writeFileAtomic(file, '{"a":1}\n');
    expect(await fs.readFile(file, 'utf8')).toBe('{"a":1}\n');
    const names = await fs.readdir(dir);
    expect(names.filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it.each(['relative', 'absolute'] as const)(
    'writes through an existing %s file symlink and preserves the link',
    async (kind) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-atomic-link-'));
      const storeDir = path.join(dir, 'checkout');
      await fs.mkdir(storeDir, { recursive: true });
      const target = path.join(storeDir, 'manifest.json');
      await fs.writeFile(target, 'v1\n', 'utf8');
      const link = path.join(dir, 'manifest.json');
      await fs.symlink(
        kind === 'relative'
          ? path.relative(path.dirname(link), target)
          : target,
        link,
      );
      const linkBefore = await fs.readlink(link);

      await writeFileAtomic(link, 'v2\n');

      expect(await fs.readFile(target, 'utf8')).toBe('v2\n');
      expect(await fs.readFile(link, 'utf8')).toBe('v2\n');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(link)).toBe(linkBefore);
      // Temp file lands beside the resolved target, never beside the link.
      expect(
        (await fs.readdir(path.dirname(link))).filter((n) =>
          n.includes('.tmp'),
        ),
      ).toEqual([]);
      expect(
        (await fs.readdir(storeDir)).filter((n) => n.includes('.tmp')),
      ).toEqual([]);
      expect((await fs.lstat(target)).isFile()).toBe(true);
    },
  );

  it('writes into a symlinked directory without disturbing the directory link', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-atomic-dirlink-'));
    const storeDir = path.join(dir, 'checkout', 'decks');
    await fs.mkdir(storeDir, { recursive: true });
    const decksLink = path.join(dir, 'decks');
    await fs.symlink(
      path.relative(path.dirname(decksLink), storeDir),
      decksLink,
    );

    await writeFileAtomic(path.join(decksLink, 'a.md'), 'body\n');

    expect(await fs.readFile(path.join(storeDir, 'a.md'), 'utf8')).toBe(
      'body\n',
    );
    expect((await fs.lstat(decksLink)).isSymbolicLink()).toBe(true);
  });

  it('fails closed on a dangling final symlink and leaves it untouched', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-atomic-dangle-'));
    const link = path.join(dir, 'manifest.json');
    await fs.symlink(path.join(dir, 'missing-target.json'), link);

    await expect(writeFileAtomic(link, 'v2\n')).rejects.toThrow(link);
    await expect(writeFileAtomic(link, 'v2\n')).rejects.toThrow(
      /unresolvable symlink/,
    );

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    await expect(
      fs.access(path.join(dir, 'missing-target.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await fs.readdir(dir)).filter((n) => n.includes('.tmp')),
    ).toEqual([]);
  });

  it('fails closed on a cyclic final symlink and leaves no residue', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-atomic-cycle-'));
    const a = path.join(dir, 'a.json');
    const b = path.join(dir, 'b.json');
    await fs.symlink(b, a);
    await fs.symlink(a, b);

    await expect(writeFileAtomic(a, 'v2\n')).rejects.toThrow(a);
    await expect(writeFileAtomic(a, 'v2\n')).rejects.toThrow(
      /unresolvable symlink/,
    );

    expect((await fs.lstat(a)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(b)).isSymbolicLink()).toBe(true);
    expect(
      (await fs.readdir(dir)).filter((n) => n.includes('.tmp')),
    ).toEqual([]);
  });
});
