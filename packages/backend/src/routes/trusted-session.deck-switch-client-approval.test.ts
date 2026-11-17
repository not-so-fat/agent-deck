/**
 * NOT-632: client-approved deck-switch commits (AGENT_DECK_DECK_SWITCH_APPROVAL
 * =client) on the resolve route, and the absolute approvalUrl on every
 * pending creation response.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AGENT_DECK_SESSION_HEADER, AGENT_DECK_WORKSPACE_HEADER } from '@agent-deck/shared';

import { AuditStore } from '../audit/store';
import { deckSwitchApprovalUrl, resolveApprovalBaseUrl } from '../lib/deck-switch-approval-url';
import { DatabaseManager } from '../models/database';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { registerTrustedSessionRoutes } from './trusted-session';

const URL_ENV = ['AGENT_DECK_PUBLIC_URL', 'AGENT_DECK_DASHBOARD_URL', 'AGENT_DECK_UI_DIST', 'HOST', 'PORT'] as const;

describe('deck-switch client approval and approval links (NOT-632)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(URL_ENV.map((key) => [key, process.env[key]]));
    for (const key of URL_ENV) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of URL_ENV) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const deckA = await db.createDeck({ name: 'deck-a' });
    const deckB = await db.createDeck({ name: 'deck-b' });
    const store = new TrustedSessionStore(db.getSqliteDatabase());
    const audit = new AuditStore(db.getSqliteDatabase());

    const fastify = Fastify();
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', store);
    fastify.decorate('auditStore', audit);
    registerHttpPolicyHook(fastify);
    await fastify.register(registerTrustedSessionRoutes, { prefix: '/api/trusted-session' });
    await fastify.ready();
    servers.push(fastify);
    return { fastify, store, audit, deckA, deckB };
  }

  function resolve(
    fastify: Awaited<ReturnType<typeof buildApp>>['fastify'],
    store: TrustedSessionStore,
    requestId: string,
    payload: Record<string, unknown>,
  ) {
    return fastify.inject({
      method: 'POST',
      url: `/api/trusted-session/deck-switch/${requestId}/resolve`,
      headers: dashboardAuthHeaders(store),
      payload,
    });
  }

  function auditEvents(audit: AuditStore) {
    return audit.list({ limit: 50 }).filter((entry) => entry.event === 'deck_switch.approved');
  }

  describe('resolve with approvedVia=client', () => {
    it('commits a local session-only switch and records it as client-approved', async () => {
      const { fastify, store, audit, deckA, deckB } = await buildApp();
      const session = store.createRuntimeSession({ deckId: deckA.id });
      const request = store.createDeckSwitchRequest({
        runtimeSessionId: session.sessionId,
        currentDeckId: deckA.id,
        requestedDeckId: deckB.id,
      });

      const response = await resolve(fastify, store, request.requestId, {
        runtimeSessionId: session.sessionId,
        decision: 'session',
        approvedVia: 'client',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        status: 'consumed',
        decision: 'session',
        deckId: deckB.id,
        approvedVia: 'client',
      });
      expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckB.id);
      expect(store.listPendingDeckSwitchRequests(session.sessionId)).toHaveLength(0);
      expect(auditEvents(audit)).toEqual([
        expect.objectContaining({
          actor: 'local-launch',
          event: 'deck_switch.approved',
          targetId: deckB.id,
          outcome: 'succeeded',
          reasonCode: 'client_approved',
        }),
      ]);
    });

    it('rejects a workspace-default decision and changes nothing', async () => {
      const { fastify, store, audit, deckA, deckB } = await buildApp();
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-client-approval-'));
      const session = store.createRuntimeSession({ deckId: deckA.id });
      const request = store.createDeckSwitchRequest({
        runtimeSessionId: session.sessionId,
        currentDeckId: deckA.id,
        requestedDeckId: deckB.id,
        workspaceRoot,
      });

      const response = await resolve(fastify, store, request.requestId, {
        runtimeSessionId: session.sessionId,
        decision: 'workspace-default',
        approvedVia: 'client',
      });

      expect(response.statusCode).toBe(400);
      expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
      expect(store.listPendingDeckSwitchRequests(session.sessionId)).toHaveLength(1);
      expect(fs.existsSync(path.join(workspaceRoot, '.agent-deck', 'use.json'))).toBe(false);
      expect(auditEvents(audit)).toHaveLength(0);
    });

    it('rejects a remote-grant (bearer) session and changes nothing', async () => {
      const { fastify, store, audit, deckA, deckB } = await buildApp();
      const session = store.createRuntimeSession({ deckId: deckA.id, grantId: 'ag_remote' });
      const request = store.createDeckSwitchRequest({
        runtimeSessionId: session.sessionId,
        currentDeckId: deckA.id,
        requestedDeckId: deckB.id,
      });

      const response = await resolve(fastify, store, request.requestId, {
        runtimeSessionId: session.sessionId,
        decision: 'session',
        approvedVia: 'client',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('RESOURCE_OUT_OF_SCOPE');
      expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
      expect(store.listPendingDeckSwitchRequests(session.sessionId)).toHaveLength(1);
      expect(auditEvents(audit)).toHaveLength(0);
    });

    it('rejects any other approvedVia value', async () => {
      const { fastify, store, deckA, deckB } = await buildApp();
      const session = store.createRuntimeSession({ deckId: deckA.id });
      const request = store.createDeckSwitchRequest({
        runtimeSessionId: session.sessionId,
        currentDeckId: deckA.id,
        requestedDeckId: deckB.id,
      });
      const response = await resolve(fastify, store, request.requestId, {
        runtimeSessionId: session.sessionId,
        decision: 'session',
        approvedVia: 'agent',
      });
      expect(response.statusCode).toBe(400);
      expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    });

    it('still needs dashboard authentication: an agent cannot self-approve', async () => {
      const { fastify, store, deckA, deckB } = await buildApp();
      const session = store.createRuntimeSession({ deckId: deckA.id });
      const request = store.createDeckSwitchRequest({
        runtimeSessionId: session.sessionId,
        currentDeckId: deckA.id,
        requestedDeckId: deckB.id,
      });
      const response = await fastify.inject({
        method: 'POST',
        url: `/api/trusted-session/deck-switch/${request.requestId}/resolve`,
        headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
        payload: { runtimeSessionId: session.sessionId, decision: 'session', approvedVia: 'client' },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(401);
      expect(response.statusCode).toBeLessThan(404);
      expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    });

    it('a human approval without the marker writes no client-approved entry', async () => {
      const { fastify, store, audit, deckA, deckB } = await buildApp();
      const session = store.createRuntimeSession({ deckId: deckA.id });
      const request = store.createDeckSwitchRequest({
        runtimeSessionId: session.sessionId,
        currentDeckId: deckA.id,
        requestedDeckId: deckB.id,
      });
      const response = await resolve(fastify, store, request.requestId, {
        runtimeSessionId: session.sessionId,
        decision: 'session',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).not.toHaveProperty('approvedVia');
      expect(auditEvents(audit)).toHaveLength(0);
    });
  });

  describe('approvalUrl on pending creation', () => {
    async function createPending(headers: Record<string, string> = {}) {
      const app = await buildApp();
      const session = app.store.createRuntimeSession({ deckId: app.deckA.id });
      const response = await app.fastify.inject({
        method: 'POST',
        url: '/api/trusted-session/deck-switch',
        headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId, ...headers },
        payload: { target: 'deck-b' },
      });
      expect(response.statusCode).toBe(200);
      return { data: response.json().data, sessionId: session.sessionId };
    }

    it('uses AGENT_DECK_PUBLIC_URL when set', async () => {
      process.env.AGENT_DECK_PUBLIC_URL = 'https://deck.example.test/';
      const { data, sessionId } = await createPending();
      expect(data.status).toBe('pending');
      expect(data.approvalUrl).toBe(
        `https://deck.example.test/deck-switch/approve?request=${encodeURIComponent(data.requestId)}&session=${encodeURIComponent(sessionId)}`,
      );
      expect(data.message).toContain(data.approvalUrl);
    });

    it('falls back to the local dashboard origin', async () => {
      const { data, sessionId } = await createPending({ [AGENT_DECK_WORKSPACE_HEADER]: '/work/bound' });
      expect(data.approvalUrl).toBe(
        `http://localhost:3000/deck-switch/approve?request=${encodeURIComponent(data.requestId)}&session=${encodeURIComponent(sessionId)}`,
      );
      expect(new URL(data.approvalUrl).protocol).toBe('http:');
      expect(data.message).toContain(data.approvalUrl);
    });

    it('carries no approvalUrl when no request was opened', async () => {
      const app = await buildApp();
      const session = app.store.createRuntimeSession({ deckId: app.deckA.id });
      const response = await app.fastify.inject({
        method: 'POST',
        url: '/api/trusted-session/deck-switch',
        headers: { [AGENT_DECK_SESSION_HEADER]: session.sessionId },
        payload: { target: 'deck-a' },
      });
      expect(response.json().data.status).toBe('already_on_deck');
      expect(response.json().data).not.toHaveProperty('approvalUrl');
    });
  });

  describe('resolveApprovalBaseUrl', () => {
    it('prefers a valid public URL, keeping a path prefix', () => {
      expect(resolveApprovalBaseUrl({ AGENT_DECK_PUBLIC_URL: 'https://host.example/deck/' })).toBe(
        'https://host.example/deck',
      );
    });

    it('ignores a malformed or non-http public URL', () => {
      expect(resolveApprovalBaseUrl({ AGENT_DECK_PUBLIC_URL: 'not a url' })).toBe('http://localhost:3000');
      expect(resolveApprovalBaseUrl({ AGENT_DECK_PUBLIC_URL: 'ftp://host.example' })).toBe('http://localhost:3000');
    });

    it('uses the dashboard URL override, then the bundled UI host, with wildcard binds mapped to loopback', () => {
      process.env.AGENT_DECK_DASHBOARD_URL = 'http://127.0.0.1:1111/';
      expect(resolveApprovalBaseUrl({})).toBe('http://127.0.0.1:1111');
      delete process.env.AGENT_DECK_DASHBOARD_URL;

      process.env.AGENT_DECK_UI_DIST = os.tmpdir();
      process.env.HOST = '0.0.0.0';
      process.env.PORT = '8123';
      expect(resolveApprovalBaseUrl({})).toBe('http://127.0.0.1:8123');
    });

    it('builds an absolute link with encoded ids', () => {
      expect(deckSwitchApprovalUrl('req a', 'rs/b', { AGENT_DECK_PUBLIC_URL: 'https://h.example' })).toBe(
        'https://h.example/deck-switch/approve?request=req%20a&session=rs%2Fb',
      );
    });
  });
});
