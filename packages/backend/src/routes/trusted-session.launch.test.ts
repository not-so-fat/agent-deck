import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER } from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';

describe('trusted-session launch routes (NOT-105)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(`:memory:${Math.random()}`);
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
});
