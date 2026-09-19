import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { cliEntryInVersionDir, partialVersionDir, versionDir, versionsDir } from './paths';
import { verifyInstalledVersion } from './verify-install';

const STALE_PARTIAL_MS = 60 * 60 * 1000;

export const PACKAGE_NAME = '@agent-deck/cli';

export type NpmSpawn = (
  args: string[],
  options: { cwd?: string },
) => Promise<{ code: number; stderr: string }>;

const defaultNpmSpawn: NpmSpawn = (args, options) =>
  new Promise((resolve) => {
    const child = spawn('npm', args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => resolve({ code: 1, stderr: err.message }));
    child.on('exit', (code) => resolve({ code: code ?? 1, stderr }));
  });

function removeStalePartials(): void {
  for (const entry of fs.readdirSync(versionsDir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.partial-')) {
      continue;
    }
    const full = path.join(versionsDir(), entry.name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > STALE_PARTIAL_MS) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // raced with another process cleaning up
    }
  }
}

export async function installCliVersionToPrefix(
  version: string,
  options: { npmSpawn?: NpmSpawn } = {},
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const npmSpawn = options.npmSpawn ?? defaultNpmSpawn;
  const partial = partialVersionDir(version);
  const finalDir = versionDir(version);

  fs.mkdirSync(versionsDir(), { recursive: true });
  removeStalePartials();
  fs.mkdirSync(partial, { recursive: true });

  const fail = (error: string) => {
    fs.rmSync(partial, { recursive: true, force: true });
    return { ok: false as const, error };
  };

  const result = await npmSpawn(['install', '--prefix', partial, `${PACKAGE_NAME}@${version}`], {});
  if (result.code !== 0) {
    return fail(result.stderr.trim() || `npm install failed (exit ${result.code})`);
  }

  const entry = cliEntryInVersionDir(partial);
  if (!fs.existsSync(entry)) {
    return fail(`Install succeeded but missing CLI entry: ${entry}`);
  }

  const verified = verifyInstalledVersion(partial);
  if (!verified.ok) {
    return fail(`Install verification failed (${verified.file}): ${verified.error}`);
  }

  // Another process may have finished the same version first; keep its copy if it is intact.
  if (fs.existsSync(finalDir)) {
    if (verifyInstalledVersion(finalDir).ok) {
      fs.rmSync(partial, { recursive: true, force: true });
      return { ok: true, dir: finalDir };
    }
    fs.rmSync(finalDir, { recursive: true, force: true });
  }
  try {
    fs.renameSync(partial, finalDir);
  } catch (err) {
    if (fs.existsSync(finalDir) && verifyInstalledVersion(finalDir).ok) {
      fs.rmSync(partial, { recursive: true, force: true });
      return { ok: true, dir: finalDir };
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
  return { ok: true, dir: finalDir };
}
