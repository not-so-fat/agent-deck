import fs from 'node:fs/promises';
import path from 'node:path';

import type { WorkspaceGrantManifest } from '@agent-deck/shared';
import { WorkspaceGrantManifestSchema } from '@agent-deck/shared';

const MANIFEST_FILENAME = 'use.json';
const MANIFEST_BACKUP = 'use.json.bak';
const MANIFEST_STAGING = 'use.json.staging';

export type GrantStoreKind = 'file' | 'keychain';

export interface GrantStore {
  kind: GrantStoreKind;
  read(): Promise<WorkspaceGrantManifest | null>;
  stage(manifest: WorkspaceGrantManifest): Promise<void>;
  activate(): Promise<void>;
  rollback(): Promise<void>;
  clear(): Promise<void>;
}

function manifestPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agent-deck', MANIFEST_FILENAME);
}

function stagingPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agent-deck', MANIFEST_STAGING);
}

function backupPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agent-deck', MANIFEST_BACKUP);
}

async function ensureAgentDeckDir(workspaceRoot: string): Promise<string> {
  const dir = path.join(workspaceRoot, '.agent-deck');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export class FileGrantStore implements GrantStore {
  readonly kind: GrantStoreKind = 'file';

  constructor(private readonly workspaceRoot: string) {}

  async read(): Promise<WorkspaceGrantManifest | null> {
    try {
      const raw = await fs.readFile(manifestPath(this.workspaceRoot), 'utf8');
      const parsed = WorkspaceGrantManifestSchema.parse(JSON.parse(raw));
      return parsed;
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return null;
      }
      // Legacy v1 use.json or corrupt manifest — caller falls back to readUseManifest.
      return null;
    }
  }

  async stage(manifest: WorkspaceGrantManifest): Promise<void> {
    await ensureAgentDeckDir(this.workspaceRoot);
    const target = manifestPath(this.workspaceRoot);
    try {
      await fs.copyFile(target, backupPath(this.workspaceRoot));
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        throw error;
      }
    }

    await fs.writeFile(stagingPath(this.workspaceRoot), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async activate(): Promise<void> {
    const staging = stagingPath(this.workspaceRoot);
    const target = manifestPath(this.workspaceRoot);
    await fs.rename(staging, target);
    await fs.chmod(target, 0o600);
  }

  async rollback(): Promise<void> {
    const staging = stagingPath(this.workspaceRoot);
    try {
      await fs.unlink(staging);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        throw error;
      }
    }

    const backup = backupPath(this.workspaceRoot);
    const target = manifestPath(this.workspaceRoot);
    try {
      await fs.copyFile(backup, target);
      await fs.chmod(target, 0o600);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        try {
          await fs.unlink(target);
        } catch {
          // no prior grant
        }
      } else {
        throw error;
      }
    }
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(manifestPath(this.workspaceRoot));
    } catch {
      // ignore
    }
  }
}

export class KeychainGrantStore implements GrantStore {
  readonly kind: GrantStoreKind = 'keychain';

  constructor(private readonly workspaceRoot: string) {}

  private account(): string {
    return `workspace-grant:${this.workspaceRoot}`;
  }

  private async runSecurity(args: string[]): Promise<string> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const result = await execFileAsync('security', args, { encoding: 'utf8' as BufferEncoding });
    return String(result.stdout ?? '').trim();
  }

  async read(): Promise<WorkspaceGrantManifest | null> {
    if (process.platform !== 'darwin') {
      return null;
    }

    try {
      const raw = await this.runSecurity([
        'find-generic-password',
        '-s',
        'agent-deck-workspace-grant',
        '-a',
        this.account(),
        '-w',
      ]);
      if (!raw) {
        return null;
      }
      return WorkspaceGrantManifestSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async stage(manifest: WorkspaceGrantManifest): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('Keychain grant store requires macOS');
    }

    const payload = JSON.stringify(manifest);
    try {
      await this.runSecurity([
        'delete-generic-password',
        '-s',
        'agent-deck-workspace-grant-staging',
        '-a',
        this.account(),
      ]);
    } catch {
      // may not exist
    }

    await this.runSecurity([
      'add-generic-password',
      '-s',
      'agent-deck-workspace-grant-staging',
      '-a',
      this.account(),
      '-w',
      payload,
      '-U',
    ]);
  }

  async activate(): Promise<void> {
    const staging = await this.runSecurity([
      'find-generic-password',
      '-s',
      'agent-deck-workspace-grant-staging',
      '-a',
      this.account(),
      '-w',
    ]);

    try {
      await this.runSecurity([
        'delete-generic-password',
        '-s',
        'agent-deck-workspace-grant',
        '-a',
        this.account(),
      ]);
    } catch {
      // may not exist
    }

    await this.runSecurity([
      'add-generic-password',
      '-s',
      'agent-deck-workspace-grant',
      '-a',
      this.account(),
      '-w',
      staging,
      '-U',
    ]);

    await this.runSecurity([
      'delete-generic-password',
      '-s',
      'agent-deck-workspace-grant-staging',
      '-a',
      this.account(),
    ]);
  }

  async rollback(): Promise<void> {
    if (process.platform !== 'darwin') {
      return;
    }

    try {
      await this.runSecurity([
        'delete-generic-password',
        '-s',
        'agent-deck-workspace-grant-staging',
        '-a',
        this.account(),
      ]);
    } catch {
      // ignore
    }
  }

  async clear(): Promise<void> {
    if (process.platform !== 'darwin') {
      return;
    }

    await this.runSecurity([
      'delete-generic-password',
      '-s',
      'agent-deck-workspace-grant',
      '-a',
      this.account(),
    ]);
  }
}

export function resolveGrantStore(workspaceRoot: string, prefer: GrantStoreKind = 'file'): GrantStore {
  if (prefer === 'keychain' && process.platform === 'darwin') {
    return new KeychainGrantStore(workspaceRoot);
  }
  return new FileGrantStore(workspaceRoot);
}

export async function readWorkspaceGrant(
  workspaceRoot: string,
  prefer: GrantStoreKind = 'file',
): Promise<WorkspaceGrantManifest | null> {
  const fileStore = new FileGrantStore(workspaceRoot);
  const fromFile = await fileStore.read();
  if (fromFile) {
    return fromFile;
  }

  if (prefer === 'keychain' || process.platform === 'darwin') {
    const keychainStore = new KeychainGrantStore(workspaceRoot);
    return keychainStore.read();
  }

  return null;
}
