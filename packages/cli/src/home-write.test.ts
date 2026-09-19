import { describe, expect, it } from 'vitest';

import {
  HOME_STORE_WRITE_BLOCKED_HINT,
  assignmentMatchesDeckRef,
  formatHomeStoreWriteBlockedMessage,
  isHomeStoreWriteError,
} from './home-write';

describe('home-write error detection', () => {
  it('recognizes SQLite readonly and sandbox permission failures', () => {
    expect(isHomeStoreWriteError(new Error('attempt to write a readonly database'))).toBe(true);
    const sqlite = new Error('SQLITE_READONLY: attempt to write a readonly database') as NodeJS.ErrnoException;
    sqlite.code = 'SQLITE_READONLY';
    expect(isHomeStoreWriteError(sqlite)).toBe(true);

    const eperm = new Error('Operation not permitted') as NodeJS.ErrnoException;
    eperm.code = 'EPERM';
    expect(isHomeStoreWriteError(eperm)).toBe(true);

    const erofs = new Error('read-only file system') as NodeJS.ErrnoException;
    erofs.code = 'EROFS';
    expect(isHomeStoreWriteError(erofs)).toBe(true);

    expect(isHomeStoreWriteError(new Error('Deck not found: missing'))).toBe(false);
  });

  it('formats an actionable home-write message without leaving bare sqlite text alone', () => {
    const message = formatHomeStoreWriteBlockedMessage('attempt to write a readonly database');
    expect(message).toContain(HOME_STORE_WRITE_BLOCKED_HINT);
    expect(message).toContain('unsandboxed');
    expect(message).toContain('Detail: attempt to write a readonly database');
    expect(message.startsWith('attempt to write a readonly database')).toBe(false);
  });

  it('matches assignment deck by id or case-insensitive name', () => {
    const assignment = { deckId: 'deck-1', deckName: 'personal-dev' };
    expect(assignmentMatchesDeckRef(assignment, 'deck-1')).toBe(true);
    expect(assignmentMatchesDeckRef(assignment, 'personal-dev')).toBe(true);
    expect(assignmentMatchesDeckRef(assignment, 'Personal-Dev')).toBe(true);
    expect(assignmentMatchesDeckRef(assignment, 'other')).toBe(false);
  });
});
