/**
 * NOT-318: owner-only per-agent grant issuance API.
 *
 * Covers create/list/revoke, dashboard-only enforcement (a remote Bearer [REDACTED]
 * can never mint grants), and API redaction (ids/labels visible, secrets never).
 */
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { ClientGrantStore, parseGrantToken } from '../auth/client-grants';
import { DatabaseManager } from '../models/database';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { registerAgentGrantRoutes } from './agent-grants';

describe('owner-only agent grants (NOT-318)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'grant-deck-a' });
    const deckB = await db.createDeck({ name: 'grant-deck-b' });
    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const grants = new ClientGrantStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('grantStore', grants);
    registerHttpPolicyHook(fastify);
    await fastify.register(registerAgentGrantRoutes, { prefix: '/api' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, db, store, grants, deckA, deckB };
  }

  it('owner creates a grant and sees the secret exactly once', async () => {
    const { fastify, store, deckA, deckB } = await buildApp();
    const create = await fastify.inject({
      method: 'POST',
      url: '/api/agent-grants',
      headers: dashboardAuthHeaders(store),
      payload: { label: 'field-agent', defaultDeck: deckA.id, allowedDecks: [deckA.id, deckB.id] },
    });
    expect(create.statusCode).toBe(201);
    expect(create.headers['cache-control']).toBe('no-store');
    const body = create.json();
    expect(body.success).toBe(true);
    expect(body.data.grant).toMatchObject({
      label: 'field-agent',
      defaultDeck: deckA.id,
    });
    expect(body.data.grant).not.toHaveProperty('verifierVersion');
    expect(body.data.grant.allowedDecks).toEqual(expect.arrayContaining([deckA.id, deckB.id]));
    expect(typeof body.data.token).toBe('string');
    expect(parseGrantToken(body.data.token)).not.toBeNull();

    // The grant object itself carries no secret material.
    expect(JSON.stringify(body.data.grant)).not.toContain(body.data.token);
  });

  it('denies create/list/revoke without dashboard auth, including to Bearer [REDACTED]', async () => {
    const { fastify, grants, store, deckA } = await buildApp();
    const issued = grants.issueGrant({ label: 'nope', defaultDeck: deckA.id });
    const agentSession = store.createRuntimeSession({ deckId: deckA.id });

    for (const request of [
      { method: 'POST', url: '/api/agent-grants', payload: { label: 'x', defaultDeck: deckA.id } },
      { method: 'GET', url: '/api/agent-grants' },
      { method: 'POST', url: `/api/agent-grants/${issued.grant.id}/revoke` },
    ] as const) {
      // No credentials at all: 401.
      const denied = await fastify.inject({ ...request, headers: {} });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toMatchObject({ success: false });

      // A remote agent token confers no issuance power either.
      const bearerDenied = await fastify.inject({
        ...request,
        headers: { authorization: `Bearer ${issued.token}` },
      });
      expect(bearerDenied.statusCode).toBe(401);

      // An agent session is authenticated but not the dashboard: 403.
      const agentDenied = await fastify.inject({
        ...request,
        headers: { [AGENT_DECK_SESSION_HEADER]: agentSession.sessionId },
      });
      expect(agentDenied.statusCode).toBe(403);
    }
  });

  it('lists grants without secrets and revokes with immediate session kill', async () => {
    const { fastify, store, grants, deckA } = await buildApp();
    const auth = dashboardAuthHeaders(store);
    const issued = grants.issueGrant({ label: 'list-probe', defaultDeck: deckA.id });
    const secret = parseGrantToken(issued.token)!.secret;

    const list = await fastify.inject({ method: 'GET', url: '/api/agent-grants', headers: auth });
    expect(list.statusCode).toBe(200);
    const listBody = list.json();
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]).toMatchObject({ id: issued.grant.id, label: 'list-probe' });
    expect(listBody.data[0]).not.toHaveProperty('verifierVersion');
    // Redaction: neither the full token nor the raw secret appears in list output.
    expect(list.body).not.toContain(issued.token);
    expect(list.body).not.toContain(secret);

    // A live runtime session owned by the grant dies with the revocation.
    const live = store.createRuntimeSession({ deckId: deckA.id, grantId: issued.grant.id });
    const revoke = await fastify.inject({
      method: 'POST',
      url: `/api/agent-grants/${issued.grant.id}/revoke`,
      headers: auth,
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().data).toMatchObject({ revoked: true, sessionsRevoked: 1 });
    expect(store.getRuntimeSessionRow(live.sessionId)?.revoked_at).not.toBeNull();
    expect(grants.authenticateToken(issued.token)).toBeNull();
    // Redaction on the revoke response as well.
    expect(revoke.body).not.toContain(issued.token);
    expect(revoke.body).not.toContain(secret);
  });

  it('revoking an unknown grant is a 404', async () => {
    const { fastify, store } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/agent-grants/ag_does-not-exist/revoke',
      headers: dashboardAuthHeaders(store),
    });
    expect(response.statusCode).toBe(404);
  });

  it('validates create input without leaking anything', async () => {
    const { fastify, store, deckA } = await buildApp();
    const auth = dashboardAuthHeaders(store);

    const missingLabel = await fastify.inject({
      method: 'POST',
      url: '/api/agent-grants',
      headers: auth,
      payload: { defaultDeck: deckA.id },
    });
    expect(missingLabel.statusCode).toBe(400);

    const unknownDeck = await fastify.inject({
      method: 'POST',
      url: '/api/agent-grants',
      headers: auth,
      payload: { label: 'x', defaultDeck: '00000000-0000-4000-8000-000000000099' },
    });
    expect(unknownDeck.statusCode).toBe(404);

    const unknownAllowed = await fastify.inject({
      method: 'POST',
      url: '/api/agent-grants',
      headers: auth,
      payload: { label: 'x', defaultDeck: deckA.id, allowedDecks: ['no-such-deck'] },
    });
    expect(unknownAllowed.statusCode).toBe(404);
  });

  it('accepts deck names as well as ids', async () => {
    const { fastify, store } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/agent-grants',
      headers: dashboardAuthHeaders(store),
      payload: { label: 'by-name', defaultDeck: 'grant-deck-a' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.grant.defaultDeck).toBeTruthy();
  });

  it('agent session headers do not satisfy the dashboard policy', async () => {
    const { fastify, store, deckA } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/agent-grants',
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
    });
    expect(response.statusCode).toBe(403);
  });
});
