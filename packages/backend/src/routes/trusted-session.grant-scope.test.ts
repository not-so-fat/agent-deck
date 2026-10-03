/**
 * NOT-318: grant allowlist enforcement on the deck-switch and bind-workspace
 * paths. A grant session cannot request, approve, or move to a deck outside
 * its allowlist; loopback launcher sessions stay unconstrained.
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { ClientGrantStore } from '../auth/client-grants';
import { DatabaseManager } from '../models/database';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { registerTrustedSessionRoutes } from './trusted-session';

describe('grant-scoped deck switching (NOT-318)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'scope-a' });
    const deckB = await db.createDeck({ name: 'scope-b' });
    const deckC = await db.createDeck({ name: 'scope-outside' });
    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const grants = new ClientGrantStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('grantStore', grants);
    registerHttpPolicyHook(fastify);
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, store, grants, deckA, deckB, deckC };
  }

  function sessionHeaders(sessionId: string): Record<string, string> {
    return { [AGENT_DECK_SESSION_HEADER]: sessionId };
  }

  it('a grant session requests an allowed deck but never an out-of-grant deck', async () => {
    const { fastify, store, grants, deckA, deckB, deckC } = await buildApp();
    const issued = grants.issueGrant({
      label: 'scoped',
      defaultDeck: deckA.id,
      allowedDecks: [deckA.id, deckB.id],
    });
    const session = store.createRuntimeSession({ deckId: deckA.id, grantId: issued.grant.id });

    const allowed = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: sessionHeaders(session.sessionId),
      payload: { target: deckB.id },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().data.requestedDeckId).toBe(deckB.id);

    const denied = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: sessionHeaders(session.sessionId),
      payload: { target: deckC.id },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ success: false });

    // The denied request left no pending request behind.
    expect(store.listPendingDeckSwitchRequests(session.sessionId)).toHaveLength(1);
  });

  it('approval after grant revocation fails closed and leaves the binding', async () => {
    const { fastify, store, grants, deckA, deckB } = await buildApp();
    const issued = grants.issueGrant({
      label: 'revoke-race',
      defaultDeck: deckA.id,
      allowedDecks: [deckA.id, deckB.id],
    });
    const session = store.createRuntimeSession({ deckId: deckA.id, grantId: issued.grant.id });

    const created = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: sessionHeaders(session.sessionId),
      payload: { target: deckB.id },
    });
    const requestId = created.json().data.requestId as string;

    grants.revokeGrant(issued.grant.id);

    const resolve = await fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload: { runtimeSessionId: session.sessionId, decision: 'session' },
    });
    expect(resolve.statusCode).toBe(401);
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
  });

  it('approval of an allowed deck still commits for a live grant', async () => {
    const { fastify, store, grants, deckA, deckB } = await buildApp();
    const issued = grants.issueGrant({
      label: 'happy',
      defaultDeck: deckA.id,
      allowedDecks: [deckA.id, deckB.id],
    });
    const session = store.createRuntimeSession({ deckId: deckA.id, grantId: issued.grant.id });

    const created = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: sessionHeaders(session.sessionId),
      payload: { target: deckB.id },
    });
    const requestId = created.json().data.requestId as string;

    const resolve = await fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload: { runtimeSessionId: session.sessionId, decision: 'session' },
    });
    expect(resolve.statusCode).toBe(200);
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckB.id);
  });

  it('a loopback launcher session without a grant stays unconstrained', async () => {
    const { fastify, store, deckA, deckC } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });

    const created = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch',
      headers: sessionHeaders(session.sessionId),
      payload: { target: deckC.id },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data.requestedDeckId).toBe(deckC.id);
  });

  it('an elevated grant session cannot bind-workspace outside its allowlist', async () => {
    const { fastify, store, grants, deckA, deckB, deckC } = await buildApp();
    const issued = grants.issueGrant({
      label: 'elevated',
      defaultDeck: deckA.id,
      allowedDecks: [deckA.id, deckB.id],
    });
    const session = store.createRuntimeSession({ deckId: deckA.id, grantId: issued.grant.id });
    store.elevateSessionToAdmin(session.sessionId);

    const outside = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/bind-workspace',
      headers: sessionHeaders(session.sessionId),
      payload: { workspaceRoot: '/tmp', deckId: deckC.id, updateAssignment: true },
    });
    expect(outside.statusCode).toBe(403);

    const inside = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/bind-workspace',
      headers: sessionHeaders(session.sessionId),
      payload: { workspaceRoot: '/tmp', deckId: deckB.id, updateAssignment: true },
    });
    expect(inside.statusCode).toBe(200);
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckB.id);
  });
});
