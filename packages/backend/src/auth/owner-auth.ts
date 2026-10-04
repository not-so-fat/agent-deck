import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type Database from 'better-sqlite3';

const scrypt = promisify(scryptCallback);
const SCRYPT_KEY_LENGTH = 32;
const DUMMY_SALT = Buffer.from('agent-deck-owner-auth-dummy-salt-v1', 'utf8');
const DUMMY_HASH = Buffer.alloc(SCRYPT_KEY_LENGTH);

export type OwnerCredentialInput = {
  owner: string;
  credential: string;
};

export type OwnerBootstrapInput = OwnerCredentialInput & {
  bootstrapSecret: string;
};

export interface OwnerAuthProvider {
  bootstrap(input: OwnerBootstrapInput): Promise<boolean>;
  authenticate(input: OwnerCredentialInput): Promise<boolean>;
}

type OwnerCredentialRow = {
  owner_id: string;
  credential_salt: Buffer;
  credential_hash: Buffer;
};

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeStringEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(digest(actual), digest(expected));
}

async function deriveCredential(credential: string, salt: Buffer): Promise<Buffer> {
  return (await scrypt(credential, salt, SCRYPT_KEY_LENGTH)) as Buffer;
}

/**
 * V1 single-owner adapter. The database stores only a memory-hard credential
 * hash; the bootstrap secret is configuration, never persistence.
 */
export class SqliteOwnerAuthProvider implements OwnerAuthProvider {
  constructor(
    private readonly db: Database.Database,
    private readonly bootstrapSecret: string | undefined,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS owner_credentials (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_id TEXT NOT NULL,
        credential_salt BLOB NOT NULL,
        credential_hash BLOB NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  async bootstrap(input: OwnerBootstrapInput): Promise<boolean> {
    const configuredSecret = this.bootstrapSecret ?? '';
    const secretMatches = constantTimeStringEqual(input.bootstrapSecret, configuredSecret);
    if (!configuredSecret || !secretMatches || !input.owner.trim() || !input.credential) {
      return false;
    }

    const salt = randomBytes(16);
    const credentialHash = await deriveCredential(input.credential, salt);
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO owner_credentials
         (singleton, owner_id, credential_salt, credential_hash, created_at)
         VALUES (1, ?, ?, ?, ?)`,
      )
      .run(input.owner.trim(), salt, credentialHash, new Date().toISOString());
    return inserted.changes === 1;
  }

  async authenticate(input: OwnerCredentialInput): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT owner_id, credential_salt, credential_hash
         FROM owner_credentials WHERE singleton = 1`,
      )
      .get() as OwnerCredentialRow | undefined;

    // Unknown owners and an unbootstrapped store still pay the same scrypt
    // cost as a valid owner. Combine both comparisons without an early exit.
    const actualHash = await deriveCredential(
      input.credential,
      row?.credential_salt ?? DUMMY_SALT,
    );
    const ownerMatches = constantTimeStringEqual(input.owner, row?.owner_id ?? '');
    const credentialMatches = timingSafeEqual(
      actualHash,
      row?.credential_hash ?? DUMMY_HASH,
    );
    return Boolean(row) && ownerMatches && credentialMatches;
  }
}
