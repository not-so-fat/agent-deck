import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_DECK_CLIENT_HEADER,
  AGENT_DECK_DASHBOARD_CLIENT,
  AGENT_DECK_SESSION_HEADER,
  canonicalizeWorkspacePath,
  digestCanonicalWorkspacePath,
} from '@agent-deck/shared';

import { DatabaseManager } from '../models/database';
import { registerDeckRoutes } from '../routes/decks';
import { registerServiceRoutes } from '../routes/services';
import { registerTrustedSessionRoutes } from '../routes/trusted-session';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore, generateGrantSecret } from '../trusted-session/store';
import type { ServiceManager } from '../services/service-manager';

describe('trusted session auth matrix (§8)', () => {
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
    const workspaceRoot = '/Users/test/agent-deck';

    const serviceOnBound = await db.createService({
      name: 'bound-svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp',
    });
    await db.addServiceToDeck({ deckId: boundDeck.id, serviceId: serviceOnBound.id, position: 0 });

    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const digest = digestCanonicalWorkspacePath(canonicalizeWorkspacePath(workspaceRoot));
    const workspace = store.getOrCreateWorkspaceKey(digest);
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
    fastify.decorate('serviceManager', {
      discoverServiceTools: async () => [],
      callServiceTool: async () => ({ success: true, result: {} }),
      getAllServices: async () => [serviceOnBound],
      getService: async (id: string) => (id === serviceOnBound.id ? serviceOnBound : null),
    } as unknown as ServiceManager);
    fastify.decorate('broadcastServiceUpdate', () => {});
    fastify.decorate('storeWriter', { writeDeck: async () => {} });

    registerHttpPolicyHook(fastify);
    await fastify.register(registerServiceRoutes, { prefix: '/api/services' });
    await fastify.register(registerDeckRoutes, { prefix: '/api/decks', storeWriter: { writeDeck: async () => {} } });
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.ready();
    servers.push(fastify);

    return { fastify, session, boundDeck, otherDeck, store, secret, workspaceRoot };
  }

  it('forged legacy deck header does not expand agent access to dashboard-only routes', async () => {
    const { fastify, session, otherDeck } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/services',
      headers: {
        [AGENT_DECK_SESSION_HEADER]: session.sessionId,
        'x-agent-deck-deck-id': otherDeck.id,
        [AGENT_DECK_CLIENT_HEADER]: AGENT_DECK_DASHBOARD_CLIENT,
      },
      payload: { name: 'forged', type: 'mcp', url: 'http://127.0.0.1:9/x' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'DASHBOARD_REQUIRED' });
  });

  it('agent without elevation is denied deck creation', async () => {
    const { fastify, session } = await buildApp();
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/decks',
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
      payload: { name: 'new-deck' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'ADMIN_REQUIRED' });
  });

  it('elevation request → dashboard approve → deck creation succeeds', async () => {
    const { fastify, session, store } = await buildApp();

    const requestElevation = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/admin/request-elevation',
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
      payload: { runtimeSessionId: session.sessionId },
    });
    expect(requestElevation.statusCode).toBe(200);
    const { challengeId } = requestElevation.json().data as { challengeId: string };

    const approve = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/admin/approve',
      headers: dashboardAuthHeaders(),
      payload: { challengeId, runtimeSessionId: session.sessionId },
    });
    expect(approve.statusCode).toBe(200);

    const elevated = store.getRuntimeSessionRow(session.sessionId);
    expect(elevated?.mode).toBe('agent-admin');

    const createDeck = await fastify.inject({
      method: 'POST',
      url: '/api/decks',
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
      payload: { name: 'admin-created' },
    });
    expect(createDeck.statusCode).toBe(201);
  });

  it('bind-workspace rejects mismatched workspace root (WORKSPACE_SCOPE_MISMATCH)', async () => {
    const { fastify, session, otherDeck, store } = await buildApp();
    store.elevateSessionToAdmin(session.sessionId);

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/bind-workspace',
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
      payload: {
        workspaceRoot: '/totally/different/path',
        deckId: otherDeck.id,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: 'WORKSPACE_SCOPE_MISMATCH' });
  });

  it('C8 grant rotation revokes peer sessions (SESSION_REVOKED)', async () => {
    const { fastify, session, otherDeck, store, workspaceRoot } = await buildApp();
    const peer = store.createRuntimeSession({
      workspaceKeyId: session.workspaceKey,
      workspaceGrantId: session.workspaceGrantId,
      deckId: session.deckId,
    });
    store.elevateSessionToAdmin(session.sessionId);

    const bind = await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/bind-workspace',
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
      payload: { workspaceRoot, deckId: otherDeck.id },
    });
    expect(bind.statusCode).toBe(200);

    const peerRow = store.getRuntimeSessionRow(peer.sessionId);
    expect(peerRow?.revoked_at).toBeTruthy();

    const peerCall = await fastify.inject({
      method: 'GET',
      url: '/api/services',
      headers: { [AGENT_DECK_SESSION_HEADER]: peer.sessionId },
    });
    expect(peerCall.statusCode).toBe(401);
    expect(peerCall.json()).toMatchObject({ error_code: 'SESSION_REVOKED' });
  });

  it('lists pending admin challenges for menubar', async () => {
    const { fastify, session } = await buildApp();

    await fastify.inject({
      method: 'POST',
      url: '/api/trusted-session/admin/request-elevation',
      headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
      payload: { runtimeSessionId: session.sessionId },
    });

    const list = await fastify.inject({
      method: 'GET',
      url: '/api/trusted-session/admin/challenges',
    });
    expect(list.statusCode).toBe(200);
    const data = list.json().data as Array<{ challengeId: string; approvalPath: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].approvalPath).toContain('/admin/approve?challenge=');
  });
});
