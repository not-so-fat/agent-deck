#!/usr/bin/env node
/**
 * Controlled HTTP read/write endpoint for NOT-672 operator acceptance.
 *
 * Loopback-only. Implements the fixture surface the worker-profile briefs
 * probe:
 * - GET  /read    → 200 { ok: true, note }              (read)
 * - POST /write   → 200 { ok: true, writes: [...] }     (mutation; records the body)
 * - GET  /writes  → 200 { writes: [...] }               (read back what landed)
 * - anything else → 404
 *
 * Usage: node scripts/worker-profile-probe-server.mjs [port]
 * Default port 18080. Logs each request to stdout; Ctrl-C stops it.
 */
const http = require('node:http');

const port = Number(process.argv[2] ?? '18080');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`usage: node scripts/worker-profile-probe-server.mjs [port] (got ${JSON.stringify(process.argv[2])})`);
  process.exit(2);
}

const writes = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);
  if (req.method === 'GET' && url.pathname === '/read') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, note: 'worker-profile probe read' }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/writes') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ writes }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/write') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > 65536) {
        req.destroy();
      }
    });
    req.on('end', () => {
      writes.push({ at: new Date().toISOString(), body: body.slice(0, 2000) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, writes }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`worker-profile probe listening on http://127.0.0.1:${port} (GET /read, POST /write, GET /writes)`);
});
