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
});
