import fs from 'node:fs/promises';
import path from 'node:path';
import {
  StoreManifestSchema,
  type StoreCredentialMeta,
  type StoreDeck,
  type StoreManifest,
  type StorePlaybookFile,
  type StoreService,
} from '@agent-deck/shared';
import {
  DatabaseManager,
  STORE_CONTENT_HASH,
} from '../models/database';
import { writeFileAtomic } from './atomic-write';
import { hashStoreTree } from './content-hash';
import { serializeCredentialMeta } from './credential-codec';
import { serializeDeck } from './deck-codec';
import { storePaths } from './paths';
import { serializePlaybook } from './playbook-codec';
import { serializeService } from './service-codec';

const DEFAULT_MANIFEST: StoreManifest = {
  format: 'agent-deck-store',
  version: 1,
};

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return;
    }
    throw error;
  }
}

export class FileStoreWriter {
  constructor(private home?: string) {}

  async ensureLayout(manifest: StoreManifest = DEFAULT_MANIFEST): Promise<void> {
    const paths = storePaths(this.home);
    await Promise.all([
      fs.mkdir(paths.playbooksDir, { recursive: true }),
      fs.mkdir(paths.servicesDir, { recursive: true }),
      fs.mkdir(paths.decksDir, { recursive: true }),
      fs.mkdir(paths.credentialsDir, { recursive: true }),
    ]);

    try {
      await fs.access(paths.manifest);
    } catch (error: unknown) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
      const validated = StoreManifestSchema.parse(manifest);
      await writeFileAtomic(
        paths.manifest,
        `${JSON.stringify(validated, null, 2)}\n`,
      );
    }
  }

  async writePlaybook(playbook: StorePlaybookFile): Promise<void> {
    const { playbooksDir } = storePaths(this.home);
    let serialized: string;
    try {
      serialized = serializePlaybook(playbook);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to serialize playbook ${playbook.id}: ${detail}`);
    }
    await writeFileAtomic(
      path.join(playbooksDir, `${playbook.id}.md`),
      serialized,
    );
  }

  async deletePlaybook(id: string): Promise<void> {
    await unlinkIfExists(path.join(storePaths(this.home).playbooksDir, `${id}.md`));
  }

  async writeService(service: StoreService): Promise<void> {
    const { servicesDir } = storePaths(this.home);
    await writeFileAtomic(
      path.join(servicesDir, `${service.id}.json`),
      serializeService(service),
    );
  }

  async deleteService(id: string): Promise<void> {
    await unlinkIfExists(path.join(storePaths(this.home).servicesDir, `${id}.json`));
  }

  async writeDeck(deck: StoreDeck): Promise<void> {
    const { decksDir } = storePaths(this.home);
    await writeFileAtomic(
      path.join(decksDir, `${deck.id}.json`),
      serializeDeck(deck),
    );
  }

  async deleteDeck(id: string): Promise<void> {
    await unlinkIfExists(path.join(storePaths(this.home).decksDir, `${id}.json`));
  }

  async writeCredential(credential: StoreCredentialMeta): Promise<void> {
    const { credentialsDir } = storePaths(this.home);
    await writeFileAtomic(
      path.join(credentialsDir, `${credential.id}.yaml`),
      serializeCredentialMeta(credential),
    );
  }

  async deleteCredential(id: string): Promise<void> {
    await unlinkIfExists(
      path.join(storePaths(this.home).credentialsDir, `${id}.yaml`),
    );
  }

  async touchHash(database: DatabaseManager): Promise<void> {
    database.setStoreMeta(STORE_CONTENT_HASH, await hashStoreTree(this.home));
  }
}
