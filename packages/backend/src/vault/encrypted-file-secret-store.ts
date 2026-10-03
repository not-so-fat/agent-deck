import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'fs/promises';
import os from 'node:os';
import path from 'path';

import type { SecretStore } from './secret-store';
import { getAgentDeckHome } from './yaml-sync';

/**
 * NOT-317 WS3: encrypted persistent vault for the single-owner hosted
 * appliance (Linux production has no macOS Keychain).
 *
 * One AES-256-GCM envelope per account, written atomically (tmp + rename)
 * with `0600` permissions under `<home>/secrets/`. The 32-byte vault key is
 * supplied separately from the volume (env `AGENT_DECK_VAULT_KEY`) so a
 * backup of the volume alone never decrypts — restart and backup/restore
 * only recover credentials when the key is supplied again.
 *
 * The key is constructor-injectable (Buffer) so the store stays a
 * replaceable vault adapter: a later shared service can swap the source
 * without touching callers. Error messages never echo key material.
 */

export const VAULT_KEY_ENV_VAR = 'AGENT_DECK_VAULT_KEY';
export const ENCRYPTED_SECRET_STORE_NAME = 'encrypted-file';

const FILE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

type EnvelopeV1 = {
  v: number;
  alg: string;
  nonce: string;
  tag: string;
  ciphertext: string;
};

/** Wrong key, tampered file, or unreadable envelope — fail closed. */
export class VaultDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultDecryptionError';
  }
}

/** The supplied vault key is missing or malformed — operator config error. */
export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultKeyError';
  }
}

function base64ToBytes(raw: string): Buffer | null {
  const normalized = raw.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) {
    return null;
  }
  try {
    return Buffer.from(padded, 'base64');
  } catch {
    return null;
  }
}

/**
 * Parse a 32-byte vault key from its env encoding: base64 (standard or
 * url-safe, as produced by `openssl rand -base64 32`) or 64 hex chars.
 * Throws VaultKeyError naming the env var — never the key.
 */
export function parseVaultKey(raw: string | undefined): Buffer {
  if (!raw || !raw.trim()) {
    throw new VaultKeyError(
      `${VAULT_KEY_ENV_VAR} is not set. Generate one with ` +
        '`openssl rand -base64 32` and supply it separately from the data volume.',
    );
  }
  const trimmed = raw.trim();
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    candidates.push(Buffer.from(trimmed, 'hex'));
  }
  const b64 = base64ToBytes(trimmed);
  if (b64) {
    candidates.push(b64);
  }
  const key = candidates.find((c) => c.length === KEY_BYTES);
  if (!key) {
    throw new VaultKeyError(
      `${VAULT_KEY_ENV_VAR} must decode to ${KEY_BYTES} bytes ` +
        '(base64 of 32 random bytes, or 64 hex chars). ' +
        'Generate one with `openssl rand -base64 32`.',
    );
  }
  return key;
}

/** Read the vault key from the environment (throws VaultKeyError when unusable). */
export function readVaultKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseVaultKey(env[VAULT_KEY_ENV_VAR]);
}

export type EncryptedFileSecretStoreOptions = {
  /** 32-byte key. Defaults to `readVaultKeyFromEnv()`. */
  key?: Buffer;
  /** Defaults to `<agent-deck-home>/secrets`. */
  secretsDir?: string;
};

export class EncryptedFileSecretStore implements SecretStore {
  private readonly key: Buffer;
  private readonly secretsDir: string;

  constructor(options: EncryptedFileSecretStoreOptions = {}) {
    const key = options.key ?? readVaultKeyFromEnv();
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      throw new VaultKeyError(
        `Vault key must be ${KEY_BYTES} bytes. Supply ${VAULT_KEY_ENV_VAR} ` +
          '(`openssl rand -base64 32`) or pass a 32-byte key explicitly.',
      );
    }
    this.key = Buffer.from(key);
    this.secretsDir = options.secretsDir ?? path.join(getAgentDeckHome(), 'secrets');
  }

  private secretPath(account: string): string {
    if (!account || account.includes('/') || account.includes('\\') || account.includes('..') || account.includes('\0')) {
      throw new Error(`Invalid secret account name: ${JSON.stringify(account)}`);
    }
    return path.join(this.secretsDir, `${account}.enc`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Authenticated data binds an envelope to its account and format version, so a
   * file copied over another account's path fails to decrypt instead of
   * silently yielding the wrong credential.
   */
  private aad(account: string): Buffer {
    return Buffer.from(`agent-deck-vault:v${FILE_VERSION}:${account}`, 'utf8');
  }

  private encrypt(account: string, plaintext: string): EnvelopeV1 {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, nonce);
    cipher.setAAD(this.aad(account));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      v: FILE_VERSION,
      alg: ALGORITHM,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private decrypt(account: string, envelope: EnvelopeV1): string {
    if (envelope?.v !== FILE_VERSION || envelope?.alg !== ALGORITHM) {
      throw new VaultDecryptionError('Unsupported vault envelope version.');
    }
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.key,
        Buffer.from(envelope.nonce, 'base64'),
      );
      decipher.setAAD(this.aad(account));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return (
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')).toString('utf8') +
        decipher.final().toString('utf8')
      );
    } catch {
      // Wrong key and tampered files share one error: no oracle, no detail.
      throw new VaultDecryptionError(
        'Cannot decrypt the vault entry (wrong vault key or tampered file).',
      );
    }
  }

  async set(account: string, value: string): Promise<void> {
    await this.ensureDir();
    const target = this.secretPath(account);
    const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.encrypt(account, value)), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tmp, target);
    await fs.chmod(target, 0o600);
  }

  async get(account: string): Promise<string | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.secretPath(account), 'utf8');
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    let envelope: EnvelopeV1;
    try {
      envelope = JSON.parse(raw) as EnvelopeV1;
    } catch {
      throw new VaultDecryptionError('Cannot decrypt the vault entry (tampered file).');
    }
    return this.decrypt(account, envelope);
  }

  async delete(account: string): Promise<void> {
    try {
      await fs.unlink(this.secretPath(account));
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async has(account: string): Promise<boolean> {
    try {
      await fs.access(this.secretPath(account));
      return true;
    } catch {
      return false;
    }
  }
}

/** Best-effort temp-dir helper for tests; production always uses the vault home. */
export async function makeTempSecretsDir(prefix = 'agent-deck-vault-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
