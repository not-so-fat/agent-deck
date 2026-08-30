import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_DECK_AGENT_CLIENT,
  AGENT_DECK_CLIENT_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { registerScopeRoutes } from './scope';
import { registerDeckRoutes } from './decks';
import { agentSessionHeaders } from '../test/auth-fixtures';
import { TrustedSessionStore } from '../trusted-session/store';

const agentHeaders = {
  [AGENT_DECK_CLIENT_HEADER]: AGENT_DECK_AGENT_CLIENT,
};

describe('agent scope and deck list routes', () => {
  let dbPath: string;
  let db: DatabaseManager;
  let playbookManager: PlaybookManager;
  let app: ReturnType<typeof Fastify>;
  let deckId: string;
  let playbookId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agent-deck-scope-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
    playbookManager = new PlaybookManager(db);

    const deck = await db.createDeck({ name: 'dev', isActive: false });
    deckId = deck.id;

    const service = await db.createService({
      name: 'Slack',
      type: 'mcp',
      url: 'https://mcp.slack.com/mcp',
      cardColor: '#000',
      oauthClientSecret: 'secret',
      headers: { Authorization: 'Bearer token', 'X-Api-Key': 'key', 'X-Trace': 'ok' },
    });
    await db.addServiceToDeck({ deckId, serviceId: service.id });

    const playbook = await playbookManager.create({
      title: 'PR summary',
      body: '## Steps\n- Write summary\n',
      triggers: ['summarize PR'],
    });
    playbookId = playbook.id;
    await playbookManager.addToDeck({ deckId, playbookId });

    app = Fastify();
    app.decorate('db', db);
    app.decorate('playbookManager', playbookManager);
    app.decorate('credentialManager', {
      applySecretStatus: async (credentials: unknown[]) => credentials,
    });
    app.decorate('trustedSessionStore', new TrustedSessionStore(db.getSqliteDatabase()));
    await app.register(registerScopeRoutes, { prefix: '/api/scope' });
    await app.register(registerDeckRoutes, { prefix: '/api/decks' });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('GET /api/scope/deck returns sanitized services and playbook summaries only', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/scope/deck',
      headers: {
        ...agentHeaders,
        ...agentSessionHeaders(db, deckId),
        [AGENT_DECK_WORKSPACE_HEADER]: '/repo',
      },
    });

    expect(response.statusCode).toBe(200);
    const deck = response.json().data as {
      services: Array<Record<string, unknown>>;
      playbooks: Array<Record<string, unknown>>;
    };

    const slack = deck.services[0];
    expect(slack.oauthClientSecret).toBeUndefined();
    expect(slack.headers).toEqual({ 'X-Trace': 'ok' });

    expect(deck.playbooks).toHaveLength(1);
    expect(deck.playbooks[0]).toEqual({
      id: playbookId,
      title: 'PR summary',
      triggers: ['summarize PR'],
    });
    expect(deck.playbooks[0]).not.toHaveProperty('body');
  });

  it('GET /api/decks returns metadata-only list for agent clients', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/decks',
      headers: {
        ...agentHeaders,
        ...agentSessionHeaders(db, deckId),
      },
    });

    expect(response.statusCode).toBe(200);
    const decks = response.json().data as Array<Record<string, unknown>>;
    expect(decks.length).toBeGreaterThan(0);
    expect(decks[0]).toEqual({
      id: deckId,
      name: 'dev',
      isActive: false,
      cardCounts: { mcp: 1, credentials: 0, playbooks: 1 },
    });
    expect(decks[0]).not.toHaveProperty('services');
  });

  it('GET /api/decks/:ref resolves deck by name for bind', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/decks/dev',
      headers: {
        ...agentHeaders,
        ...agentSessionHeaders(db, deckId),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.id).toBe(deckId);
  });
});
