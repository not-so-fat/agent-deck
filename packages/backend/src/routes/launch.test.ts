import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { generateId } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { PlaybookManager } from '../playbooks/playbook-manager';
import { registerLaunchRoutes } from '../routes/launch';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';

describe('launch routes (NOT-105)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(`:memory:${Math.random()}`);
    const deck = await db.createDeck({ name: 'launch-deck' });
    const playbook = await db.createPlaybook({
      id: generateId(),
      title: 'pb-one',
      body: 'body',
      triggers: ['t'],
    });
    await db.addPlaybookToDeck({ deckId: deck.id, playbookId: playbook.id, position: 0 });

    const playbookManager = new PlaybookManager(db);
    const store = new TrustedSessionStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('playbookManager', playbookManager);
    registerHttpPolicyHook(fastify);
    await fastify.register(registerLaunchRoutes, { prefix: '/api/launch' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, deck, playbook };
  }

  it('lists decks without credentials', async () => {
    const { fastify, deck } = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/api/launch/decks' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: { decks: [{ id: deck.id, name: 'launch-deck' }] },
    });
  });

  it('lists playbooks for a deck', async () => {
    const { fastify, deck, playbook } = await buildApp();
    const response = await fastify.inject({
      method: 'GET',
      url: `/api/launch/decks/${deck.id}/playbooks`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: [{ id: playbook.id, title: 'pb-one', triggers: ['t'] }],
    });
  });

  it('returns 404 for unknown deck playbooks', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/launch/decks/00000000-0000-4000-8000-000000000099/playbooks',
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 400 for encoded-slash deckId', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/launch/decks/x%2Fy/playbooks',
    });
    expect(response.statusCode).toBe(400);
  });
});
