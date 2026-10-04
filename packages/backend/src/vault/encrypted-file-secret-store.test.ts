import { randomBytes } from 'node:crypto';
import fs from 'fs/promises';
import os from 'node:os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EncryptedFileSecretStore,
  VAULT_KEY_ENV_VAR,
  VaultDecryptionError,
  VaultKeyError,
  parseVaultKey,
} from './encrypted-file-secret-store';
import { createSecretStore } from './secret-store';

describe('EncryptedFileSecretStore', () => {
  let dir: string;
  const key = randomBytes(32);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-deck-vault-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function store(secretsDir: string = dir, keyBytes: Buffer = key) {
    return new EncryptedFileSecretStore({ secretsDir, key: keyBytes });
  }

  it('round-trips set/get/has/delete', async () => {
    const vault = store();
    expect(await vault.has('cred-1')).toBe(false);
    expect(await vault.get('cred-1')).toBeNull();

    await vault.set('cred-1', 'super-secret-value');
    expect(await vault.has('cred-1')).toBe(true);
    expect(await vault.get('cred-1')).toBe('super-secret-value');

    await vault.delete('cred-1');
    expect(await vault.has('cred-1')).toBe(false);
    expect(await vault.get('cred-1')).toBeNull();
    await vault.delete('cred-1');
  });

  it('survives restart: a new instance with the same dir and key decrypts', async () => {
    await store().set('oauth-client-secret:svc-1', 'client-secret-xyz');
    const reopened = store();
    expect(await reopened.get('oauth-client-secret:svc-1')).toBe('client-secret-xyz');
  });

  it('fails closed with a wrong key and leaks no secret detail', async () => {
    await store().set('cred-1', 'super-secret-value');
    const wrongKey = store(dir, randomBytes(32));
    const failure = await wrongKey.get('cred-1').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(VaultDecryptionError);
    expect(String((failure as Error).message)).not.toContain('super-secret-value');
  });

  it('keeps plaintext out of the at-rest file', async () => {
    const secret = 'plaintext-must-never-hit-disk-abc123';
    await store().set('cred-1', secret);
    const raw = await fs.readFile(path.join(dir, 'cred-1.enc'), 'utf8');
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw)).toMatchObject({ v: 1, alg: 'aes-256-gcm' });
  });

  it('uses a fresh nonce per write so identical values differ at rest', async () => {
    await store().set('a', 'same-value');
    await store().set('b', 'same-value');
    const [rawA, rawB] = await Promise.all([
      fs.readFile(path.join(dir, 'a.enc'), 'utf8'),
      fs.readFile(path.join(dir, 'b.enc'), 'utf8'),
    ]);
    expect(rawA).not.toBe(rawB);
  });

  it('fails closed on tampered files', async () => {
    await store().set('cred-1', 'super-secret-value');
    const file = path.join(dir, 'cred-1.enc');
    const envelope = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string>;
    envelope.ciphertext = Buffer.from('tampered-by-attacker').toString('base64');
    await fs.writeFile(file, JSON.stringify(envelope), 'utf8');
    await expect(store().get('cred-1')).rejects.toBeInstanceOf(VaultDecryptionError);
  });

  it('rejects an envelope copied from another account (account is authenticated)', async () => {
    const vault = store();
    await vault.set('cred-a', 'secret-for-a');
    await vault.set('cred-b', 'secret-for-b');
    await fs.copyFile(path.join(dir, 'cred-a.enc'), path.join(dir, 'cred-b.enc'));
    await expect(vault.get('cred-b')).rejects.toBeInstanceOf(VaultDecryptionError);
    expect(await vault.get('cred-a')).toBe('secret-for-a');
  });

  it('writes files with mode 0600 and leaves no temp files behind', async () => {
    await store().set('cred-1', 'v');
    const stat = await fs.stat(path.join(dir, 'cred-1.enc'));
    expect(stat.mode & 0o777).toBe(0o600);
    const names = await fs.readdir(dir);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('survives concurrent writes to the same account', async () => {
    const vault = store();
    await Promise.all(Array.from({ length: 20 }, (_, i) => vault.set('cred-1', `value-${i}`)));
    expect(await vault.get('cred-1')).toMatch(/^value-\d+$/);
    const names = await fs.readdir(dir);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects path-traversal account names', async () => {
    const vault = store();
    await expect(vault.set('../escape', 'x')).rejects.toThrow(/Invalid secret account/);
    await expect(vault.get('a/b')).rejects.toThrow(/Invalid secret account/);
  });
});

describe('parseVaultKey', () => {
  it('accepts base64 (openssl rand -base64 32 output)', () => {
    const raw = randomBytes(32).toString('base64');
    expect(parseVaultKey(raw)).toHaveLength(32);
  });

  it('accepts url-safe base64 and hex', () => {
    const bytes = randomBytes(32);
    expect(parseVaultKey(bytes.toString('base64url'))).toEqual(bytes);
    expect(parseVaultKey(bytes.toString('hex'))).toEqual(bytes);
  });

  it('rejects missing and short keys with an actionable error naming the env var', () => {
    expect(() => parseVaultKey(undefined)).toThrowError(VaultKeyError);
    expect(() => parseVaultKey('   ')).toThrowError(VaultKeyError);
    expect(() => parseVaultKey('too-short')).toThrowError(VaultKeyError);
    try {
      parseVaultKey('too-short');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain(VAULT_KEY_ENV_VAR);
      expect((error as Error).message).toContain('openssl rand -base64 32');
      expect((error as Error).message).not.toContain('too-short');
    }
  });

  it('rejects a non-32-byte key passed explicitly to the constructor', () => {
    expect(
      () => new EncryptedFileSecretStore({ secretsDir: os.tmpdir(), key: randomBytes(16) }),
    ).toThrowError(VaultKeyError);
  });
});

describe('createSecretStore vault-key selection', () => {
  const savedStore = process.env.AGENT_DECK_SECRET_STORE;
  const savedKey = process.env[VAULT_KEY_ENV_VAR];
  const savedHostedMode = process.env.AGENT_DECK_HOSTED_MODE;

  beforeEach(() => {
    delete process.env.AGENT_DECK_SECRET_STORE;
    delete process.env[VAULT_KEY_ENV_VAR];
    delete process.env.AGENT_DECK_HOSTED_MODE;
  });

  afterEach(() => {
    if (savedStore === undefined) {
      delete process.env.AGENT_DECK_SECRET_STORE;
    } else {
      process.env.AGENT_DECK_SECRET_STORE = savedStore;
    }
    if (savedKey === undefined) {
      delete process.env[VAULT_KEY_ENV_VAR];
    } else {
      process.env[VAULT_KEY_ENV_VAR] = savedKey;
    }
    if (savedHostedMode === undefined) {
      delete process.env.AGENT_DECK_HOSTED_MODE;
    } else {
      process.env.AGENT_DECK_HOSTED_MODE = savedHostedMode;
    }
  });

  it('selects the encrypted store when the vault key is supplied', () => {
    process.env[VAULT_KEY_ENV_VAR] = randomBytes(32).toString('base64');
    expect(createSecretStore()).toBeInstanceOf(EncryptedFileSecretStore);
  });

  it('selects the encrypted store for the explicit encrypted-file selector', () => {
    process.env.AGENT_DECK_SECRET_STORE = 'encrypted-file';
    process.env[VAULT_KEY_ENV_VAR] = randomBytes(32).toString('hex');
    expect(createSecretStore()).toBeInstanceOf(EncryptedFileSecretStore);
  });

  it('fails fast with a key error when the selector has no usable key', () => {
    process.env.AGENT_DECK_SECRET_STORE = 'encrypted-file';
    expect(() => createSecretStore()).toThrowError(VaultKeyError);
  });

  it('requires the portable encrypted vault in hosted mode on every OS', () => {
    process.env.AGENT_DECK_HOSTED_MODE = '1';
    expect(() => createSecretStore()).toThrowError(VaultKeyError);
  });
});
