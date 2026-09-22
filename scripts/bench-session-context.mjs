#!/usr/bin/env node
/**
 * NOT-189 local integration benchmark.
 *
 * 100 sequential `get_session_context` MCP calls against a stub backend,
 * reporting mean/p50/p95. This is a local benchmark, not a unit test:
 * host UI latency is deliberately not asserted in the committed suite.
 *
 * Run:  npm run build --workspace @agent-deck/backend && node scripts/bench-session-context.mjs
 * Gate: exits 1 when p95 >= 250 ms.
 */
import http from 'node:http';
import { performance } from 'node:perf_hooks';

import { AGENT_DECK_DECK_ID_HEADER } from '@agent-deck/shared';
import { AgentDeckMCPServer } from '../packages/backend/dist/mcp-server.js';

const CALLS = 100;
const P95_BUDGET_MS = 250;

const DECK_ID = '11111111-1111-4111-8111-111111111111';
const DECK = {
  id: DECK_ID,
  name: 'bench',
  services: [{ id: 'svc-bench', name: 'Bench', type: 'mcp' }],
  credentials: [{ id: 'cred-bench', label: 'Bench key', envName: 'BENCH_API_KEY' }],
  playbooks: [{ id: 'pb-bench', title: 'Bench playbook', triggers: ['bench'] }],
};

function startStubBackend() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const respond = (body, status = 200) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      if (method === 'POST' && url === '/api/trusted-session/mcp/connect-deck') {
        respond({
          success: true,
          data: { sessionId: `rt-bench`, deckId: DECK.id, deckName: DECK.name, mode: 'normal' },
        });
        return;
      }
      if (method === 'GET' && url === '/api/trusted-session/runtime-session') {
        respond({ success: true, data: { deckId: DECK.id, mode: 'normal' } });
        return;
      }
      if (method === 'GET' && url === '/api/scope/deck') {
        respond({ success: true, data: DECK });
        return;
      }
      if (method === 'POST' && url === '/api/scope/live-display') {
        respond({ success: true, data: { badge: 'bench' } });
        return;
      }
      if (method === 'POST' && url === '/api/scope/deck-workspace') {
        respond({ success: true, data: { ok: true } });
        return;
      }
      if (url.startsWith('/api/scope/live-display/')) {
        respond({ success: true });
        return;
      }
      respond({ success: false, error: `stub: unhandled ${method} ${url}` }, 500);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`MCP server on :${port} did not become healthy`);
}

async function openSession(port, id, headers) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bench', version: '1.0.0' },
      },
    }),
  });
  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) throw new Error(`Missing mcp-session-id (status=${response.status})`);
  return sessionId;
}

async function callTool(port, sessionId, name, args, id, headers) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`tools/call error: ${JSON.stringify(body.error)}`);
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`Unexpected tools/call result: ${JSON.stringify(body)}`);
  return { isError: Boolean(body.result?.isError), data: JSON.parse(text) };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const stub = await startStubBackend();
const mcpServer = new AgentDeckMCPServer(0, `http://127.0.0.1:${stub.port}`, 'standard');
try {
  await mcpServer.start();
  const port = mcpServer.getPort();
  await waitForHealth(port);

  const headers = { [AGENT_DECK_DECK_ID_HEADER]: DECK_ID };
  const sessionId = await openSession(port, 1, headers);

  const durations = [];
  for (let i = 0; i < CALLS; i += 1) {
    const start = performance.now();
    const result = await callTool(port, sessionId, 'get_session_context', {}, 100 + i, headers);
    durations.push(performance.now() - start);
    if (result.isError) throw new Error(`call ${i} failed: ${JSON.stringify(result.data)}`);
    if (i === 0 && !result.data.display_summary) throw new Error('missing display_summary');
  }
  durations.sort((a, b) => a - b);
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const max = durations[durations.length - 1];
  console.log(
    `get_session_context x${CALLS}: mean ${mean.toFixed(2)} ms, p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms (budget p95 < ${P95_BUDGET_MS} ms)`,
  );
  if (p95 >= P95_BUDGET_MS) {
    console.error(`BENCHMARK BREACH: p95 ${p95.toFixed(2)} ms >= ${P95_BUDGET_MS} ms`);
    process.exitCode = 1;
  }
} finally {
  await mcpServer.stop();
  await stub.close();
}
