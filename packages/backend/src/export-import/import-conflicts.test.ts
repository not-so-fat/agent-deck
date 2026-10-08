import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../models/database';
import { importBundle } from './import-bundle';

describe('import unique-name skip', () => {
  let dbPath: string;
  let db: DatabaseManager;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `agent-deck-import-conflict-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('skips service and playbook when display name already exists', async () => {
    const existingService = await db.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
    });
    const existingPlaybook = await db.createPlaybook({
      id: 'pb_triage',
      title: 'Triage',
      body: 'existing body must stay',
      triggers: [],
      dependsOnCredentialIds: [],
      dependsOnServiceIds: [existingService.id],
    });

    const report = await importBundle(db, {
      format: 'agent-deck-bundle',
      version: 1,
      exportedAt: '2026-07-03T00:00:00.000Z',
      exportedFrom: { agentDeckVersion: 'test' },
      scope: 'deck',
      services: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Linear',
          type: 'mcp',
          url: 'https://mcp.linear.app/other',
        },
      ],
      playbooks: [
        {
          id: 'pb_triage',
          title: 'Triage',
          body: 'imported body must not overwrite',
          triggers: ['triage'],
          dependsOnServiceIds: ['11111111-1111-4111-8111-111111111111'],
        },
      ],
      decks: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'shared',
          serviceIds: ['11111111-1111-4111-8111-111111111111'],
          playbookIds: ['pb_triage'],
        },
      ],
    });

    expect(report.status).toBe('completed');
    expect(report.counts).toEqual({
      services: { created: 0, reused: 1 },
      playbooks: { created: 0, reused: 1 },
      decks: { created: 1, reused: 0 },
    });
    expect(report.idMap['11111111-1111-4111-8111-111111111111']).toBe(
      existingService.id,
    );
    expect(report.idMap.pb_triage).toBe(existingPlaybook.id);
    expect(report.warnings.some((row) => row.includes('Skipped service'))).toBe(
      true,
    );
    expect(report.warnings.some((row) => row.includes('Skipped playbook'))).toBe(
      true,
    );

    expect(await db.getAllServices()).toHaveLength(1);
    const playbooks = await db.getAllPlaybooks();
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0].body).toBe('existing body must stay');
    expect(playbooks[0].dependsOnServiceIds).toEqual([existingService.id]);
  });

  it('skips deck when name exists and still links membership', async () => {
    const existingDeck = await db.createDeck({
      name: 'dev',
      isActive: false,
      credentials: [],
      playbooks: [],
    });
    const service = await db.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
    });

    const report = await importBundle(db, {
      format: 'agent-deck-bundle',
      version: 1,
      exportedAt: '2026-07-03T00:00:00.000Z',
      exportedFrom: { agentDeckVersion: 'test' },
      scope: 'deck',
      services: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Linear',
          type: 'mcp',
          url: 'https://mcp.linear.app/mcp',
        },
      ],
      playbooks: [],
      decks: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'dev',
          serviceIds: ['11111111-1111-4111-8111-111111111111'],
          playbookIds: [],
        },
      ],
    });

    expect(report.counts.decks).toEqual({ created: 0, reused: 1 });
    expect(report.counts.services).toEqual({ created: 0, reused: 1 });
    expect(report.idMap['22222222-2222-4222-8222-222222222222']).toBe(
      existingDeck.id,
    );
    expect(report.warnings.some((row) => row.includes('Skipped deck'))).toBe(true);

    const decks = await db.getAllDecks();
    expect(decks).toHaveLength(1);
    expect(decks[0].services.map((row) => row.id)).toEqual([service.id]);
  });

  it('keeps existing deck instructions on reuse and warns when incoming differ', async () => {
    const existingDeck = await db.createDeck({
      name: 'dev',
      isActive: false,
      operatingInstructions: 'Existing runbook\n',
      credentials: [],
      playbooks: [],
    });

    const report = await importBundle(db, {
      format: 'agent-deck-bundle',
      version: 2,
      exportedAt: '2026-07-03T00:00:00.000Z',
      exportedFrom: { agentDeckVersion: 'test' },
      scope: 'deck',
      services: [],
      playbooks: [],
      decks: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'dev',
          operatingInstructions: 'Incoming runbook\n',
          serviceIds: [],
          playbookIds: [],
        },
      ],
    });

    expect(report.counts.decks).toEqual({ created: 0, reused: 1 });
    expect(report.idMap['22222222-2222-4222-8222-222222222222']).toBe(
      existingDeck.id,
    );
    expect(report.warnings.some((row) => row.includes('Skipped deck'))).toBe(
      true,
    );
    const instructionWarning = report.warnings.find((row) =>
      row.includes('operating instructions'),
    );
    expect(instructionWarning).toBeDefined();
    expect(instructionWarning).toContain('"dev"');

    const decks = await db.getAllDecks();
    expect(decks).toHaveLength(1);
    expect(decks[0].operatingInstructions).toBe('Existing runbook\n');
  });

  it('stays silent on reuse when incoming instructions match or are empty', async () => {
    await db.createDeck({
      name: 'same',
      isActive: false,
      operatingInstructions: 'Shared runbook\n',
      credentials: [],
      playbooks: [],
    });
    await db.createDeck({
      name: 'empty-incoming',
      isActive: false,
      operatingInstructions: 'Keep me\n',
      credentials: [],
      playbooks: [],
    });

    const report = await importBundle(db, {
      format: 'agent-deck-bundle',
      version: 2,
      exportedAt: '2026-07-03T00:00:00.000Z',
      exportedFrom: { agentDeckVersion: 'test' },
      scope: 'collection',
      services: [],
      playbooks: [],
      decks: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'same',
          operatingInstructions: 'Shared runbook\n',
          serviceIds: [],
          playbookIds: [],
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: 'empty-incoming',
          operatingInstructions: '',
          serviceIds: [],
          playbookIds: [],
        },
      ],
    });

    expect(report.counts.decks).toEqual({ created: 0, reused: 2 });
    expect(
      report.warnings.some((row) => row.includes('operating instructions')),
    ).toBe(false);

    const decks = await db.getAllDecks();
    expect(
      decks.find((row) => row.name === 'same')?.operatingInstructions,
    ).toBe('Shared runbook\n');
    expect(
      decks.find((row) => row.name === 'empty-incoming')?.operatingInstructions,
    ).toBe('Keep me\n');
  });

  it('skips duplicate service ids in one bundle', async () => {
    const report = await importBundle(db, {
      format: 'agent-deck-bundle',
      version: 1,
      exportedAt: '2026-07-03T00:00:00.000Z',
      exportedFrom: { agentDeckVersion: 'test' },
      scope: 'collection',
      services: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Linear',
          type: 'mcp',
          url: 'https://mcp.linear.app/mcp',
        },
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'Linear Dup',
          type: 'mcp',
          url: 'https://mcp.linear.app/mcp',
        },
      ],
      playbooks: [],
      decks: [],
    });

    expect(report.counts.services).toEqual({ created: 1, reused: 0 });
    expect(report.warnings.some((row) => row.includes('duplicate service id'))).toBe(
      true,
    );
    expect(await db.getAllServices()).toHaveLength(1);
  });
});
