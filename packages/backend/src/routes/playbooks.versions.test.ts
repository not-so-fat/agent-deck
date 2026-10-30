import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER, generateId } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { TrustedSessionStore } from '../trusted-session/store';
import { registerPlaybookRoutes } from './playbooks';

describe('playbook version read (NOT-537)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const boundDeck = await db.createDeck({ name: 'bound' });
    const otherDeck = await db.createDeck({ name: 'other' });
    const playbook = await db.createPlaybook({
      id: 'pb_pinned',
      title: 'current title',
      body: 'current body',
      triggers: ['current'],
    });
    await db.addPlaybookToDeck({ deckId: boundDeck.id, playbookId: playbook.id, position: 0 });
    const offDeck = await db.createPlaybook({
      id: 'pb_off_deck',
      title: 'off deck',
      body: 'off deck body',
      triggers: ['off'],
    });
    await db.addPlaybookToDeck({ deckId: otherDeck.id, playbookId: offDeck.id, position: 0 });

    const version = await db.createPlaybookVersion({
      id: generateId(),
      playbookId: playbook.id,
      title: 'older title',
      body: 'older body',
      triggers: ['older'],
      patchId: null,
      actor: 'agent',
    });
    const otherVersion = await db.createPlaybookVersion({
      id: generateId(),
      playbookId: offDeck.id,
      title: 'other version',
      body: 'other body',
      triggers: ['other'],
      patchId: null,
      actor: 'agent',
    });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const session = store.createRuntimeSession({ deckId: boundDeck.id });

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('playbookManager', {});
    fastify.decorate('patchManager', {});

    await fastify.register(registerPlaybookRoutes, { prefix: '/api/playbooks' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, store, session, playbook, offDeck, version, otherVersion };
  }

  function agentHeaders(sessionId: string) {
    return { [AGENT_DECK_SESSION_HEADER]: sessionId };
  }

  it('returns the stored snapshot for a bound-deck playbook', async () => {
    const { fastify, session, playbook, version } = await buildApp();

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${playbook.id}/versions/${version.id}`,
      headers: agentHeaders(session.sessionId),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { success: boolean; data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      id: version.id,
      playbookId: playbook.id,
      title: 'older title',
      body: 'older body',
      triggers: ['older'],
    });
  });

  it('returns 404 for an unknown version id', async () => {
    const { fastify, session, playbook } = await buildApp();

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${playbook.id}/versions/${generateId()}`,
      headers: agentHeaders(session.sessionId),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ success: false });
  });

  it('rejects a version that belongs to a different playbook', async () => {
    const { fastify, session, playbook, otherVersion } = await buildApp();

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${playbook.id}/versions/${otherVersion.id}`,
      headers: agentHeaders(session.sessionId),
    });
    expect(response.statusCode).toBe(400);
    expect(String((response.json() as { error: string }).error)).toContain(otherVersion.id);
  });

  it('keeps agent reads scoped to the bound deck', async () => {
    const { fastify, session, offDeck, otherVersion } = await buildApp();

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${offDeck.id}/versions/${otherVersion.id}`,
      headers: agentHeaders(session.sessionId),
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets the dashboard read any version', async () => {
    const { fastify, store, offDeck, otherVersion } = await buildApp();

    const response = await fastify.inject({
      method: 'GET',
      url: `/api/playbooks/${offDeck.id}/versions/${otherVersion.id}`,
      headers: dashboardAuthHeaders(store),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: { id: string } }).data.id).toBe(otherVersion.id);
  });
});
