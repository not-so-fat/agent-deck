import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_DECK_AGENT_CLIENT,
  AGENT_DECK_CLIENT_HEADER,
  AGENT_DECK_DASHBOARD_CLIENT,
  OPERATING_INSTRUCTIONS_MAX_LENGTH,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { registerExportImportRoutes } from './export-import';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { TrustedSessionStore } from '../trusted-session/store';

const agentHeaders = {
  [AGENT_DECK_CLIENT_HEADER]: AGENT_DECK_AGENT_CLIENT,
};

describe('export-import routes', () => {
  let dbPath: string;
  let db: DatabaseManager;
  let app: ReturnType<typeof Fastify>;
  let dashboardHeaders: Record<string, string>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agent-deck-export-routes-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
    app = Fastify();
    app.decorate('db', db);
    const trustedSessionStore = new TrustedSessionStore(db.getSqliteDatabase());
    app.decorate('trustedSessionStore', trustedSessionStore);
    dashboardHeaders = dashboardAuthHeaders(trustedSessionStore);
    await app.register(registerExportImportRoutes, { prefix: '/api' });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('rejects agent clients', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/export',
      headers: agentHeaders,
      payload: { scope: 'collection' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('exports collection and imports for dashboard clients', async () => {
    const service = await db.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer sekrit', 'X-Custom': 'ok' },
      oauthClientSecret: 'sekrit-client',
      oauthAccessToken: 'sekrit-access',
      localEnv: { API_KEY: 'sekrit-env' },
    });
    const deck = await db.createDeck({
      name: 'dev',
      isActive: false,
      operatingInstructions: '# Dev runbook\nPrefer small PRs.\n',
      credentials: [],
      playbooks: [],
    });
    await db.addServiceToDeck({ deckId: deck.id, serviceId: service.id });

    const exported = await app.inject({
      method: 'POST',
      url: '/api/export',
      headers: dashboardHeaders,
      payload: { scope: 'collection' },
    });
    expect(exported.statusCode).toBe(200);
    const bundle = exported.json().data;
    expect(bundle.version).toBe(2);
    expect(bundle.services).toHaveLength(1);
    expect(bundle.decks).toHaveLength(1);
    expect(bundle.decks[0].operatingInstructions).toBe(
      '# Dev runbook\nPrefer small PRs.\n',
    );
    expect(bundle.services[0]).not.toHaveProperty('oauthClientSecret');
    expect(bundle.services[0]).not.toHaveProperty('oauthAccessToken');
    expect(bundle.services[0]).not.toHaveProperty('localEnv');
    expect(bundle.services[0]).not.toHaveProperty('credentialId');
    expect(bundle.services[0].headers ?? {}).not.toHaveProperty('Authorization');
    expect(JSON.stringify(bundle)).not.toContain('sekrit');

    const imported = await app.inject({
      method: 'POST',
      url: '/api/import',
      headers: dashboardHeaders,
      payload: bundle,
    });
    expect(imported.statusCode).toBe(200);
    const report = imported.json().data;
    expect(report.counts.services).toEqual({ created: 0, reused: 1 });
    expect(report.counts.decks).toEqual({ created: 0, reused: 1 });
  });

  it('exports a single deck unit', async () => {
    const linked = await db.createService({
      name: 'Linked',
      type: 'mcp',
      url: 'https://example.com/linked',
    });
    await db.createService({
      name: 'Unlinked',
      type: 'mcp',
      url: 'https://example.com/unlinked',
    });
    const deck = await db.createDeck({
      name: 'focus',
      isActive: false,
      operatingInstructions: 'Focus runbook\n',
      credentials: [],
      playbooks: [],
    });
    await db.addServiceToDeck({ deckId: deck.id, serviceId: linked.id });

    const response = await app.inject({
      method: 'POST',
      url: '/api/export',
      headers: dashboardHeaders,
      payload: { scope: 'deck', deckId: deck.id },
    });
    expect(response.statusCode).toBe(200);
    const bundle = response.json().data;
    expect(bundle.scope).toBe('deck');
    expect(bundle.version).toBe(2);
    expect(bundle.services.map((row: { name: string }) => row.name)).toEqual([
      'Linked',
    ]);
    expect(bundle.decks[0].operatingInstructions).toBe('Focus runbook\n');
  });

  it('returns 404 for missing deck', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/export',
      headers: dashboardHeaders,
      payload: {
        scope: 'deck',
        deckId: '22222222-2222-4222-8222-222222222222',
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects over-limit v2 instructions before any import mutation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/import',
      headers: dashboardHeaders,
      payload: {
        format: 'agent-deck-bundle',
        version: 2,
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
        playbooks: [],
        decks: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'dev',
            operatingInstructions: 'x'.repeat(
              OPERATING_INSTRUCTIONS_MAX_LENGTH + 1,
            ),
            serviceIds: ['11111111-1111-4111-8111-111111111111'],
            playbookIds: [],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('operatingInstructions');
    expect(await db.getAllServices()).toHaveLength(0);
    expect(await db.getAllDecks()).toHaveLength(0);
  });

  it('rejects malformed v2 deck records before any import mutation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/import',
      headers: dashboardHeaders,
      payload: {
        format: 'agent-deck-bundle',
        version: 2,
        exportedAt: '2026-07-03T00:00:00.000Z',
        exportedFrom: { agentDeckVersion: 'test' },
        scope: 'collection',
        services: [],
        playbooks: [],
        decks: [{ id: '22222222-2222-4222-8222-222222222222' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(await db.getAllServices()).toHaveLength(0);
    expect(await db.getAllDecks()).toHaveLength(0);
  });
});
