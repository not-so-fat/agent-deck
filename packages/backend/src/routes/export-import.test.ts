import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_DECK_AGENT_CLIENT,
  AGENT_DECK_CLIENT_HEADER,
  AGENT_DECK_DASHBOARD_CLIENT,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { registerExportImportRoutes } from './export-import';
import { dashboardAuthHeaders } from '../test/auth-fixtures';

const dashboardHeaders = dashboardAuthHeaders();
const agentHeaders = {
  [AGENT_DECK_CLIENT_HEADER]: AGENT_DECK_AGENT_CLIENT,
};

describe('export-import routes', () => {
  let dbPath: string;
  let db: DatabaseManager;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agent-deck-export-routes-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
    app = Fastify();
    app.decorate('db', db);
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
    });
    const deck = await db.createDeck({
      name: 'dev',
      isActive: false,
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
    expect(bundle.services).toHaveLength(1);
    expect(bundle.decks).toHaveLength(1);

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
    expect(bundle.services.map((row: { name: string }) => row.name)).toEqual([
      'Linked',
    ]);
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
});
