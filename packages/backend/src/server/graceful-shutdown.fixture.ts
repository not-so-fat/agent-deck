import http from 'node:http';

import { installGracefulShutdown } from '../lib/graceful-shutdown';

const server = http.createServer((request, response) => {
  if (request.url !== '/slow') {
    response.writeHead(404).end();
    return;
  }
  process.send?.({ type: 'request-started' });
  setTimeout(() => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ completed: true }));
  }, 150);
});

server.once('error', (error: NodeJS.ErrnoException) => {
  process.send?.({ type: 'listen-error', code: error.code });
  process.exitCode = 77;
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (typeof address === 'object' && address) {
    process.send?.({ type: 'ready', port: address.port });
  }
});

installGracefulShutdown({
  label: 'backend',
  close: () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }),
});
