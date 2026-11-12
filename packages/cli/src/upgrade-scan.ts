/**
 * Assigned-folder discovery for `agent-deck upgrade --scan <dir>` (NOT-577).
 *
 * The daemon keeps no folder registry (`~/.agent-deck/bindings.json` holds
 * only the current binding), so the scan pass walks each `--scan` root to a
 * bounded depth and collects folders that carry `.agent-deck/use.json`.
 * The migration itself reuses the launcher-migration rewrite with
 * `workspaceRoot` set to each folder, plus the Cursor project entry.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Directory names never descended into during a scan. */
export const SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.next',
  '.temporal',
]);

/**
 * Maximum descent below each scan root. The root itself is depth 0, its
 * children depth 1, and so on — depth 6 covers `<root>/<a>/<b>/<c>/<d>/<e>/<f>`.
 */
export const SCAN_MAX_DEPTH = 6;

/** Parse repeatable `--scan <dir>` / `--scan=<dir>` from upgrade args. */
export function parseScanDirs(args: string[]): { dirs: string[]; error?: string } {
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--scan') {
      const next = args[i + 1];
      if (!next || next.startsWith('-')) {
        return { dirs, error: '--scan requires a directory argument' };
      }
      dirs.push(next);
      i += 1;
    } else if (arg.startsWith('--scan=')) {
      const value = arg.slice('--scan='.length);
      if (!value) {
        return { dirs, error: '--scan requires a directory argument' };
      }
      dirs.push(value);
    }
  }
  return { dirs };
}

function hasUseJson(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.agent-deck', 'use.json')).isFile();
  } catch {
    return false;
  }
}

function walk(dir: string, depth: number, found: Set<string>): void {
  if (hasUseJson(dir)) {
    found.add(path.resolve(dir));
  }
  if (depth >= SCAN_MAX_DEPTH) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SCAN_SKIP_DIRS.has(entry.name)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    walk(path.join(dir, entry.name), depth + 1, found);
  }
}

/**
 * Collect assigned folders under each root: every directory at depth
 * 0..SCAN_MAX_DEPTH holding `.agent-deck/use.json`. Skipped silently:
 * SCAN_SKIP_DIRS names, symlinked directories (no loop risk), and any
 * directory that cannot be read. Results are deduplicated and sorted.
 */
export function findAssignedFolders(roots: string[]): string[] {
  const found = new Set<string>();
  for (const root of roots) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    walk(path.resolve(root), 0, found);
  }
  return [...found].sort();
}
