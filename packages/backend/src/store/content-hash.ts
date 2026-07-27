import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveAgentDeckHome } from '../lib/paths';
import { storePaths } from './paths';

async function collectFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectFiles(fullPath)));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
    return files;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

export async function hashStoreTree(home = resolveAgentDeckHome()): Promise<string> {
  const { root, manifest, playbooksDir, servicesDir, decksDir, credentialsDir } =
    storePaths(home);

  const filePaths: string[] = [];

  const manifestExists = await fs
    .access(manifest)
    .then(() => true)
    .catch(() => false);
  if (manifestExists) {
    filePaths.push(manifest);
  }

  for (const dir of [playbooksDir, servicesDir, decksDir, credentialsDir]) {
    filePaths.push(...(await collectFiles(dir)));
  }

  const pairs: { rel: string; content: string }[] = [];
  for (const filePath of filePaths) {
    const rel = path.relative(root, filePath);
    const content = await fs.readFile(filePath, 'utf8');
    pairs.push({ rel, content });
  }

  pairs.sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = createHash('sha256');
  for (const { rel, content } of pairs) {
    hash.update(rel);
    hash.update('\0');
    hash.update(content);
  }

  return hash.digest('hex');
}
