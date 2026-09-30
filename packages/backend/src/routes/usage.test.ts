import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { DatabaseManager } from '../models/database';
import { registerUsageRoutes } from './usage';

const PUBLIC_KEYS = [
  'action',
  'cardId',
  'cardType',
  'deckId',
  'occurredAt',
  'sessionId',
  'source',
  'success',
].sort();

describe('GET /api/usage/events (NOT-292)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const db = new DatabaseManager(':memory:');
    const fastify = Fastify();
    fastify.decorate('db', db);
    await fastify.register(registerUsageRoutes, { prefix: '/api/usage' });
    await fastify.ready();
    servers.push(fastify);
    return { fastify, db };
  }

  async function seed(db: DatabaseManager) {
    await db.recordCardUsageEvent({
      cardType: 'service',
      cardId: 'svc-1',
      deckId: 'deck-1',
      action: 'tool_call',
      success: true,
      source: 'ide',
      sessionId: 'sess-1',
      occurredAt: '2026-09-10T10:00:00.000Z',
    });
    await db.recordCardUsageEvent({
      cardType: 'credential',
      cardId: 'cred-1',
      action: 'service_call',
      success: true,
      source: 'ide',
      occurredAt: '2026-09-10T10:00:01.000Z',
    });
    await db.recordCardUsageEvent({
      cardType: 'playbook',
      cardId: 'pb-1',
      action: 'fetch',
      success: null,
      source: 'agent',
      occurredAt: '2026-09-10T10:00:02.000Z',
    });
  }

  it('returns only the privacy-safe public fields', async () => {
    const { fastify, db } = await buildApp();
    await seed(db);

    const response = await fastify.inject({
      method: 'GET',
      url: '/api/usage/events?from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.nextCursor).toBeNull();
    expect(body.data.events).toEqual([
      {
        occurredAt: '2026-09-10T10:00:00.000Z',
        cardType: 'service',
        cardId: 'svc-1',
        deckId: 'deck-1',
        action: 'tool_call',
        success: true,
        source: 'ide',
        sessionId: 'sess-1',
      },
      {
        occurredAt: '2026-09-10T10:00:01.000Z',
        cardType: 'credential',
        cardId: 'cred-1',
        deckId: null,
        action: 'service_call',
        success: true,
        source: 'ide',
        sessionId: null,
      },
      {
        occurredAt: '2026-09-10T10:00:02.000Z',
        cardType: 'playbook',
        cardId: 'pb-1',
        deckId: null,
        action: 'fetch',
        success: null,
        source: 'agent',
        sessionId: null,
      },
    ]);
    for (const event of body.data.events) {
      expect(Object.keys(event).sort()).toEqual(PUBLIC_KEYS);
    }
    const serialized = JSON.stringify(body.data.events);
    expect(serialized).not.toMatch(/argument|result|command|url|header|oauth|secret|key/i);
  });

  it('defaults to the trailing 30 days', async () => {
    const { fastify, db } = await buildApp();
    const recentAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const oldAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await db.recordCardUsageEvent({
      cardType: 'service',
      cardId: 'svc-recent',
      action: 'tool_call',
      source: 'agent',
      occurredAt: recentAt,
    });
    await db.recordCardUsageEvent({
      cardType: 'service',
      cardId: 'svc-old',
      action: 'tool_call',
      source: 'agent',
      occurredAt: oldAt,
    });

    const response = await fastify.inject({ method: 'GET', url: '/api/usage/events' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.events.map((event: { cardId: string }) => event.cardId)).toEqual([
      'svc-recent',
    ]);
  });

  it('walks pages in order with the opaque cursor', async () => {
    const { fastify, db } = await buildApp();
    await seed(db);

    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const url =
        '/api/usage/events?from=2026-09-01T00:00:00.000Z&to=2026-09-30T00:00:00.000Z&limit=1' +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const response = await fastify.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.events).toHaveLength(1);
      seen.push(body.data.events[0].cardId);
      cursor = body.data.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(seen).toEqual(['svc-1', 'cred-1', 'pb-1']);
  });

  it.each([
    ['bad from', '/api/usage/events?from=not-a-date'],
    ['bad to', '/api/usage/events?to=2026-13-99'],
    ['from after to', '/api/usage/events?from=2026-09-30T00:00:00.000Z&to=2026-09-01T00:00:00.000Z'],
    ['limit zero', '/api/usage/events?limit=0'],
    ['limit too large', '/api/usage/events?limit=251'],
    ['limit not a number', '/api/usage/events?limit=many'],
    ['limit fractional', '/api/usage/events?limit=2.5'],
    ['bad cursor', '/api/usage/events?cursor=bogus!!'],
  ])('rejects %s with 400', async (_label, url) => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json().success).toBe(false);
  });

  it('accepts the boundary limit values', async () => {
    const { fastify, db } = await buildApp();
    await seed(db);
    for (const limit of ['1', '250']) {
      const response = await fastify.inject({
        method: 'GET',
        url: `/api/usage/events?limit=${limit}`,
      });
      expect(response.statusCode).toBe(200);
    }
  });
});
