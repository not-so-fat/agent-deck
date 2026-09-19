import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export type VerifyResult = { ok: true } | { ok: false; file: string; error: string };

const CJS_WRAPPER_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname'];

function* walkJsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      yield full;
    }
  }
}

/**
 * Syntax-checks every built `@agent-deck/*` file in an installed version dir.
 * A truncated file (interrupted or interleaved npm extraction) otherwise crashes the CLI at load
 * time, after the `current` link already points at it.
 */
export function verifyInstalledVersion(versionDirPath: string): VerifyResult {
  const scope = path.join(versionDirPath, 'node_modules', '@agent-deck');
  let packages: fs.Dirent[];
  try {
    packages = fs.readdirSync(scope, { withFileTypes: true });
  } catch (err) {
    return { ok: false, file: scope, error: err instanceof Error ? err.message : String(err) };
  }

  for (const pkg of packages) {
    const distDir = path.join(scope, pkg.name, 'dist');
    if (!fs.existsSync(distDir)) {
      continue;
    }
    for (const file of walkJsFiles(distDir)) {
      try {
        const source = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
        vm.compileFunction(source, CJS_WRAPPER_PARAMS, { filename: file });
      } catch (err) {
        return { ok: false, file, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  return { ok: true };
}
