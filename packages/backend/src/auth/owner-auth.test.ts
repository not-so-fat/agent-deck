import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { SqliteOwnerAuthProvider } from './owner-auth';

describe('SqliteOwnerAuthProvider', () => {
  it('bootstraps exactly one owner and stores no plaintext secrets', async () => {
    const db = new Database(':memory:');
    const provider = new SqliteOwnerAuthProvider(db, 'bootstrap-sentinel');

    expect(
      await provider.bootstrap({
        owner: 'owner@example.test',
        credential: 'credential-sentinel',
        bootstrapSecret: 'bootstrap-sentinel',
      }),
    ).toBe(true);
    expect(
      await provider.bootstrap({
        owner: 'second@example.test',
        credential: 'other-credential',
        bootstrapSecret: 'bootstrap-sentinel',
      }),
    ).toBe(false);

    const row = db.prepare('SELECT * FROM owner_credentials').get() as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain('credential-sentinel');
    expect(JSON.stringify(row)).not.toContain('bootstrap-sentinel');
  });

  it('authenticates only the matching owner and credential', async () => {
    const db = new Database(':memory:');
    const provider = new SqliteOwnerAuthProvider(db, 'bootstrap-secret');
    await provider.bootstrap({
      owner: 'owner@example.test',
      credential: 'correct horse battery staple',
      bootstrapSecret: 'bootstrap-secret',
    });

    await expect(
      provider.authenticate({
        owner: 'owner@example.test',
        credential: 'correct horse battery staple',
      }),
    ).resolves.toBe(true);
    await expect(
      provider.authenticate({ owner: 'owner@example.test', credential: 'wrong' }),
    ).resolves.toBe(false);
    await expect(
      provider.authenticate({ owner: 'unknown@example.test', credential: 'wrong' }),
    ).resolves.toBe(false);
  });
});
