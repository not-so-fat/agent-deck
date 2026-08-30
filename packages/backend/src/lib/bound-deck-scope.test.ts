import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { TrustedSessionStore, generateGrantSecret } from '../trusted-session/store';
import {
  BoundDeckScopeError,
  requireBoundDeckScope,
  requirePlaybookOnBoundDeck,
  requireServiceOnBoundDeck,
} from './bound-deck-scope';

async function agentRequest(deckId: string) {
  const db = new DatabaseManager(`:memory:${Math.random()}`);
  const boundDeck = await db.createDeck({ name: 'bound' });
  const otherDeck = await db.createDeck({ name: 'other' });

  const store = new TrustedSessionStore(db.getSqliteDatabase());
  const workspace = store.getOrCreateWorkspaceKey('scope-test');
  const secret = generateGrantSecret();
  const pending = store.createPendingGrant(workspace.id, boundDeck.id, secret);
  store.activateGrant(pending.id);
  const grant = store.findActiveGrantBySecret(secret)!;
  const session = store.createRuntimeSession({
    workspaceKeyId: workspace.id,
    workspaceGrantId: grant.id,
    deckId: boundDeck.id,
  });

  const fastify = Fastify();
  fastify.decorate('db', db);
  fastify.decorate('trustedSessionStore', store);
  await fastify.ready();

  const request = {
    headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
    server: fastify,
  } as Parameters<typeof requireBoundDeckScope>[0];

  return { db, request, boundDeck, otherDeck, fastify };
}

describe('bound-deck-scope', () => {
  it('requireBoundDeckScope rejects wrong deck id for agents', async () => {
    const { request, boundDeck, otherDeck, fastify } = await agentRequest('x');
    await expect(requireBoundDeckScope(request, fastify.db, otherDeck.id)).rejects.toBeInstanceOf(
      BoundDeckScopeError,
    );
    await expect(requireBoundDeckScope(request, fastify.db, boundDeck.id)).resolves.toBe(
      boundDeck.id,
    );
    await fastify.close();
  });

  it('requireServiceOnBoundDeck throws BoundDeckScopeError off-deck', async () => {
    const { db, request, boundDeck, otherDeck, fastify } = await agentRequest('x');
    const onDeck = await db.createService({
      name: 'on',
      type: 'mcp',
      url: 'http://127.0.0.1:9/on',
    });
    const offDeck = await db.createService({
      name: 'off',
      type: 'mcp',
      url: 'http://127.0.0.1:9/off',
    });
    await db.addServiceToDeck({ deckId: boundDeck.id, serviceId: onDeck.id, position: 0 });
    await db.addServiceToDeck({ deckId: otherDeck.id, serviceId: offDeck.id, position: 0 });

    await expect(requireServiceOnBoundDeck(request, db, offDeck.id)).rejects.toMatchObject({
      errorCode: 'RESOURCE_OUT_OF_SCOPE',
    });
    await expect(requireServiceOnBoundDeck(request, db, onDeck.id)).resolves.toBeUndefined();
    await fastify.close();
  });

  it('requirePlaybookOnBoundDeck throws BoundDeckScopeError off-deck', async () => {
    const { db, request, boundDeck, otherDeck, fastify } = await agentRequest('x');
    const onDeck = await db.createPlaybook({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'on',
      body: 'b',
      triggers: ['t'],
    });
    const offDeck = await db.createPlaybook({
      id: '22222222-2222-4222-8222-222222222222',
      title: 'off',
      body: 'b',
      triggers: ['t'],
    });
    await db.addPlaybookToDeck({ deckId: boundDeck.id, playbookId: onDeck.id, position: 0 });
    await db.addPlaybookToDeck({ deckId: otherDeck.id, playbookId: offDeck.id, position: 0 });

    await expect(
      requirePlaybookOnBoundDeck(request, db, offDeck.id),
    ).rejects.toMatchObject({ errorCode: 'RESOURCE_OUT_OF_SCOPE' });
    await expect(requirePlaybookOnBoundDeck(request, db, onDeck.id)).resolves.toBeUndefined();
    await fastify.close();
  });
});
