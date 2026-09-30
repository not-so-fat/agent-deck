import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CardUsageCardType } from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { resolveRoutePolicy } from '../trusted-session/route-policy-registry';
import { registerUsageRoutes } from './usage';

// Frozen clock: the endpoint derives its fixed trailing-30-day window from it.
const NOW = new Date('2026-09-30T00:00:00.000Z');
const WINDOW_START = '2026-08-31T00:00:00.000Z';
const WINDOW_END = '2026-09-30T00:00:00.000Z';
const OLD = '2026-08-01T00:00:00.000Z'; // 60 days ago: fully observed
const YOUNG_COVERAGE = '2026-09-20T00:00:00.000Z'; // 10 days ago: not fully observed

const T1 = '2026-09-05T10:00:00.000Z';
const T2 = '2026-09-10T10:00:00.000Z';
const T3 = '2026-09-15T10:00:00.000Z';
const T4 = '2026-09-20T10:00:00.000Z';
const T5 = '2026-09-25T10:00:00.000Z';
const BEFORE_WINDOW = '2026-08-30T23:59:59.999Z';

describe('GET /api/usage/cards (NOT-293)', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    while (servers.length) {
      await servers.pop()?.close();
    }
    vi.useRealTimers();
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

  function backdateCard(db: DatabaseManager, cardType: CardUsageCardType, cardId: string) {
    const sqlite = db.getSqliteDatabase();
    const table =
      cardType === 'service' ? 'services' : cardType === 'credential' ? 'credentials' : 'playbooks';
    const column = cardType === 'service' ? 'registered_at' : 'created_at';
    sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run(OLD, cardId);
  }

  function setObservationStart(db: DatabaseManager, cardType: CardUsageCardType, start: string) {
    db.getSqliteDatabase()
      .prepare('UPDATE store_meta SET value = ? WHERE key = ?')
      .run(start, `card_usage_observed_from:${cardType}`);
  }

  async function record(
    db: DatabaseManager,
    cardType: CardUsageCardType,
    cardId: string,
    occurredAt: string,
    success: boolean | null = true,
  ) {
    await db.recordCardUsageEvent({
      cardType,
      cardId,
      action: 'tool_call',
      success,
      source: 'agent',
      occurredAt,
    });
  }

  async function seed(db: DatabaseManager) {
    // Fully observed coverage for services and playbooks; young credential
    // coverage so credential rows exercise the New observation guard.
    setObservationStart(db, 'service', OLD);
    setObservationStart(db, 'playbook', OLD);
    setObservationStart(db, 'credential', YOUNG_COVERAGE);

    for (const name of ['svc-pop-1', 'svc-pop-2', 'svc-used', 'svc-unused']) {
      const service = await db.createService({
        name,
        type: 'mcp',
        url: 'http://127.0.0.1:9/mcp',
      });
      // Services get generated ids: rename to the fixture id and backdate
      // to full observation coverage in one statement.
      db.getSqliteDatabase()
        .prepare('UPDATE services SET id = ?, registered_at = ? WHERE id = ?')
        .run(name, OLD, service.id);
    }
    const svcNew = await db.createService({
      name: 'svc-new',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp',
    });
    db.getSqliteDatabase().prepare('UPDATE services SET id = ? WHERE id = ?').run(
      'svc-new',
      svcNew.id,
    );

    for (const id of ['cred-old', 'cred-unused']) {
      await db.createCredential({
        id,
        label: id,
        scheme: 'bearer',
        envName: 'TEST_API_KEY',
        keychainAccount: id,
        tags: [],
        hasSecret: false,
      });
      backdateCard(db, 'credential', id);
    }

    for (const id of ['pb-unused']) {
      await db.createPlaybook({ id, title: id, body: '', triggers: [] });
      backdateCard(db, 'playbook', id);
    }
    await db.createPlaybook({ id: 'pb-new', title: 'pb-new', body: '', triggers: [] });

    // Tied leaders: identical counts classify identically.
    for (const at of [T1, T2, T3, T4, T5]) {
      await record(db, 'service', 'svc-pop-1', at);
      await record(db, 'service', 'svc-pop-2', at);
    }
    // Only the window-start success counts: failures, unknowns, the
    // window-end instant, and pre-window events are all excluded.
    await record(db, 'service', 'svc-used', WINDOW_START);
    await record(db, 'service', 'svc-used', T3, false);
    await record(db, 'service', 'svc-used', T4, null);
    await record(db, 'service', 'svc-used', WINDOW_END);
    await record(db, 'service', 'svc-used', BEFORE_WINDOW);
    // Window-end success on an otherwise unused card stays excluded.
    await record(db, 'service', 'svc-unused', WINDOW_END);

    await record(db, 'credential', 'cred-old', T2);
    await record(db, 'credential', 'cred-old', T4);
    await record(db, 'playbook', 'pb-new', T3);

    // Historical events for deleted cards never surface as rows.
    for (const at of [T1, T2, T3, T4, T5]) {
      await record(db, 'service', 'svc-gone', at);
    }
    await record(db, 'service', 'svc-gone', T1, false);
    await record(db, 'playbook', 'pb-gone', T2);
  }

  function row(overrides: Record<string, unknown>) {
    return {
      usageCount: 0,
      lastUsedAt: null,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      ...overrides,
    };
  }

  it('returns every current card exactly once with exact categories, counts, and timestamps', async () => {
    const { fastify, db } = await buildApp();
    await seed(db);

    const response = await fastify.inject({ method: 'GET', url: '/api/usage/cards' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.data.cards).toEqual([
      row({
        cardType: 'credential',
        cardId: 'cred-old',
        category: 'new',
        usageCount: 2,
        lastUsedAt: T4,
        observedSince: YOUNG_COVERAGE,
      }),
      row({
        cardType: 'credential',
        cardId: 'cred-unused',
        category: 'new',
        observedSince: YOUNG_COVERAGE,
      }),
      row({
        cardType: 'playbook',
        cardId: 'pb-new',
        category: 'new',
        usageCount: 1,
        lastUsedAt: T3,
        observedSince: OLD,
      }),
      row({
        cardType: 'playbook',
        cardId: 'pb-unused',
        category: 'unused',
        observedSince: OLD,
      }),
      row({
        cardType: 'service',
        cardId: 'svc-new',
        category: 'new',
        observedSince: OLD,
      }),
      row({
        cardType: 'service',
        cardId: 'svc-pop-1',
        category: 'popular',
        usageCount: 5,
        lastUsedAt: T5,
        observedSince: OLD,
      }),
      row({
        cardType: 'service',
        cardId: 'svc-pop-2',
        category: 'popular',
        usageCount: 5,
        lastUsedAt: T5,
        observedSince: OLD,
      }),
      row({
        cardType: 'service',
        cardId: 'svc-unused',
        category: 'unused',
        observedSince: OLD,
      }),
      row({
        cardType: 'service',
        cardId: 'svc-used',
        category: 'used',
        usageCount: 1,
        lastUsedAt: WINDOW_START,
        observedSince: OLD,
      }),
    ]);

    // Stable under the frozen clock: a second read is identical.
    const replay = await fastify.inject({ method: 'GET', url: '/api/usage/cards' });
    expect(replay.json()).toEqual(body);
  });

  it('returns an empty list when the collection has no cards', async () => {
    const { fastify } = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/api/usage/cards' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true, data: { cards: [] } });
  });

  it('is covered by the app route policy as agent-or-dashboard', () => {
    expect(resolveRoutePolicy('GET', '/api/usage/cards')).toBe('requireAgentOrDashboard');
  });
});
