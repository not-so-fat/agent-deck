import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical workspace path (PRD C1).
 * Resolves symlinks when the path exists, normalizes separators, applies NFC,
 * strips trailing separators, and lowercases Windows drive letters.
 */
export function canonicalizeWorkspacePath(inputPath: string): string {
  const absolute = path.resolve(inputPath);

  let resolved = absolute;
  try {
    resolved = fs.realpathSync.native(absolute);
  } catch {
    resolved = path.normalize(absolute);
  }

  if (process.platform === 'win32') {
    resolved = resolved.replace(/^([A-Za-z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
    resolved = resolved.replace(/\//g, '\\');
  } else {
    resolved = resolved.replace(/\\/g, '/');
  }

  resolved = path.normalize(resolved);

  const isRoot =
    resolved === '/' ||
    (process.platform === 'win32' && /^[a-z]:\\?$/i.test(resolved));

  if (!isRoot && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
    resolved = resolved.replace(/[\\/]+$/, '');
  }

  return resolved.normalize('NFC');
}

/** Stable digest of canonical path — used before opaque workspaceKey registration. */
export function digestCanonicalWorkspacePath(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath, 'utf8').digest('hex');
}

export function prefixTrustedId(kind: 'wsp' | 'wgr' | 'ses' | 'adm', rawId: string): string {
  return `${kind}_${rawId.replace(/-/g, '')}`;
}
