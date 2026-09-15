import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Default patterns that Agent Deck writes under a project folder. */
export const AGENT_DECK_GIT_EXCLUDE_PATTERNS = [
  '/.agent-deck/',
  '/.cursor/rules/agent-deck-stubs/',
  '/.claude/skills/agent-deck-*/',
] as const;

/**
 * Append patterns to the repo's `.git/info/exclude` (local only).
 * No-op when `root` is not a git working tree. Idempotent.
 */
export function ensureGitExcluded(
  root: string,
  patterns: readonly string[] = AGENT_DECK_GIT_EXCLUDE_PATTERNS,
): void {
  if (patterns.length === 0) {
    return;
  }

  let excludeRel: string;
  try {
    excludeRel = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return;
  }

  if (!excludeRel) {
    return;
  }

  const excludePath = path.isAbsolute(excludeRel) ? excludeRel : path.resolve(root, excludeRel);
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });

  let existing = '';
  try {
    existing = fs.readFileSync(excludePath, 'utf8');
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }

  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );

  const toAppend = patterns.filter((pattern) => !present.has(pattern));
  if (toAppend.length === 0) {
    return;
  }

  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(excludePath, `${prefix}${toAppend.join('\n')}\n`, 'utf8');
}
