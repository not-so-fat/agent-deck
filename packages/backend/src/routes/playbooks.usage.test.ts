import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER, generateId } from '@agent-deck/shared';

import { DatabaseManager, hashCardUsageSessionId } from '../models/database';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { TrustedSessionStore } from '../trusted-session/store';
import { registerPlaybookRoutes } from './playbooks';

describe('playbook fetch usage events (NOT-292)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const boundDeck = await db.createDeck({ name: 'bound' });
    const playbook = await db.createPlaybook({
      id: generateId(),
      title: 'on-deck',
      body: 'body',
      triggers: ['t'],
    });
    await db.addPlaybookToDeck({ deckId: boundDeck.id, playbookId: playbook.id, position: 0 });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const session = store.createRuntimeSession({ deckId: boundDeck.id });

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('playbookManager', {
      getWithDependencies: async (id: string) =>
        id === playbook.id
          ? {
              id,
              title: 'on-deck',
              body: 'body',
              triggers: ['t'],
              dependsOnCredentialIds: [],
              dependsOnServiceIds: [],
            }
          : null,
    });
    fastify.decorate('patchManager', {
      listOpenPatchSummaries: async () => [],
    });

    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, db, store, session, playbook, boundDeck };
  }

  async function usageEvents(db: DatabaseManager) {
    const { events } = await db.listCardUsageEvents({
      from: '2000-01-01T00:00:00.000Z',
      to: '2100-01-01T00:00:00.000Z',
      limit: 50,
    });
    return events;
  }

  it('persists a playbook-use event for an agent/IDE fetch', async () => {
    const { fastify, db, store, session, playbook, boundDeck } = await buildApp();

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${playbook.id}`,
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
    });
    expect(response.statusCode).toBe(200);

    const events = await usageEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      cardType: 'playbook',
      cardId: playbook.id,
      deckId: boundDeck.id,
      action: 'fetch',
      success: true,
      sessionId: hashCardUsageSessionId(session.sessionId),
    });
    // The raw bearer is never stored — only its one-way hash.
    expect(events[0].sessionId).not.toBe(session.sessionId);
    expect(JSON.stringify(events)).not.toContain(session.sessionId);
    await expect(db.getUsageObservationStart('playbook')).resolves.not.toBeNull();
    await expect(db.countSuccessfulPlaybookFetches(playbook.id)).resolves.toBe(1);

    const countResponse = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${playbook.id}/events/count`,
      headers: dashboardAuthHeaders(store),
    });
    expect(countResponse.statusCode).toBe(200);
    expect(countResponse.json()).toMatchObject({ success: true, data: 1 });
  });

  it('persists no playbook-use event for a dashboard details read', async () => {
    const { fastify, db, store, playbook } = await buildApp();

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${playbook.id}`,
      headers: dashboardAuthHeaders(store),
    });
    expect(response.statusCode).toBe(200);

    // Dashboard inspection leaves the normalized stream untouched …
    await expect(usageEvents(db)).resolves.toHaveLength(0);
    // … but the seeded observation start still marks a fully observed
    // zero-use window for classification.
    await expect(db.getUsageObservationStart('playbook')).resolves.not.toBeNull();
    // Dashboard inspection must not inflate the all-time usage signal.
    await expect(db.countSuccessfulPlaybookFetches(playbook.id)).resolves.toBe(0);

    const countResponse = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${playbook.id}/events/count`,
      headers: dashboardAuthHeaders(store),
    });
    expect(countResponse.statusCode).toBe(200);
    expect(countResponse.json()).toMatchObject({ success: true, data: 0 });
  });
});
