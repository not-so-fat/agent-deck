import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  Credential,
  Deck,
  Playbook,
  StoreCredentialMeta,
  StoreDeck,
  StoreManifest,
  StorePlaybookFile,
  StoreService,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { storePaths } from './paths';
import { storeServiceFromDb } from './service-codec';
import { FileStoreWriter } from './writer';

export type StoreMigrateResult = {
  wrote: {
    playbooks: number;
    services: number;
    credentials: number;
    decks: number;
  };
  dryRun: boolean;
  paths: string[];
};

type PendingWrite =
  | { kind: 'playbooks'; path: string; value: StorePlaybookFile }
  | { kind: 'services'; path: string; value: StoreService }
  | { kind: 'credentials'; path: string; value: StoreCredentialMeta }
  | { kind: 'decks'; path: string; value: StoreDeck };

const MIGRATED_MANIFEST: StoreManifest = {
  format: 'agent-deck-store',
  version: 1,
  migratedFrom: 'sqlite',
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function storePlaybookFromDb(playbook: Playbook): StorePlaybookFile {
  return {
    id: playbook.id,
    title: playbook.title,
    body: playbook.body,
    triggers: playbook.triggers,
    dependsOnCredentialIds: playbook.dependsOnCredentialIds,
    dependsOnServiceIds: playbook.dependsOnServiceIds,
    ...(playbook.exec !== undefined ? { exec: playbook.exec } : {}),
    ...(playbook.skill !== undefined ? { skill: playbook.skill } : {}),
    createdAt: playbook.createdAt,
    updatedAt: playbook.updatedAt,
  };
}

function storeCredentialFromDb(
  credential: Credential,
): StoreCredentialMeta {
  return {
    id: credential.id,
    label: credential.label,
    scheme: credential.scheme,
    headerName: credential.headerName ?? null,
    envName: credential.envName,
    tags: credential.tags,
    ...(credential.docsUrl !== undefined
      ? { docsUrl: credential.docsUrl }
      : {}),
  };
}

function storeDeckFromDb(deck: Deck): StoreDeck {
  return {
    id: deck.id,
    name: deck.name,
    serviceIds: deck.services.map((service) => service.id),
    credentialIds: deck.credentials.map((credential) => credential.id),
    playbookIds: deck.playbooks.map((playbook) => playbook.id),
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
  };
}

export async function migrateSqliteToStore(
  db: DatabaseManager,
  opts: { home?: string; dryRun?: boolean; force?: boolean } = {},
): Promise<StoreMigrateResult> {
  const paths = storePaths(opts.home);
  const writer = new FileStoreWriter(opts.home);
  const [services, playbooks, credentials, decks] = await Promise.all([
    db.getAllServices(),
    db.getAllPlaybooks(),
    db.getAllCredentials(),
    db.getAllDecks(),
  ]);

  const candidates: PendingWrite[] = [
    ...playbooks.map(
      (playbook): PendingWrite => ({
        kind: 'playbooks',
        path: path.join(paths.playbooksDir, `${playbook.id}.md`),
        value: storePlaybookFromDb(playbook),
      }),
    ),
    ...services.map(
      (service): PendingWrite => ({
        kind: 'services',
        path: path.join(paths.servicesDir, `${service.id}.json`),
        value: storeServiceFromDb(service),
      }),
    ),
    ...credentials.map(
      (credential): PendingWrite => ({
        kind: 'credentials',
        path: path.join(paths.credentialsDir, `${credential.id}.yaml`),
        value: storeCredentialFromDb(credential),
      }),
    ),
    ...decks.map(
      (deck): PendingWrite => ({
        kind: 'decks',
        path: path.join(paths.decksDir, `${deck.id}.json`),
        value: storeDeckFromDb(deck),
      }),
    ),
  ];
  const manifestMissing = !(await fileExists(paths.manifest));
  const toWrite = opts.force
    ? candidates
    : (
        await Promise.all(
          candidates.map(async (candidate) => ({
            candidate,
            exists: await fileExists(candidate.path),
          })),
        )
      )
        .filter(({ exists }) => !exists)
        .map(({ candidate }) => candidate);

  const wrote = {
    playbooks: toWrite.filter(({ kind }) => kind === 'playbooks').length,
    services: toWrite.filter(({ kind }) => kind === 'services').length,
    credentials: toWrite.filter(({ kind }) => kind === 'credentials').length,
    decks: toWrite.filter(({ kind }) => kind === 'decks').length,
  };
  const writtenPaths = [
    ...(manifestMissing || opts.force ? [paths.manifest] : []),
    ...toWrite.map((entry) => entry.path),
  ];

  if (!opts.dryRun) {
    await writer.ensureLayout(MIGRATED_MANIFEST);
    for (const entry of toWrite) {
      switch (entry.kind) {
        case 'playbooks':
          await writer.writePlaybook(entry.value);
          break;
        case 'services':
          await writer.writeService(entry.value);
          break;
        case 'credentials':
          await writer.writeCredential(entry.value);
          break;
        case 'decks':
          await writer.writeDeck(entry.value);
          break;
      }
    }
    await writer.touchHash(db);
  }

  return {
    wrote,
    dryRun: opts.dryRun ?? false,
    paths: writtenPaths,
  };
}
