import Fastify from 'fastify';

import { installGracefulShutdown, trackInFlightRequests } from '../lib/graceful-shutdown';

async function run(): Promise<void> {
  // Bare Fastify instance on purpose: the full createServer() boots the
  // entire backend (SQLite, seeding, icon backfill with outbound fetches,
  // every route plugin and hook), which made this timing-sensitive test
  // flaky in CI. The mechanism under test is installGracefulShutdown plus
  // the production close call — server.close() with the shared
  // trackInFlightRequests drain, identical to src/index.ts — draining a
  // real in-flight HTTP connection. This fixture keeps all of that and
  // drops only the unrelated app stack.
  const server = Fastify({ logger: false });

  // Tracked in-flight drain shared with production src/index.ts: CI lost
  // the in-flight /slow request with ECONNRESET on the client (and logged
  // shutdown_complete ~1ms after shutdown_started in an earlier revision),
  // so the shutdown close must not rely on server.close() alone to observe
  // the live handler. The outer shutdown deadline in
  // installGracefulShutdown still bounds this wait.
  const waitForDrain = trackInFlightRequests(server);

  server.get('/slow', async () => {
    process.send?.({ type: 'request-started' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { completed: true };
  });

  // Bind a real TCP listener so SIGTERM exercises the real drain path:
  // installGracefulShutdown calls server.close(), which must wait for the
  // live socket to finish.
  //
  // The HTTP client lives in the parent test process (not here): the
  // fixture used to request itself, so process.exit(0) after close()
  // could kill the same-process client before it reported completion —
  // a race CI lost. An out-of-process client is also the production
  // shape: external clients are unaffected by our exit.
  await server.listen({ port: 0, host: '127.0.0.1' });
  const bound = server.server.address();
  const port = typeof bound === 'object' && bound ? bound.port : 0;
  if (!port) throw new Error('shutdown fixture listener did not report a port');

  // Production close, identical to src/index.ts: server.close() stops
  // accepting and releases the listener, and the shared tracked in-flight
  // drain is additionally awaited so process exit cannot precede the
  // response even if server.close() resolves early.
  installGracefulShutdown({
    label: 'backend',
    close: async () => {
      const closing = server.close();
      await waitForDrain();
      await closing;
    },
  });
  process.send?.({ type: 'ready', port });
}

void run().catch((error) => {
  // Surface startup failures (for example the listener bind) to the parent
  // test instead of dying silent before the first IPC message.
  process.send?.({ type: 'startup-failed', error: String(error) });
  process.exitCode = 1;
});
