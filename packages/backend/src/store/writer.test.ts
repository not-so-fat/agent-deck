import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StoreManifestSchema } from '@agent-deck/shared';
import { DatabaseManager, STORE_CONTENT_HASH } from '../models/database';
import { hashStoreTree } from './content-hash';
import { parseCredentialYaml } from './credential-codec';
import { parseDeckJson } from './deck-codec';
import { parsePlaybookMarkdown } from './playbook-codec';
import { parseServiceJson } from './service-codec';
import { storePaths } from './paths';
import { FileStoreWriter } from './writer';

const createdHomes: string[] = [];

async function createHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-writer-'));
  createdHomes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(createdHomes.splice(0).map((home) => fs.rm(home, { recursive: true })));
});

describe('store metadata', () => {
  const databases: DatabaseManager[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
  });

  it('stores and replaces metadata values', () => {
    const database = new DatabaseManager(':memory:');
    databases.push(database);

    expect(database.getStoreMeta(STORE_CONTENT_HASH)).toBeNull();
    database.setStoreMeta(STORE_CONTENT_HASH, 'first');
    database.setStoreMeta(STORE_CONTENT_HASH, 'second');

    expect(database.getStoreMeta(STORE_CONTENT_HASH)).toBe('second');
  });
});

describe('FileStoreWriter', () => {
  const playbook = {
    id: 'pb_demo',
    title: 'Demo',
    body: 'Run the demo.\n',
    triggers: ['demo'],
    dependsOnCredentialIds: ['cred_demo'],
    dependsOnServiceIds: ['svc_demo'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const service = {
    id: 'svc_demo',
    name: 'Demo service',
    type: 'mcp' as const,
    url: 'https://example.com/mcp',
    disabledToolNames: [],
  };
  const deck = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Demo deck',
    serviceIds: [service.id],
    credentialIds: ['cred_demo'],
    playbookIds: [playbook.id],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
  const credential = {
    id: 'cred_demo',
    label: 'Demo key',
    scheme: 'bearer' as const,
    headerName: null,
    envName: 'DEMO_API_KEY',
    tags: ['demo'],
  };

  it('creates the layout and writes parseable store files', async () => {
    const home = await createHome();
    const writer = new FileStoreWriter(home);
    const paths = storePaths(home);

    await writer.ensureLayout();
    await writer.writePlaybook(playbook);
    await writer.writeService(service);
    await writer.writeDeck(deck);
    await writer.writeCredential(credential);

    const manifest = StoreManifestSchema.parse(
      JSON.parse(await fs.readFile(paths.manifest, 'utf8')),
    );
    expect(manifest).toEqual({ format: 'agent-deck-store', version: 1 });
    expect(
      parsePlaybookMarkdown(
        await fs.readFile(path.join(paths.playbooksDir, 'pb_demo.md'), 'utf8'),
      ),
    ).toEqual(playbook);
    expect(
      parseServiceJson(
        await fs.readFile(path.join(paths.servicesDir, 'svc_demo.json'), 'utf8'),
      ),
    ).toEqual(service);
    expect(
      parseDeckJson(
        await fs.readFile(path.join(paths.decksDir, `${deck.id}.json`), 'utf8'),
      ),
    ).toEqual(deck);
    expect(
      parseCredentialYaml(
        await fs.readFile(path.join(paths.credentialsDir, 'cred_demo.yaml'), 'utf8'),
      ),
    ).toEqual(credential);
  });

  it('deletes store files and ignores missing files', async () => {
    const home = await createHome();
    const writer = new FileStoreWriter(home);
    const paths = storePaths(home);
    await writer.writePlaybook(playbook);
    await writer.writeService(service);
    await writer.writeDeck(deck);
    await writer.writeCredential(credential);

    await writer.deletePlaybook(playbook.id);
    await writer.deleteService(service.id);
    await writer.deleteDeck(deck.id);
    await writer.deleteCredential(credential.id);

    await expect(fs.access(path.join(paths.playbooksDir, 'pb_demo.md'))).rejects.toThrow();
    await expect(fs.access(path.join(paths.servicesDir, 'svc_demo.json'))).rejects.toThrow();
    await expect(fs.access(path.join(paths.decksDir, `${deck.id}.json`))).rejects.toThrow();
    await expect(fs.access(path.join(paths.credentialsDir, 'cred_demo.yaml'))).rejects.toThrow();
    await expect(writer.deletePlaybook(playbook.id)).resolves.toBeUndefined();
    await expect(writer.deleteService(service.id)).resolves.toBeUndefined();
    await expect(writer.deleteDeck(deck.id)).resolves.toBeUndefined();
    await expect(writer.deleteCredential(credential.id)).resolves.toBeUndefined();
  });

  it('records the current content hash in SQLite', async () => {
    const home = await createHome();
    const writer = new FileStoreWriter(home);
    const database = new DatabaseManager(':memory:');

    await writer.ensureLayout();
    await writer.writePlaybook(playbook);
    await writer.touchHash(database);

    expect(database.getStoreMeta(STORE_CONTENT_HASH)).toBe(await hashStoreTree(home));
    database.close();
  });
});
