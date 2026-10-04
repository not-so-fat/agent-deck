import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditStore } from '../audit/store';
import { DatabaseManager } from '../models/database';
import { dashboardAuthHeaders } from '../test/auth-fixtures';
import { registerHttpPolicyHook } from '../trusted-session/policy-hook';
import { TrustedSessionStore } from '../trusted-session/store';
import { registerAuditRoutes } from './audit';

describe('GET /api/audit', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => { while (apps.length) await apps.pop()?.close(); });

  async function app() {
    const fastify = Fastify();
    const db = new DatabaseManager(':memory:');
    const sessions = new TrustedSessionStore(db.getSqliteDatabase());
    const audit = new AuditStore(db.getSqliteDatabase());
    fastify.decorate('db', db);
    fastify.decorate('trustedSessionStore', sessions);
    fastify.decorate('auditStore', audit);
    registerHttpPolicyHook(fastify);
    await fastify.register(registerAuditRoutes, { prefix: '/api' });
    await fastify.ready();
    apps.push(fastify);
    return { fastify, sessions, audit };
  }

  it('requires an owner session and exposes secret-free newest-first paging', async () => {
    const { fastify, sessions, audit } = await app();
    const sentinel = 'SENTINEL_AUTH_TOKEN_AND_TOOL_PAYLOAD';
    audit.append({ actor: 'owner', event: 'grant.created', targetId: 'ag_old', outcome: 'succeeded', reasonCode: null });
    audit.append({ actor: 'owner', event: 'grant.revoked', targetId: 'ag_new', outcome: 'succeeded', reasonCode: null });

    const unauthorized = await fastify.inject({
      method: 'GET', url: '/api/audit', headers: { authorization: `Bearer ${sentinel}` },
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.body).not.toContain(sentinel);

    const page = await fastify.inject({
      method: 'GET', url: '/api/audit?limit=1', headers: dashboardAuthHeaders(sessions),
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().data).toHaveLength(1);
    expect(page.json().data[0].targetId).toBe('ag_new');
    expect(page.body).not.toContain(sentinel);

    const next = await fastify.inject({
      method: 'GET',
      url: `/api/audit?limit=1&before=${page.json().paging.nextBefore}`,
      headers: dashboardAuthHeaders(sessions),
    });
    expect(next.json().data[0].targetId).toBe('ag_old');
  });
});

