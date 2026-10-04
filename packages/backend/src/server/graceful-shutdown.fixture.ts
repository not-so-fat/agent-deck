import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { installGracefulShutdown } from '../lib/graceful-shutdown';
import { createServer } from './index';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-shutdown-'));
process.env.AGENT_DECK_HOME = home;
process.env.AGENT_DECK_SECRET_STORE = 'memory';

async function run(): Promise<void> {
  const server = await createServer();
  server.get('/slow', async () => {
    process.send?.({ type: 'request-started' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { completed: true };
  });

  // Bind a real TCP listener so SIGTERM exercises the production drain path:
  // installGracefulShutdown calls server.close(), which must wait for the
  // live socket to finish. server.inject would bypass the listener entirely.
  await server.listen({ port: 0, host: '127.0.0.1' });
  const bound = server.server.address();
  const port = typeof bound === 'object' && bound ? bound.port : 0;
  if (!port) throw new Error('shutdown fixture listener did not report a port');

  let requestTask: Promise<void> | undefined;
  process.on('message', (message) => {
    if (message !== 'begin-request' || requestTask) return;
    requestTask = new Promise<void>((resolve) => {
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
            resolve();
          });
        },
      );
      request.on('error', (error) => {
        process.send?.({ type: 'request-failed', error: String(error) });
        resolve();
      });
    });
  });

  // Production-shaped close: exactly what src/index.ts passes
  // (server.close() only). The in-flight request is NOT awaited here; the
  // drain is proven by close() itself waiting for the live socket.
  installGracefulShutdown({
    label: 'backend',
    close: async () => {
      await server.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  });
  process.send?.({ type: 'ready', port });
}

void run().catch((error) => {
  // Surface startup failures (for example the listener bind) to the parent
  // test instead of dying silent before the first IPC message.
  process.send?.({ type: 'request-failed', error: String(error) });
  process.exitCode = 1;
});
