import {
  BundleV2,
  BundleV2Schema,
  ExportRequest,
  ExportRequestSchema,
  type BundlePlaybook,
  type BundleService,
} from '@agent-deck/shared';
import type { DatabaseManager } from '../models/database';
import { getAgentDeckVersion } from '../lib/version';
import { sanitizeServiceForExport } from './sanitize-for-export';

export class ExportBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportBundleError';
  }
}

function toBundlePlaybook(
  playbook: {
    id: string;
    title: string;
    body: string;
    triggers: string[];
    dependsOnServiceIds: string[];
    exec?: string;
    skill?: string;
  },
  allowedServiceIds: Set<string>,
): BundlePlaybook {
  return {
    id: playbook.id,
    title: playbook.title,
    body: playbook.body,
    triggers: playbook.triggers,
    dependsOnServiceIds: playbook.dependsOnServiceIds.filter((id) =>
      allowedServiceIds.has(id),
    ),
    ...(playbook.exec ? { exec: playbook.exec } : {}),
    ...(playbook.skill ? { skill: playbook.skill } : {}),
  };
}

export async function buildExportBundle(
  db: DatabaseManager,
  request: ExportRequest,
  options?: { agentDeckVersion?: string },
): Promise<BundleV2> {
  const input = ExportRequestSchema.parse(request);
  const agentDeckVersion = options?.agentDeckVersion ?? getAgentDeckVersion();

  let services: BundleService[] = [];
  let playbooks: BundlePlaybook[] = [];
  let decks: BundleV2['decks'] = [];

  if (input.scope === 'collection') {
    const allServices = await db.getAllServices();
    services = allServices.map(sanitizeServiceForExport);
    const allowedServiceIds = new Set(services.map((service) => service.id));

    const allPlaybooks = await db.getAllPlaybooks();
    playbooks = allPlaybooks.map((playbook) =>
      toBundlePlaybook(playbook, allowedServiceIds),
    );

    const allDecks = await db.getAllDecks();
    decks = allDecks.map((deck) => ({
      id: deck.id,
      name: deck.name,
      operatingInstructions: deck.operatingInstructions ?? '',
      serviceIds: (deck.services ?? []).map((service) => service.id),
      playbookIds: (deck.playbooks ?? []).map((playbook) => playbook.id),
    }));
  } else {
    const deck = await db.getDeck(input.deckId!);
    if (!deck) {
      throw new ExportBundleError(`Deck not found: ${input.deckId}`);
    }

    const deckServices = deck.services ?? [];
    services = deckServices.map(sanitizeServiceForExport);
    const allowedServiceIds = new Set(services.map((service) => service.id));

    const deckPlaybooks = deck.playbooks ?? [];
    playbooks = deckPlaybooks.map((playbook) =>
      toBundlePlaybook(playbook, allowedServiceIds),
    );

    decks = [
      {
        id: deck.id,
        name: deck.name,
        operatingInstructions: deck.operatingInstructions ?? '',
        serviceIds: deckServices.map((service) => service.id),
        playbookIds: deckPlaybooks.map((playbook) => playbook.id),
      },
    ];
  }

  return BundleV2Schema.parse({
    format: 'agent-deck-bundle',
    version: 2,
    exportedAt: new Date().toISOString(),
    exportedFrom: { agentDeckVersion },
    scope: input.scope,
    services,
    playbooks,
    decks,
  });
}
