import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseManager } from '../models/database';
import { buildExportBundle } from './export-bundle';
import { importBundle } from './import-bundle';

describe('export/import round-trip', () => {
  let sourcePath: string;
  let targetPath: string;
  let source: DatabaseManager;
  let target: DatabaseManager;

  beforeEach(() => {
    sourcePath = path.join(os.tmpdir(), `agent-deck-export-src-${Date.now()}.db`);
    targetPath = path.join(os.tmpdir(), `agent-deck-export-dst-${Date.now()}.db`);
    source = new DatabaseManager(sourcePath);
    target = new DatabaseManager(targetPath);
  });

  afterEach(() => {
    source.close();
    target.close();
    fs.rmSync(sourcePath, { force: true });
    fs.rmSync(targetPath, { force: true });
  });

  it('restores layout with new ids and no credentials', async () => {
    const serviceA = await source.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
      oauthClientId: 'client',
      oauthAuthorizationUrl: 'https://example.com/oauth/authorize',
      oauthTokenUrl: 'https://example.com/oauth/token',
    });
    await source.updateServiceDisabledTools(serviceA.id, ['hidden']);

    const serviceB = await source.createService({
      name: 'Local Tool',
      type: 'local-mcp',
      url: 'local://local-tool',
      localCommand: 'npx',
      localArgs: ['-y', 'demo'],
      localWorkingDir: '/tmp/demo',
      localEnv: { SECRET: 'nope' },
    });

    const playbook = await source.createPlaybook({
      id: 'pb_triage',
      title: 'Triage',
      body: 'Use Linear',
      triggers: ['triage'],
      dependsOnCredentialIds: ['cred_should_not_export'],
      dependsOnServiceIds: [serviceA.id],
    });

    const deck = await source.createDeck({
      name: 'dev',
      operatingInstructions: '# Dev runbook\nPrefer small PRs.\n',
    });
    await source.addServiceToDeck({ deckId: deck.id, serviceId: serviceA.id, position: 0 });
    await source.addServiceToDeck({ deckId: deck.id, serviceId: serviceB.id, position: 1 });
    await source.addPlaybookToDeck({
      deckId: deck.id,
      playbookId: playbook.id,
      position: 0,
    });

    // Credential on source must not appear in bundle or target.
    await source.createCredential({
      id: 'cred_openai',
      label: 'OpenAI',
      scheme: 'bearer',
      envName: 'OPENAI_API_KEY',
      keychainAccount: 'cred_openai',
      tags: [],
      hasSecret: false,
    });
    await source.addCredentialToDeck({
      deckId: deck.id,
      credentialId: 'cred_openai',
      position: 0,
    });

    const bundle = await buildExportBundle(source, { scope: 'collection' }, {
      agentDeckVersion: 'test',
    });

    expect(bundle.version).toBe(2);
    expect(bundle.services).toHaveLength(2);
    expect(bundle.playbooks).toHaveLength(1);
    expect(bundle.decks).toHaveLength(1);
    expect(bundle.decks[0].operatingInstructions).toBe(
      '# Dev runbook\nPrefer small PRs.\n',
    );
    expect(JSON.stringify(bundle)).not.toContain('cred_');
    expect(JSON.stringify(bundle)).not.toContain('SECRET');
    expect(JSON.stringify(bundle)).not.toContain('nope');
    expect(bundle.playbooks[0].dependsOnServiceIds).toEqual([serviceA.id]);
    expect(bundle.services.find((row) => row.name === 'Local Tool')?.localEnv).toBeUndefined();

    const report = await importBundle(target, bundle);
    expect(report.status).toBe('completed');
    expect(report.counts).toEqual({
      services: { created: 2, reused: 0 },
      playbooks: { created: 1, reused: 0 },
      decks: { created: 1, reused: 0 },
    });
    expect(report.servicesNeedingOauth).toEqual(['Linear']);
    expect(report.idMap[serviceA.id]).toBeDefined();
    expect(report.idMap[serviceA.id]).not.toBe(serviceA.id);
    expect(report.idMap[deck.id]).not.toBe(deck.id);

    const targetDecks = await target.getAllDecks();
    expect(targetDecks).toHaveLength(1);
    expect(targetDecks[0].name).toBe('dev');
    expect(targetDecks[0].operatingInstructions).toBe(
      '# Dev runbook\nPrefer small PRs.\n',
    );
    expect(targetDecks[0].services.map((row) => row.name)).toEqual([
      'Linear',
      'Local Tool',
    ]);
    expect(targetDecks[0].playbooks.map((row) => row.title)).toEqual(['Triage']);
    expect(targetDecks[0].credentials).toEqual([]);

    const importedPlaybook = targetDecks[0].playbooks[0];
    expect(importedPlaybook.body).toBe('Use Linear');
    expect(importedPlaybook.dependsOnCredentialIds).toEqual([]);
    expect(importedPlaybook.dependsOnServiceIds).toEqual([report.idMap[serviceA.id]]);

    const importedLinear = targetDecks[0].services[0];
    expect(importedLinear.disabledToolNames).toEqual(['hidden']);
    expect(importedLinear.oauthAccessToken).toBeFalsy();
    expect(importedLinear.oauthClientSecret).toBeFalsy();

    const targetCredentials = await target.getAllCredentials();
    expect(targetCredentials).toHaveLength(0);
  });

  it('accepts a v1 bundle through the public import path with empty instructions', async () => {
    const report = await importBundle(target, {
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
      ],
      playbooks: [
        {
          id: 'pb_triage',
          title: 'Triage',
          body: 'Use Linear',
          triggers: ['triage'],
          dependsOnServiceIds: ['11111111-1111-4111-8111-111111111111'],
        },
      ],
      decks: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: 'dev',
          serviceIds: ['11111111-1111-4111-8111-111111111111'],
          playbookIds: ['pb_triage'],
        },
      ],
    });

    expect(report.status).toBe('completed');
    expect(report.counts).toEqual({
      services: { created: 1, reused: 0 },
      playbooks: { created: 1, reused: 0 },
      decks: { created: 1, reused: 0 },
    });

    const targetDecks = await target.getAllDecks();
    expect(targetDecks).toHaveLength(1);
    expect(targetDecks[0].name).toBe('dev');
    expect(targetDecks[0].operatingInstructions).toBe('');
    expect(targetDecks[0].services.map((row) => row.name)).toEqual(['Linear']);
    expect(targetDecks[0].playbooks.map((row) => row.title)).toEqual(['Triage']);
  });
});
