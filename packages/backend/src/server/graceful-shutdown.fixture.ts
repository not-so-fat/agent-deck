import Fastify from 'fastify';
import http from 'node:http';

import { installGracefulShutdown } from '../lib/graceful-shutdown';

async function run(): Promise<void> {
  // Bare Fastify instance on purpose: the full createServer() boots the
  // entire backend (SQLite, seeding, icon backfill with outbound fetches,
  // every route plugin and hook), which made this timing-sensitive test
  // flaky in CI. The mechanism under test is installGracefulShutdown plus
  // the production close call — server.close(), identical to src/index.ts —
  // draining a real in-flight HTTP connection. This fixture keeps all of
  // that and drops only the unrelated app stack.
  const server = Fastify({ logger: false });

  server.get('/slow', async () => {
    process.send?.({ type: 'request-started' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { completed: true };
  });

  // Bind a real TCP listener so SIGTERM exercises the real drain path:
  // installGracefulShutdown calls server.close(), which must wait for the
  // live socket to finish. server.inject would bypass the listener entirely.
  await server.listen({ port: 0, host: '127.0.0.1' });
  const bound = server.server.address();
  const port = typeof bound === 'object' && bound ? bound.port : 0;
  if (!port) throw new Error('shutdown fixture listener did not report a port');

  let begun = false;
  process.on('message', (message) => {
    if (message !== 'begin-request' || begun) return;
    begun = true;
    // No keep-alive agent: the socket closes after the response, so
    // server.close() drains on request completion instead of hanging on
    // an idle keep-alive connection.
    const request = http.get(
      { host: '127.0.0.1', port, path: '/slow', agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          let body: unknown = Buffer.concat(chunks).toString('utf8');
          try {
            body = JSON.parse(body as string);
          } catch {
            // Keep the raw text so the parent can report it.
          }
          process.send?.({
            type: 'request-completed',
            statusCode: response.statusCode,
            body,
          });
        });
        response.on('error', (error) => {
          process.send?.({ type: 'request-failed', error: String(error) });
        });
      },
    );
    request.on('error', (error) => {
      process.send?.({ type: 'request-failed', error: String(error) });
    });
  });

  // Production-shaped close: exactly what src/index.ts passes
  // (server.close() only). The in-flight request is NOT awaited here; the
  // drain is proven by close() itself waiting for the live socket.
  installGracefulShutdown({
    label: 'backend',
    close: () => server.close(),
  });
  process.send?.({ type: 'ready', port });
}

void run().catch((error) => {
  // Surface startup failures (for example the listener bind) to the parent
  // test instead of dying silent before the first IPC message.
  process.send?.({ type: 'request-failed', error: String(error) });
  process.exitCode = 1;
});
