import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_DECK_AGENT_CLIENT, AGENT_DECK_CLIENT_HEADER } from '@agent-deck/shared';
import { LiveDisplayRegistry } from '../scope/live-display-registry';
import type { TrustedSessionStore } from '../trusted-session/store';
import { registerScopeRoutes } from './scope';

const agentHeaders = { [AGENT_DECK_CLIENT_HEADER]: AGENT_DECK_AGENT_CLIENT };

const liveDisplayBody = {
  mcpSessionId: 'session-1',
  workspaceRoot: '/repo',
  deckId: '11111111-1111-4111-8111-111111111111',
  deckName: 'Product Design',
  source: 'session_override',
  clientName: 'cursor',
  cardCounts: { mcp: 4, credentials: 0, playbooks: 6 },
  // NOT-309: fixtures model live sessions, so they stay inside the stale bound.
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
};

async function buildApp() {
  const app = Fastify();
  app.decorate('db', {} as never);
  app.decorate('liveDisplayRegistry', new LiveDisplayRegistry());
  app.decorate('trustedSessionStore', {
    getRuntimeSessionModeByMcpSessionId: () => null,
    getRuntimeSessionModesByMcpSessionIds: () => new Map(),
  } as unknown as TrustedSessionStore);
  await app.register(registerScopeRoutes, { prefix: '/api/scope' });
  return app;
}

describe('scope bindings routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app.close();
  });

  it('POST /live-display accepts launch source from launch-selected sessions', async () => {
    app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/scope/live-display',
      headers: agentHeaders,
      payload: { ...liveDisplayBody, source: 'launch' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.badge).toBeTruthy();

    const rows = (await app.inject({ method: 'GET', url: '/api/scope/bindings' })).json().data;
    expect(rows[0].source).toBe('launch');
  });

  it('POST /live-display returns the assigned badge and keeps it stable', async () => {
    app = await buildApp();
    const first = await app.inject({
      method: 'POST',
      url: '/api/scope/live-display',
      headers: agentHeaders,
      payload: liveDisplayBody,
    });
    expect(first.statusCode).toBe(200);
    const badge = first.json().data.badge as string;
    expect(badge).toBeTruthy();

    const again = await app.inject({
      method: 'POST',
      url: '/api/scope/live-display',
      headers: agentHeaders,
      payload: { ...liveDisplayBody, deckName: 'Other Deck' },
    });
    expect(again.json().data.badge).toBe(badge);
  });

  it('GET /bindings lists live sessions without mcpSessionId', async () => {
    app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/scope/live-display',
      headers: agentHeaders,
      payload: liveDisplayBody,
    });

    const response = await app.inject({ method: 'GET', url: '/api/scope/bindings' });
    expect(response.statusCode).toBe(200);
    const rows = response.json().data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].deckName).toBe('Product Design');
    expect(rows[0].clientName).toBe('cursor');
    expect(rows[0].badge).toBeTruthy();
    expect(rows[0].lastActivityAt).toBe(liveDisplayBody.updatedAt);
    expect(rows[0]).not.toHaveProperty('mcpSessionId');
  });

  it('POST touch bumps lastActivityAt and requires agent client', async () => {
    app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/scope/live-display',
      headers: agentHeaders,
      payload: liveDisplayBody,
    });

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/scope/live-display/session-1/touch',
      payload: { at: '2026-07-03T00:10:00.000Z' },
    });
    expect(forbidden.statusCode).toBe(403);

    const touchAt = new Date().toISOString();
    const touched = await app.inject({
      method: 'POST',
      url: '/api/scope/live-display/session-1/touch',
      headers: agentHeaders,
      payload: { at: touchAt },
    });
    expect(touched.statusCode).toBe(200);
    expect(touched.json().data.found).toBe(true);

    const rows = (await app.inject({ method: 'GET', url: '/api/scope/bindings' })).json().data;
    expect(rows[0].lastActivityAt).toBe(touchAt);
  });

  it('NOT-309 repair round 2: touch reports found:false for a swept/unknown session', async () => {
    app = await buildApp();
    const miss = await app.inject({
      method: 'POST',
      url: '/api/scope/live-display/ghost-session/touch',
      headers: agentHeaders,
      payload: { at: new Date().toISOString() },
    });
    expect(miss.statusCode).toBe(200);
    expect(miss.json().data.found).toBe(false);
  });

  it('NOT-309: GET /bindings omits entries older than the stale bound', async () => {
    app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/api/scope/live-display',
      headers: agentHeaders,
      payload: liveDisplayBody,
    });
    const stale = await app.inject({
      method: 'POST',
      url: '/api/scope/live-display',
      headers: agentHeaders,
      payload: {
        ...liveDisplayBody,
        mcpSessionId: 'session-killed',
        deckName: 'Killed Deck',
        updatedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
      },
    });
    expect(stale.statusCode).toBe(200);

    const response = await app.inject({ method: 'GET', url: '/api/scope/bindings' });
    expect(response.statusCode).toBe(200);
    const rows = response.json().data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].deckName).toBe('Product Design');
  });
});
