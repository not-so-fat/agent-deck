import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { dashboardAuthHeaders } from '../test/auth-fixtures';

describe('trusted-session launch routes (NOT-105)', () => {
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
    const store = new TrustedSessionStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    registerHttpPolicyHook(fastify);
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, store, boundDeck, otherDeck };
  }

  it('connect-deck creates a launch session', async () => {
    const { fastify, boundDeck } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/mcp/connect-deck',
      payload: { deckId: boundDeck.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        deckId: boundDeck.id,
        deckName: 'bound',
        mode: 'normal',
      },
    });
    expect(response.json().data.sessionId).toMatch(/^ses_/);
  });

  it('connect-deck returns 404 for unknown deck', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/mcp/connect-deck',
      payload: { deckId: '00000000-0000-4000-8000-000000000099' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ success: false, error: 'Deck not found' });
  });

  it('connect-deck reuses active launch session for same mcpSessionId', async () => {
    const { fastify, boundDeck } = await buildApp();
    const first = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/mcp/connect-deck',
      payload: { deckId: boundDeck.id, mcpSessionId: 'mcp-reuse' },
    });
    const second = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/mcp/connect-deck',
      payload: { deckId: boundDeck.id, mcpSessionId: 'mcp-reuse' },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.sessionId).toBe(first.json().data.sessionId);
  });

  it('connect-deck rejects same mcpSessionId with a different deck', async () => {
    const { fastify, boundDeck, otherDeck } = await buildApp();
    await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/mcp/connect-deck',
      payload: { deckId: boundDeck.id, mcpSessionId: 'mcp-deck-fixed' },
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/mcp/connect-deck',
      payload: { deckId: otherDeck.id, mcpSessionId: 'mcp-deck-fixed' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error_code: 'GRANT_REQUIRED' });
  });

  it('bind-workspace launch session: same deck any path succeeds with deckFixed', async () => {
    const { fastify, store, boundDeck } = await buildApp();
    const launch = store.createRuntimeSession({
      deckId: boundDeck.id,
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/bind-workspace',
      headers: { [AGENT_DECK_SESSION_HEADER]: launch.sessionId },
      payload: { workspaceRoot: '/nope/x', deckId: boundDeck.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: { deckFixed: true },
    });
  });

  it('bind-workspace launch session: different deck → DECK_FIXED', async () => {
    const { fastify, store, boundDeck, otherDeck } = await buildApp();
    const launch = store.createRuntimeSession({
      deckId: boundDeck.id,
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/bind-workspace',
      headers: { [AGENT_DECK_SESSION_HEADER]: launch.sessionId },
      payload: { workspaceRoot: '/nope/x', deckId: otherDeck.id },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'DECK_FIXED' });
  });

  it('bind-workspace launch session: DECK_FIXED even after elevation without updateAssignment', async () => {
    const { fastify, store, boundDeck, otherDeck } = await buildApp();
    const launch = store.createRuntimeSession({
      deckId: boundDeck.id,
    });
    store.elevateSessionToAdmin(launch.sessionId);

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/bind-workspace',
      headers: { [AGENT_DECK_SESSION_HEADER]: launch.sessionId },
      payload: { workspaceRoot: '/nope/x', deckId: otherDeck.id },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'DECK_FIXED' });
  });

  it('bind-workspace launch session: updateAssignment requires elevation', async () => {
    const { fastify, store, boundDeck, otherDeck } = await buildApp();
    const launch = store.createRuntimeSession({
      deckId: boundDeck.id,
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/bind-workspace',
      headers: { [AGENT_DECK_SESSION_HEADER]: launch.sessionId },
      payload: { workspaceRoot: '/nope/x', deckId: otherDeck.id, updateAssignment: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'ADMIN_REQUIRED' });
  });

  it('bind-workspace launch session: elevated updateAssignment switches deck', async () => {
    const { fastify, store, boundDeck, otherDeck } = await buildApp();
    const launch = store.createRuntimeSession({
      deckId: boundDeck.id,
    });
    store.elevateSessionToAdmin(launch.sessionId);

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/bind-workspace',
      headers: { [AGENT_DECK_SESSION_HEADER]: launch.sessionId },
      payload: { workspaceRoot: '/nope/x', deckId: otherDeck.id, updateAssignment: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        deckId: otherDeck.id,
        assignmentUpdated: true,
      },
    });
    expect(store.getRuntimeSessionRow(launch.sessionId)?.deck_id).toBe(otherDeck.id);
  });

  describe('production deck-switch approval flow (NOT-199)', () => {
    async function requestElevation(
      fastify: Awaited<ReturnType<typeof buildApp>>['fastify'],
      sessionId: string,
    ) {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/trusted-session/admin/request-elevation',
        headers: { [AGENT_DECK_SESSION_HEADER]: sessionId },
        payload: { runtimeSessionId: sessionId },
      });
      expect(response.statusCode).toBe(200);
      return response.json().data as {
        challengeId: string;
        runtimeSessionId: string;
        approvalUrl: string;
      };
    }

    it('approval URL targets the originating session and challenge, and is echoed as fields', async () => {
      const { fastify, store, boundDeck } = await buildApp();
      const launch = store.createRuntimeSession({ deckId: boundDeck.id });

      const elevation = await requestElevation(fastify, launch.sessionId);

      expect(elevation.runtimeSessionId).toBe(launch.sessionId);
      const url = new URL(elevation.approvalUrl, 'http://agent-deck.local');
      expect(url.pathname).toBe('/admin/approve');
      expect(url.searchParams.get('challenge')).toBe(elevation.challengeId);
      expect(url.searchParams.get('session')).toBe(launch.sessionId);
    });

    it('request → dashboard approve → lease → deck switch persists on the launch session', async () => {
      const { fastify, store, boundDeck, otherDeck } = await buildApp();
      const launch = store.createRuntimeSession({ deckId: boundDeck.id });
      const headers = { [AGENT_DECK_SESSION_HEADER]: launch.sessionId };
      const switchBody = { workspaceRoot: '/nope/x', deckId: otherDeck.id, updateAssignment: true };

      const before = await fastify.inject({
        method: 'POST',
        url: '/api/trusted-session/bind-workspace',
        headers,
        payload: switchBody,
      });
      expect(before.json()).toMatchObject({ error_code: 'ADMIN_REQUIRED' });

      const elevation = await requestElevation(fastify, launch.sessionId);
      const approve = await fastify.inject({
        method: 'POST',
        url: '/api/trusted-session/admin/approve',
        headers: dashboardAuthHeaders(store),
        payload: { challengeId: elevation.challengeId, runtimeSessionId: elevation.runtimeSessionId },
      });
      expect(approve.statusCode).toBe(200);
      expect(approve.json().data.session).toMatchObject({ sessionId: launch.sessionId, mode: 'agent-admin' });

      const after = await fastify.inject({
        method: 'POST',
        url: '/api/trusted-session/bind-workspace',
        headers,
        payload: switchBody,
      });
      expect(after.statusCode).toBe(200);
      expect(store.getRuntimeSessionRow(launch.sessionId)?.deck_id).toBe(otherDeck.id);
    });

    it('approval fails explicitly without a dashboard session, and the lease is not granted', async () => {
      const { fastify, store, boundDeck } = await buildApp();
      const launch = store.createRuntimeSession({ deckId: boundDeck.id });
      const elevation = await requestElevation(fastify, launch.sessionId);

      const approve = await fastify.inject({
        method: 'POST',
        url: '/api/trusted-session/admin/approve',
        payload: { challengeId: elevation.challengeId, runtimeSessionId: elevation.runtimeSessionId },
      });
      expect(approve.statusCode).toBeGreaterThanOrEqual(400);
      expect(approve.json().error_code).toMatch(/^(GRANT_REQUIRED|DASHBOARD_REQUIRED)$/);
      expect(store.getRuntimeSessionRow(launch.sessionId)?.mode).not.toBe('agent-admin');
    });

    it('an unknown, reused, or foreign-session challenge reports ADMIN_CHALLENGE_EXPIRED', async () => {
      const { fastify, store, boundDeck } = await buildApp();
      const launch = store.createRuntimeSession({ deckId: boundDeck.id });
      const other = store.createRuntimeSession({ deckId: boundDeck.id });
      const elevation = await requestElevation(fastify, launch.sessionId);
      const approve = (challengeId: string, runtimeSessionId: string) =>
        fastify.inject({
          method: 'POST',
          url: '/api/trusted-session/admin/approve',
          headers: dashboardAuthHeaders(store),
          payload: { challengeId, runtimeSessionId },
        });

      const unknown = await approve('adm_doesnotexist', launch.sessionId);
      expect(unknown.statusCode).toBe(410);
      expect(unknown.json()).toMatchObject({ error_code: 'ADMIN_CHALLENGE_EXPIRED' });

      const foreign = await approve(elevation.challengeId, other.sessionId);
      expect(foreign.json()).toMatchObject({ error_code: 'ADMIN_CHALLENGE_EXPIRED' });
      expect(store.getRuntimeSessionRow(other.sessionId)?.mode).not.toBe('agent-admin');

      expect((await approve(elevation.challengeId, launch.sessionId)).statusCode).toBe(200);
      const reused = await approve(elevation.challengeId, launch.sessionId);
      expect(reused.json()).toMatchObject({ error_code: 'ADMIN_CHALLENGE_EXPIRED' });
    });
  });
});
