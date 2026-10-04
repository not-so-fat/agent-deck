import fs from 'node:fs';
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

  await server.ready();
  let requestTask: Promise<void> | undefined;
  process.on('message', (message) => {
    if (message !== 'begin-request' || requestTask) return;
    requestTask = server.inject({ method: 'GET', url: '/slow' }).then((response) => {
      process.send?.({
        type: 'request-completed',
        statusCode: response.statusCode,
        body: response.json(),
      });
    });
  });

  installGracefulShutdown({
    label: 'backend',
    close: async () => {
      await server.close();
      await requestTask;
      fs.rmSync(home, { recursive: true, force: true });
    },
  });
  process.send?.({ type: 'ready' });
}

void run();
