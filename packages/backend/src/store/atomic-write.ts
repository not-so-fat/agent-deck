import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, contents, 'utf8');
  await fs.rename(tmpPath, filePath);
}
