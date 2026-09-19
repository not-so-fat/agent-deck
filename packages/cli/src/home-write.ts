/**
 * Host agent sandboxes (Cursor Shell: workspace-writable only) block writes under
 * ~/.agent-deck. Opening the SQLite store still runs migrations, so agents see a
 * bare "attempt to write a readonly database" instead of an actionable recovery.
 */

export const HOME_STORE_WRITE_BLOCKED_HINT =
  'Host agent sandboxes often cannot write ~/.agent-deck. Re-run this command in an unsandboxed terminal (or request elevated permissions), not via a workspace-only shell.';

export function isHomeStoreWriteError(error: unknown): boolean {
  if (error == null) {
    return false;
  }
  const err = error as NodeJS.ErrnoException & { code?: string | number };
  const code = String(err.code ?? '');
  const message = error instanceof Error ? error.message : String(error);
  const combined = `${code} ${message}`.toLowerCase();

  if (
    code === 'EROFS' ||
    code === 'EPERM' ||
    code === 'EACCES' ||
    code === 'SQLITE_READONLY' ||
    code === 'SQLITE_CANTOPEN'
  ) {
    return true;
  }
  if (
    combined.includes('readonly database') ||
    combined.includes('attempt to write a readonly') ||
    combined.includes('operation not permitted') ||
    combined.includes('read-only file system') ||
    combined.includes('erofs')
  ) {
    return true;
  }
  return false;
}

export function formatHomeStoreWriteBlockedMessage(detail?: string): string {
  const lines = [
    'Cannot write the Agent Deck home store (~/.agent-deck).',
    HOME_STORE_WRITE_BLOCKED_HINT,
  ];
  if (detail?.trim()) {
    lines.push(`Detail: ${detail.trim()}`);
  }
  return lines.join('\n');
}

/** True when `deckRef` names the same deck as an existing folder assignment. */
export function assignmentMatchesDeckRef(
  assignment: { deckId: string; deckName: string },
  deckRef: string,
): boolean {
  const trimmed = deckRef.trim();
  if (!trimmed) {
    return false;
  }
  if (assignment.deckId === trimmed) {
    return true;
  }
  return assignment.deckName.toLowerCase() === trimmed.toLowerCase();
}
