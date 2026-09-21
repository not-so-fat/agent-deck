import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { resolveRoutePolicy } from '../trusted-session/route-policy-registry';
import { TrustedSessionStore } from '../trusted-session/store';
import { dashboardAuthHeaders } from '../test/auth-fixtures';

describe('trusted-session deck-switch approval routes (NOT-207)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'deck-a' });
    const deckB = await db.createDeck({ name: 'deck-b' });
    const store = new TrustedSessionStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    registerHttpPolicyHook(fastify);
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, db, store, deckA, deckB };
  }

  function workspaceBindings(db: DatabaseManager) {
    return (
      db
        .getSqliteDatabase()
        .prepare(`SELECT workspace_root, deck_id FROM deck_workspaces`)
        .all() as Array<{ workspace_root: string; deck_id: string }>
    ).map((row) => ({ workspaceRoot: row.workspace_root, deckId: row.deck_id }));
  }

  it('registers authorization policies for the approval endpoints', () => {
    expect(resolveRoutePolicy('GET', '/api/trusted-session/deck-switch/req_123')).toBe(
      'requireAgentOrDashboard',
    );
    expect(resolveRoutePolicy('POST', '/api/trusted-session/deck-switch/req_123/resolve')).toBe(
      'requireDashboard',
    );
  });

  it('session-only approval rebinds the session and keeps the workspace default', async () => {
    const { fastify, db, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    await db.upsertDeckWorkspace('/work/ws', deckA.id);
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${request.requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload: { runtimeSessionId: session.sessionId, decision: 'session' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: { requestId: request.requestId, decision: 'session', status: 'consumed', deckId: deckB.id },
    });
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckB.id);
    expect(workspaceBindings(db)).toEqual([{ workspaceRoot: '/work/ws', deckId: deckA.id }]);
  });

  it('workspace-default approval rebinds the session and the assignment without reload', async () => {
    const { fastify, db, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    await db.upsertDeckWorkspace('/work/ws', deckA.id);
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${request.requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload: { runtimeSessionId: session.sessionId, decision: 'workspace-default' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        requestId: request.requestId,
        decision: 'workspace-default',
        status: 'consumed',
        deckId: deckB.id,
        workspaceRoot: '/work/ws',
      },
    });
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckB.id);
    expect(workspaceBindings(db)).toEqual([{ workspaceRoot: '/work/ws', deckId: deckB.id }]);

    const runtime = await fastify.inject({
      method: 'GET',
      url: '/api/trusted-session/runtime-session',
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
    });
    expect(runtime.json()).toMatchObject({ success: true, data: { deckId: deckB.id } });
  });

  it('decline keeps the prior binding effective', async () => {
    const { fastify, db, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    await db.upsertDeckWorkspace('/work/ws', deckA.id);
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${request.requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload: { runtimeSessionId: session.sessionId, decision: 'decline' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: { requestId: request.requestId, decision: 'decline', status: 'declined' },
    });
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(workspaceBindings(db)).toEqual([{ workspaceRoot: '/work/ws', deckId: deckA.id }]);
  });

  it('repeat resolution returns consumed and applies no second mutation', async () => {
    const { fastify, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });
    const headers = dashboardAuthHeaders(store);
    const url = `/api/trusted-session/deck-switch/${request.requestId}/resolve`;

    const first = await fastify.inject({
      method: 'POST',
      url,
      headers,
      payload: { runtimeSessionId: session.sessionId, decision: 'decline' },
    });
    expect(first.statusCode).toBe(200);

    const second = await fastify.inject({
      method: 'POST',
      url,
      headers,
      payload: { runtimeSessionId: session.sessionId, decision: 'session' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      success: false,
      error_code: 'DECK_SWITCH_CONSUMED',
      status: 'declined',
    });
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('declined');
  });

  it('expired requests resolve with a stable code and change nothing', async () => {
    const { fastify, db, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });
    db.getSqliteDatabase()
      .prepare(`UPDATE deck_switch_requests SET expires_at = ? WHERE id = ?`)
      .run('2000-01-01T00:00:00.000Z', request.requestId);

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${request.requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload: { runtimeSessionId: session.sessionId, decision: 'session' },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ success: false, error_code: 'DECK_SWITCH_EXPIRED' });
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
  });

  it('foreign-session approval is unauthorized and changes nothing', async () => {
    const { fastify, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const other = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const response = await fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${request.requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload: { runtimeSessionId: other.sessionId, decision: 'workspace-default' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ success: false, error_code: 'RESOURCE_OUT_OF_SCOPE' });
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });

  it('resolve requires dashboard authentication', async () => {
    const { fastify, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const agentOnly = await fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${request.requestId}/resolve`,
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
      payload: { runtimeSessionId: session.sessionId, decision: 'session' },
    });
    expect(agentOnly.statusCode).toBe(403);
    expect(agentOnly.json()).toMatchObject({ success: false, error_code: 'DASHBOARD_REQUIRED' });
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });

  it('rejects decisions outside the three approved scopes', async () => {
    const { fastify, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    for (const decision of ['approve', 'session-and-default', '']) {
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/trusted-session/deck-switch/${request.requestId}/resolve`,
        headers: dashboardAuthHeaders(store),
        payload: { runtimeSessionId: session.sessionId, decision },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });

  it('unknown requests resolve to 404', async () => {
    const { fastify, store, deckA } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/deck-switch/req_missing/resolve',
      headers: dashboardAuthHeaders(store),
      payload: { runtimeSessionId: session.sessionId, decision: 'session' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('inspect hides the target deck from other agents but shows it to the dashboard', async () => {
    const { fastify, store, deckA, deckB } = await buildApp();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const other = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });
    const url = `/api/trusted-session/deck-switch/${request.requestId}`;

    const owner = await fastify.inject({
      method: 'GET',
      url,
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().data).toMatchObject({ requestId: request.requestId, status: 'pending' });
    expect(owner.json().data).not.toHaveProperty('requestedDeckId');
    expect(owner.json().data).not.toHaveProperty('workspaceRoot');

    const foreign = await fastify.inject({
      method: 'GET',
      url,
      headers: { [AGENT_DECK_SESSION_HEADER]: other.sessionId },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error_code: 'RESOURCE_OUT_OF_SCOPE' });

    const dashboard = await fastify.inject({
      method: 'GET',
      url,
      headers: dashboardAuthHeaders(store),
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().data).toMatchObject({
      requestId: request.requestId,
      status: 'pending',
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });
  });

  it('inspect of an unknown request is 404', async () => {
    const { fastify, store } = await buildApp();

    const response = await fastify.inject({
      method: 'GET',
      url: '/api/trusted-session/deck-switch/req_missing',
      headers: dashboardAuthHeaders(store),
    });
    expect(response.statusCode).toBe(404);
  });
});
