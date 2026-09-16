import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseManager } from '../models/database';
import { ServiceManager } from '../services/service-manager';
import { CredentialManager } from '../vault/credential-manager';
import { MemorySecretStore } from '../vault/secret-store';
import { CredentialYamlSync } from '../vault/yaml-sync';
import { storePaths } from './paths';
import { FileStoreWriter } from './writer';

/**
 * The card-delete protocol, past the deck files: the card's own file always goes
 * with the row, and cleanup that runs after the delete has committed can never
 * turn a finished delete back into a failure the caller cannot retry.
 */
describe('card delete', () => {
  let home: string;
  let previousHome: string | undefined;
  let db: DatabaseManager;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-card-delete-'));
    previousHome = process.env.AGENT_DECK_HOME;
    process.env.AGENT_DECK_HOME = home;
    process.env.AGENT_DECK_SECRET_STORE = 'memory';
    db = new DatabaseManager(path.join(home, 'agent_deck.db'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    db.close();
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
    delete process.env.AGENT_DECK_SECRET_STORE;
    await fs.rm(home, { recursive: true, force: true });
  });

  function credentialYamlPath(id: string) {
    return path.join(storePaths(home).credentialsDir, `${id}.yaml`);
  }

  async function makeCredentialManager(storeWriter?: FileStoreWriter) {
    return new CredentialManager(
      db,
      new MemorySecretStore(),
      new CredentialYamlSync(),
      storeWriter,
    );
  }

  async function createCredential(manager: CredentialManager, id: string) {
    return manager.create({
      id,
      label: 'Remote key',
      scheme: 'bearer',
      envName: 'REMOTE_API_KEY',
      value: 'secret-value',
      tags: [],
    });
  }

  // The writer is only for deck files, but credential YAML is written through
  // CredentialYamlSync either way — so a manager built without a writer still has
  // a file to remove, and leaving it behind lets the next reindex bring the
  // credential back from the dead.
  it('removes the credential file when no deck-file writer is injected', async () => {
    const manager = await makeCredentialManager(undefined);
    const credential = await createCredential(manager, 'cred_no_writer');
    await fs.access(credentialYamlPath(credential.id));

    expect(await manager.delete(credential.id)).toBe(true);

    expect(await db.getCredential(credential.id)).toBeNull();
    await expect(fs.access(credentialYamlPath(credential.id))).rejects.toThrow();
  });

  it('keeps the card file when the row survives a failed delete', async () => {
    const writer = new FileStoreWriter(home);
    await writer.ensureLayout();
    const manager = await makeCredentialManager(writer);
    const credential = await createCredential(manager, 'cred_unwritable');

    vi.spyOn(CredentialYamlSync.prototype, 'remove').mockRejectedValueOnce(
      new Error('EACCES: credential file is read-only'),
    );

    await expect(manager.delete(credential.id)).rejects.toThrow('EACCES');
    await fs.access(credentialYamlPath(credential.id));
    expect(await db.getCredential(credential.id)).not.toBeNull();
  });

  // Row and files are already gone once cleanup runs, so throwing here would
  // report a failure the caller cannot act on: the retry it invites returns false
  // on the missing row and never reaches the cleanup again.
  it('reports success when the vault cleanup fails after the delete commits', async () => {
    const secretStore = new MemorySecretStore();
    const manager = new CredentialManager(
      db,
      secretStore,
      new CredentialYamlSync(),
      new FileStoreWriter(home),
    );
    const credential = await createCredential(manager, 'cred_stuck_vault');

    vi.spyOn(secretStore, 'delete').mockRejectedValueOnce(
      new Error('keychain is locked'),
    );

    expect(await manager.delete(credential.id)).toBe(true);
    expect(await db.getCredential(credential.id)).toBeNull();
    await expect(fs.access(credentialYamlPath(credential.id))).rejects.toThrow();
  });

  it('reports success when the header cleanup fails after the delete commits', async () => {
    const writer = new FileStoreWriter(home);
    await writer.ensureLayout();
    const headerVault = {
      set: vi.fn(),
      get: vi.fn(),
      has: vi.fn(),
      delete: vi.fn().mockRejectedValue(new Error('keychain is locked')),
    };
    const serviceManager = new ServiceManager(
      db,
      { discoverTools: vi.fn().mockResolvedValue([]), invalidateClient: vi.fn() } as never,
      { discoverOAuth: vi.fn().mockResolvedValue({ hasOAuth: false }) } as never,
      { set: vi.fn(), get: vi.fn(), has: vi.fn(), delete: vi.fn() } as never,
      await makeCredentialManager(writer),
      writer,
      headerVault as never,
    );
    const service = await serviceManager.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
    });

    expect(await serviceManager.deleteService(service.id)).toBe(true);
    expect(headerVault.delete).toHaveBeenCalledWith(service.id);
    expect(await db.getService(service.id)).toBeNull();
    await expect(
      fs.access(path.join(storePaths(home).servicesDir, `${service.id}.json`)),
    ).rejects.toThrow();
  });
});
