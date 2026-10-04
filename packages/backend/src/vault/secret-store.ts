import fs from 'fs/promises';
import path from 'path';
import { EncryptedFileSecretStore } from './encrypted-file-secret-store';
import { getAgentDeckHome } from './yaml-sync';

export interface SecretStore {
  set(account: string, value: string): Promise<void>;
  get(account: string): Promise<string | null>;
  delete(account: string): Promise<void>;
  has(account: string): Promise<boolean>;
}

export class VaultUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultUnsupportedError';
  }
}

export class MemorySecretStore implements SecretStore {
  private secrets = new Map<string, string>();

  async set(account: string, value: string): Promise<void> {
    this.secrets.set(account, value);
  }

  async get(account: string): Promise<string | null> {
    return this.secrets.get(account) ?? null;
  }

  async delete(account: string): Promise<void> {
    this.secrets.delete(account);
  }

  async has(account: string): Promise<boolean> {
    return this.secrets.has(account);
  }
}

/** Fail closed while allowing liveness/readiness to explain bad operator config. */
export class UnavailableSecretStore implements SecretStore {
  private unavailable(): never {
    throw new VaultUnsupportedError('The configured vault is unavailable. Check /readyz.');
  }

  async set(_account: string, _value: string): Promise<void> { this.unavailable(); }
  async get(_account: string): Promise<string | null> { return this.unavailable(); }
  async delete(_account: string): Promise<void> { this.unavailable(); }
  async has(_account: string): Promise<boolean> { return this.unavailable(); }
}

export class DevFileSecretStore implements SecretStore {
  private readonly secretsDir: string;

  constructor(secretsDir?: string) {
    this.secretsDir = secretsDir ?? path.join(getAgentDeckHome(), 'secrets');
  }

  private secretPath(account: string): string {
    return path.join(this.secretsDir, `${account}.secret`);
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
  }

  async set(account: string, value: string): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.secretPath(account), value, { encoding: 'utf8', mode: 0o600 });
  }

  async get(account: string): Promise<string | null> {
    try {
      return await fs.readFile(this.secretPath(account), 'utf8');
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
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

export class MacOSKeychainStore implements SecretStore {
  private readonly serviceName = 'agent-deck';

  private async runSecurity(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    try {
      const result = await execFileAsync('security', args, { encoding: 'utf8' as BufferEncoding });
      return {
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
      };
    } catch (error: unknown) {
      const execError = error as { stdout?: unknown; stderr?: unknown; message?: string };
      const stderr = String(execError.stderr ?? execError.message ?? 'Keychain operation failed');
      const wrapped = new Error(stderr.trim() || 'Keychain operation failed');
      throw wrapped;
    }
  }

  async set(account: string, value: string): Promise<void> {
    try {
      await this.runSecurity([
        'delete-generic-password',
        '-s',
        this.serviceName,
        '-a',
        account,
      ]);
    } catch {
      // Item may not exist yet.
    }

    await this.runSecurity([
      'add-generic-password',
      '-s',
      this.serviceName,
      '-a',
      account,
      '-w',
      value,
      '-U',
    ]);
  }

  async get(account: string): Promise<string | null> {
    try {
      const { stdout } = await this.runSecurity([
        'find-generic-password',
        '-s',
        this.serviceName,
        '-a',
        account,
        '-w',
      ]);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async delete(account: string): Promise<void> {
    await this.runSecurity([
      'delete-generic-password',
      '-s',
      this.serviceName,
      '-a',
      account,
    ]);
  }

  async has(account: string): Promise<boolean> {
    const value = await this.get(account);
    return value !== null;
  }
}

export function createSecretStore(): SecretStore {
  if (process.env.AGENT_DECK_SECRET_STORE === 'memory') {
    return new MemorySecretStore();
  }

  if (process.env.AGENT_DECK_SECRET_STORE === 'file') {
    return new DevFileSecretStore();
  }

  if (process.env.AGENT_DECK_SECRET_STORE === 'encrypted-file') {
    return new EncryptedFileSecretStore();
  }

  // Hosted mode has one portable vault contract on every OS. In particular,
  // a developer launching hosted mode on macOS must not silently use Keychain.
  if (process.env.AGENT_DECK_HOSTED_MODE === '1') {
    return new EncryptedFileSecretStore();
  }

  // A separately supplied vault key always selects the encrypted store —
  // including on macOS — so backup/restore only decrypts with the key.
  if (process.env.AGENT_DECK_VAULT_KEY) {
    return new EncryptedFileSecretStore();
  }

  if (process.platform === 'darwin') {
    return new MacOSKeychainStore();
  }

  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      '[agent-deck] macOS Keychain unavailable — using dev file secret store (~/.agent-deck/secrets).',
    );
    return new DevFileSecretStore();
  }

  throw new VaultUnsupportedError(
    'No usable secret store on this host. For the single-owner hosted ' +
      'appliance, set AGENT_DECK_VAULT_KEY to a 32-byte key ' +
      '(`openssl rand -base64 32`) to select the encrypted file store; ' +
      'the key must be protected separately from the data volume. ' +
      'Set AGENT_DECK_SECRET_STORE=memory only for throwaway dev use.',
  );
}
