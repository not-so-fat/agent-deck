import {
  BundleV1,
  BundleV1Schema,
  ImportReport,
  ImportReportSchema,
  type BundlePlaybook,
  type BundleService,
} from '@agent-deck/shared';
import type { DatabaseManager } from '../models/database';
import { migrateSqliteToStore } from '../store/migrate';
import { serviceNeedsOauthReconnect } from './sanitize-for-export';

export class ImportBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportBundleError';
  }
}

type ResolveResult = {
  targetId: string;
  created: boolean;
};

function isUniqueConstraintError(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    code.includes('CONSTRAINT') ||
    message.includes('UNIQUE constraint failed') ||
    message.includes('already exists')
  );
}

function remapServiceDeps(
  playbookTitle: string,
  dependsOnServiceIds: string[],
  serviceIdMap: Record<string, string>,
  warnings: string[],
): string[] {
  const resolved: string[] = [];
  for (const bundleServiceId of dependsOnServiceIds) {
    const mapped = serviceIdMap[bundleServiceId];
    if (mapped) {
      resolved.push(mapped);
    } else {
      warnings.push(
        `Playbook "${playbookTitle}": dropped missing service dependency ${bundleServiceId}`,
      );
    }
  }
  return resolved;
}

async function resolveService(
  db: DatabaseManager,
  service: BundleService,
  warnings: string[],
  servicesNeedingOauth: string[],
): Promise<ResolveResult> {
  try {
    const created = await db.createService({
      name: service.name,
      type: service.type,
      url: service.url,
      cardColor: service.cardColor ?? '#92E4DD',
      ...(service.description ? { description: service.description } : {}),
      ...(service.iconUrl ? { iconUrl: service.iconUrl } : {}),
      ...(service.headers ? { headers: service.headers } : {}),
      ...(service.oauthClientId ? { oauthClientId: service.oauthClientId } : {}),
      ...(service.oauthAuthorizationUrl
        ? { oauthAuthorizationUrl: service.oauthAuthorizationUrl }
        : {}),
      ...(service.oauthTokenUrl ? { oauthTokenUrl: service.oauthTokenUrl } : {}),
      ...(service.oauthRedirectUri
        ? { oauthRedirectUri: service.oauthRedirectUri }
        : {}),
      ...(service.oauthScope ? { oauthScope: service.oauthScope } : {}),
      ...(service.localCommand ? { localCommand: service.localCommand } : {}),
      ...(service.localArgs ? { localArgs: service.localArgs } : {}),
      ...(service.localWorkingDir
        ? { localWorkingDir: service.localWorkingDir }
        : {}),
    });

    if (service.disabledToolNames && service.disabledToolNames.length > 0) {
      await db.updateServiceDisabledTools(created.id, service.disabledToolNames);
    }
    if (serviceNeedsOauthReconnect(service)) {
      servicesNeedingOauth.push(service.name);
    }
    return { targetId: created.id, created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const existing = (await db.getAllServices()).find(
      (row) => row.name === service.name,
    );
    if (!existing) {
      throw error;
    }
    warnings.push(`Skipped service "${service.name}" (already exists)`);
    return { targetId: existing.id, created: false };
  }
}

async function resolvePlaybook(
  db: DatabaseManager,
  playbook: BundlePlaybook,
  serviceIdMap: Record<string, string>,
  warnings: string[],
): Promise<ResolveResult> {
  try {
    const dependsOnServiceIds = remapServiceDeps(
      playbook.title,
      playbook.dependsOnServiceIds,
      serviceIdMap,
      warnings,
    );
    const created = await db.createPlaybook({
      id: playbook.id,
      title: playbook.title,
      body: playbook.body,
      triggers: playbook.triggers,
      dependsOnCredentialIds: [],
      dependsOnServiceIds,
      exec: playbook.exec,
      skill: playbook.skill,
    });
    return { targetId: created.id, created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const byId = await db.getPlaybook(playbook.id);
    const byTitle =
      byId ??
      (await db.getAllPlaybooks()).find((row) => row.title === playbook.title);
    if (!byTitle) {
      throw error;
    }
    warnings.push(
      `Skipped playbook "${playbook.title}" (${playbook.id}) (already exists)`,
    );
    return { targetId: byTitle.id, created: false };
  }
}

async function resolveDeck(
  db: DatabaseManager,
  name: string,
  warnings: string[],
): Promise<ResolveResult> {
  try {
    const created = await db.createDeck({
      name,
      isActive: false,
      credentials: [],
      playbooks: [],
    });
    return { targetId: created.id, created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    const existing = (await db.getAllDecks()).find((row) => row.name === name);
    if (!existing) {
      throw error;
    }
    warnings.push(`Skipped deck "${name}" (already exists)`);
    return { targetId: existing.id, created: false };
  }
}

async function linkService(
  db: DatabaseManager,
  deckId: string,
  serviceId: string,
  position: number,
): Promise<boolean> {
  const existing = await db.getDeckServices(deckId);
  if (existing.some((row) => row.serviceId === serviceId)) {
    return false;
  }
  await db.addServiceToDeck({ deckId, serviceId, position });
  return true;
}

async function linkPlaybook(
  db: DatabaseManager,
  deckId: string,
  playbookId: string,
  position: number,
): Promise<boolean> {
  const existing = await db.getDeckPlaybooks(deckId);
  if (existing.some((row) => row.playbookId === playbookId)) {
    return false;
  }
  await db.addPlaybookToDeck({ deckId, playbookId, position });
  return true;
}

export type ImportBundleOptions = {
  /**
   * Flush the imported rows to the file store (cards *and* deck membership).
   * Import writes straight to SQLite, so without this the whole bundle is lost
   * on the next reindex. Off by default so callers without a store — tests,
   * dry runs — never touch the file tree.
   */
  syncStore?: boolean;
  /** Store root override; defaults to the resolved Agent Deck home. */
  storeHome?: string;
};

export async function importBundle(
  db: DatabaseManager,
  raw: unknown,
  options: ImportBundleOptions = {},
): Promise<ImportReport> {
  const parsed = BundleV1Schema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'bundle'}: ${issue.message}`)
      .join('; ');
    throw new ImportBundleError(`Invalid bundle: ${message}`);
  }

  const bundle: BundleV1 = parsed.data;
  const warnings: string[] = [];
  const servicesNeedingOauth: string[] = [];
  const idMap: Record<string, string> = {};
  const counts = {
    services: { created: 0, reused: 0 },
    playbooks: { created: 0, reused: 0 },
    decks: { created: 0, reused: 0 },
  };
  let report: ImportReport;

  try {
    const seenBundleServiceIds = new Set<string>();
    for (const service of bundle.services) {
      if (seenBundleServiceIds.has(service.id)) {
        warnings.push(`Skipped duplicate service id in bundle: ${service.id}`);
        continue;
      }
      seenBundleServiceIds.add(service.id);

      const resolved = await resolveService(
        db,
        service,
        warnings,
        servicesNeedingOauth,
      );
      idMap[service.id] = resolved.targetId;
      if (resolved.created) {
        counts.services.created += 1;
      } else {
        counts.services.reused += 1;
      }
    }

    const seenBundlePlaybookIds = new Set<string>();
    for (const playbook of bundle.playbooks) {
      if (seenBundlePlaybookIds.has(playbook.id)) {
        warnings.push(`Skipped duplicate playbook id in bundle: ${playbook.id}`);
        continue;
      }
      seenBundlePlaybookIds.add(playbook.id);

      const resolved = await resolvePlaybook(db, playbook, idMap, warnings);
      idMap[playbook.id] = resolved.targetId;
      if (resolved.created) {
        counts.playbooks.created += 1;
      } else {
        counts.playbooks.reused += 1;
      }
    }

    for (const deck of bundle.decks) {
      const resolved = await resolveDeck(db, deck.name, warnings);
      idMap[deck.id] = resolved.targetId;
      if (resolved.created) {
        counts.decks.created += 1;
      } else {
        counts.decks.reused += 1;
      }

      const deckId = resolved.targetId;
      const existingServices = await db.getDeckServices(deckId);
      let position = existingServices.length;

      for (const bundleServiceId of deck.serviceIds) {
        const serviceId = idMap[bundleServiceId];
        if (!serviceId) {
          warnings.push(
            `Deck "${deck.name}": skipped unknown service ${bundleServiceId}`,
          );
          continue;
        }
        const linked = await linkService(db, deckId, serviceId, position);
        if (linked) {
          position += 1;
        }
      }

      const existingPlaybooks = await db.getDeckPlaybooks(deckId);
      position = existingPlaybooks.length;
      for (const bundlePlaybookId of deck.playbookIds) {
        const playbookId = idMap[bundlePlaybookId];
        if (!playbookId) {
          warnings.push(
            `Deck "${deck.name}": skipped unknown playbook ${bundlePlaybookId}`,
          );
          continue;
        }
        const linked = await linkPlaybook(db, deckId, playbookId, position);
        if (linked) {
          position += 1;
        }
      }
    }

    report = ImportReportSchema.parse({
      status: 'completed',
      counts,
      servicesNeedingOauth,
      warnings,
      idMap,
    });
  } catch (error) {
    if (error instanceof ImportBundleError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    report = ImportReportSchema.parse({
      status: 'failed',
      counts,
      servicesNeedingOauth,
      warnings: [...warnings, message],
      idMap,
    });
  }

  // Outside the catch on purpose: a store write that fails must surface as an
  // error, not as a "failed" report for rows that did land in SQLite.
  if (options.syncStore && report.status !== 'failed') {
    await migrateSqliteToStore(db, { home: options.storeHome, force: true });
  }

  return report;
}

export function parseBundleJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ImportBundleError('Bundle is not valid JSON');
  }
}
