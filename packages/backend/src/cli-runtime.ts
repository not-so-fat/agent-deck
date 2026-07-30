import fs from 'node:fs/promises';
import path from 'node:path';
import type { BundleV1, ExportRequest, ImportReport } from '@agent-deck/shared';
import { DatabaseManager } from './models/database';
import { resolveDatabasePath } from './lib/paths';
import { createSecretStore, CredentialManager } from './vault';
import { PlaybookDependencyError, PlaybookManager } from './playbooks/playbook-manager';
import {
  buildExportBundle,
  ExportBundleError,
  importBundle,
  ImportBundleError,
  parseBundleJson,
} from './export-import';
import { migrateSqliteToStore, reindexStoreToSqlite } from './store';
import { FileStoreWriter } from './store/writer';

/** Shared credential manager for the agent-deck CLI (vault + exec). */
export function createCliCredentialManager(): CredentialManager {
  const db = new DatabaseManager(resolveDatabasePath());
  const storeWriter = new FileStoreWriter();
  return new CredentialManager(db, createSecretStore(), undefined, storeWriter);
}

/**
 * Rare collection/deck ops for the CLI (not MCP).
 * Delete service/playbook/deck — same dependency checks as the dashboard API.
 */
export function createCliCollectionAdmin() {
  const db = new DatabaseManager(resolveDatabasePath());
  const storeWriter = new FileStoreWriter();
  const playbooks = new PlaybookManager(db, storeWriter);

  return {
    async deleteService(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
      const service = await db.getService(id);
      if (!service) {
        return { ok: false, error: `Service not found: ${id}` };
      }

      const dependents = await db.getPlaybooksDependingOnService(id);
      if (dependents.length > 0) {
        const titles = dependents.map((playbook) => playbook.title).join(', ');
        return {
          ok: false,
          error: `Cannot delete MCP "${service.name}": referenced by playbook(s): ${titles}`,
        };
      }

      const deleted = await db.deleteService(id);
      if (!deleted) {
        return { ok: false, error: `Service not found: ${id}` };
      }
      await storeWriter.deleteService(id);
      return { ok: true };
    },

    async deletePlaybook(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
      const deleted = await playbooks.delete(id);
      if (!deleted) {
        return { ok: false, error: `Playbook not found: ${id}` };
      }
      return { ok: true };
    },

    async deleteDeck(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
      const deck = await db.getDeck(id);
      if (!deck) {
        return { ok: false, error: `Deck not found: ${id}` };
      }
      const deleted = await db.deleteDeck(id);
      if (!deleted) {
        return { ok: false, error: `Deck not found: ${id}` };
      }
      await storeWriter.deleteDeck(id);
      return { ok: true };
    },

    async listServices(): Promise<Array<{ id: string; name: string; type: string }>> {
      const services = await db.getAllServices();
      return services.map((service) => ({
        id: service.id,
        name: service.name,
        type: service.type,
      }));
    },

    async listPlaybooks(): Promise<Array<{ id: string; title: string }>> {
      const items = await playbooks.list();
      return items.map((playbook) => ({ id: playbook.id, title: playbook.title }));
    },

    async listDecks(): Promise<Array<{ id: string; name: string }>> {
      const decks = await db.getAllDecks();
      return decks.map((deck) => ({ id: deck.id, name: deck.name }));
    },

    async resolveDeck(ref: string): Promise<{ id: string; name: string } | null> {
      const trimmed = ref.trim();
      if (!trimmed) {
        return null;
      }
      const byId = await db.getDeck(trimmed);
      if (byId) {
        return { id: byId.id, name: byId.name };
      }
      const decks = await db.getAllDecks();
      const lower = trimmed.toLowerCase();
      const byName = decks.filter((deck) => deck.name.toLowerCase() === lower);
      if (byName.length === 1) {
        return { id: byName[0].id, name: byName[0].name };
      }
      return null;
    },

    async listDeckPlaybookStubs(
      deckId: string,
    ): Promise<Array<{ id: string; title: string; triggers: string[] }>> {
      return playbooks.listSummariesForDeck(deckId);
    },
  };
}

export type CliCollectionAdmin = ReturnType<typeof createCliCollectionAdmin>;

/**
 * Export / import layouts (MCP + playbooks + decks). No credentials or secrets.
 */
export function createCliExportImport() {
  const db = new DatabaseManager(resolveDatabasePath());

  return {
    async exportToFile(
      outputPath: string,
      request: ExportRequest,
    ): Promise<{ ok: true; bundle: BundleV1 } | { ok: false; error: string }> {
      try {
        const bundle = await buildExportBundle(db, request);
        const resolved = path.resolve(outputPath);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
        return { ok: true, bundle };
      } catch (error) {
        const message =
          error instanceof ExportBundleError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        return { ok: false, error: message };
      }
    },

    async importFromFile(
      inputPath: string,
    ): Promise<{ ok: true; report: ImportReport } | { ok: false; error: string }> {
      try {
        const text = await fs.readFile(path.resolve(inputPath), 'utf8');
        const raw = parseBundleJson(text);
        const report = await importBundle(db, raw);
        if (report.status === 'failed') {
          return { ok: false, error: report.warnings.join('; ') || 'Import failed' };
        }
        // Overwrite store files so reindex cannot wipe imported cards.
        await migrateSqliteToStore(db, { force: true });
        return { ok: true, report };
      } catch (error) {
        const message =
          error instanceof ImportBundleError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        return { ok: false, error: message };
      }
    },
  };
}

export type CliExportImport = ReturnType<typeof createCliExportImport>;

/** File-backed store operations for the CLI. */
export function createCliStore() {
  const db = new DatabaseManager(resolveDatabasePath());

  return {
    migrate(opts: { dryRun?: boolean; force?: boolean } = {}) {
      return migrateSqliteToStore(db, opts);
    },
    reindex() {
      return reindexStoreToSqlite(db, { force: true });
    },
  };
}

export type CliStore = ReturnType<typeof createCliStore>;

export { PlaybookDependencyError, ExportBundleError, ImportBundleError };

export {
  syncPlaybookStubs,
  readUseManifest,
  writeUseManifest,
  healUseManifest,
  type StubSyncResult,
  type PlaybookStubInput,
} from './playbooks/stub-sync';
