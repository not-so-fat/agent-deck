import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { Service, WebSocketMessage } from '@agent-deck/shared';
import { installWebSocketBroadcasting, registerWebSocketRoutes } from './websocket';
import { startHealthReprobe, type HealthReprobeClock } from '../services/health-reprobe';

/**
 * Wiring-level coverage for root-scope broadcasting: mirrors how
 * `server/index.ts` installs the hub on the root instance and registers the
 * `/api/ws` routes as an encapsulated plugin.
 */
async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false });
  await fastify.register(websocket);
  const hub = installWebSocketBroadcasting(fastify);
  await fastify.register(registerWebSocketRoutes, { prefix: '/api/ws', hub });
  return fastify;
}

/** Open a WS client and collect every parsed message it receives. */
async function connect(fastify: FastifyInstance) {
  const messages: WebSocketMessage[] = [];
  // injectWS resolves once the server handler has registered the connection;
  // the pre-open welcome frame is not observable here, so listen afterwards.
  const ws = await fastify.injectWS('/api/ws/events');
  ws.on('message', (raw) => {
    messages.push(JSON.parse(raw.toString()) as WebSocketMessage);
  });
  const waitFor = async (type: string): Promise<WebSocketMessage> => {
    for (let i = 0; i < 100; i++) {
      const found = messages.find((m) => m.type === type);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no ${type} message received`);
  };
  return { ws, messages, waitFor };
}

describe('root-scope WebSocket broadcasting', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('delivers a root-scope broadcastServiceUpdate to WebSocket subscribers', async () => {
    app = await buildApp();
    await app.ready();
    const { ws, waitFor } = await connect(app);

    app.broadcastServiceUpdate({ serviceId: 'svc-1', health: 'healthy', isConnected: true });

    const update = await waitFor('service_update');
    expect(update.data).toMatchObject({ serviceId: 'svc-1', health: 'healthy' });
    ws.terminate();
  });

  it('delivers broadcasts from a sibling route plugin', async () => {
    app = await buildApp();
    await app.register(async (child) => {
      child.post('/poke', async () => {
        child.broadcastServiceUpdate({ serviceId: 'svc-2', health: 'unhealthy', isConnected: false });
        return { ok: true };
      });
    }, { prefix: '/api/other' });
    await app.ready();
    const { ws, waitFor } = await connect(app);

    await app.inject({ method: 'POST', url: '/api/other/poke' });

    const update = await waitFor('service_update');
    expect(update.data).toMatchObject({ serviceId: 'svc-2', health: 'unhealthy' });
    ws.terminate();
  });

  it('broadcasts a background health re-probe recovery to subscribers', async () => {
    app = await buildApp();
    await app.ready();
    const { ws, waitFor } = await connect(app);

    let tick: (() => Promise<void> | void) | undefined;
    const clock: HealthReprobeClock = {
      now: () => 0,
      setInterval: (cb) => {
        tick = cb;
        return { unref: () => {} };
      },
      clearInterval: () => {},
    };
    const service = {
      id: 'svc-3',
      name: 'svc-3',
      type: 'mcp',
      url: 'https://example.com/mcp',
      health: 'unhealthy',
      cardColor: '#000000',
      isConnected: false,
      registeredAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as Service;
    const fastify = app;
    // Same deps shape as server/index.ts.
    const stop = startHealthReprobe(
      {
        listServices: async () => [service],
        checkHealth: async () => ({ success: true, health: 'healthy', isConnected: true }),
        broadcast: (update) => fastify.broadcastServiceUpdate(update),
      },
      { clock },
    );

    await tick?.();

    const update = await waitFor('service_update');
    expect(update.data).toMatchObject({ serviceId: 'svc-3', health: 'healthy', isConnected: true });
    stop();
    ws.terminate();
  });
});
