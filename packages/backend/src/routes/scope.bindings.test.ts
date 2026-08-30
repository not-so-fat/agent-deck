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
  updatedAt: '2026-07-03T00:00:00.000Z',
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
    expect(rows[0].lastActivityAt).toBe('2026-07-03T00:00:00.000Z');
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

    const touched = await app.inject({
      method: 'POST',
      url: '/api/scope/live-display/session-1/touch',
      headers: agentHeaders,
      payload: { at: '2026-07-03T00:10:00.000Z' },
    });
    expect(touched.statusCode).toBe(200);

    const rows = (await app.inject({ method: 'GET', url: '/api/scope/bindings' })).json().data;
    expect(rows[0].lastActivityAt).toBe('2026-07-03T00:10:00.000Z');
  });
});
