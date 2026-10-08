import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve an existing final-component file symlink to its target so atomic
 * writes land in the linked checkout instead of replacing the link itself.
 *
 * Returns `filePath` unchanged when it is not a symlink (including when it
 * does not exist yet). Throws a path-specific error — without touching the
 * link — when the final component is a symlink that cannot be resolved
 * (dangling, cyclic, permission-denied, ...).
 */
async function resolveFinalSymlink(filePath: string): Promise<string> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return filePath;
    }
    throw error;
  }
  if (!stat.isSymbolicLink()) {
    return filePath;
  }
  try {
    return await fs.realpath(filePath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot atomically write ${filePath}: final path component is an unresolvable symlink: ${detail}`,
    );
  }
}

export async function writeFileAtomic(
  filePath: string,
  contents: string,
): Promise<void> {
  const target = await resolveFinalSymlink(filePath);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, contents, 'utf8');
  try {
    await fs.rename(tmpPath, target);
  } catch (error: unknown) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}
