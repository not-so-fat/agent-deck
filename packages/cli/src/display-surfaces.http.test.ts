import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDisplayLine } from '@agent-deck/shared';
import { runMenubar } from './menubar';
import { runStatusline } from './statusline';

/**
 * Bound statusline + menubar against a real HTTP backend stub (CI).
 * Complements unit render tests and release-smoke (unbound / install only).
 */

type DisplayStub = {
  port: number;
  displayHits: string[];
  bindingsHits: { count: number };
  closed: boolean;
  close: () => Promise<void>;
};

const WORKSPACE = '/tmp/display-surface-workspace';
const DISPLAY_LINE = formatDisplayLine(
  'dev',
  { mcp: 2, credentials: 1, playbooks: 3 },
  { badge: 'moss' },
);

function startDisplayStub(): Promise<DisplayStub> {
  const displayHits: string[] = [];
  const bindingsHits = { count: 0 };
  let closed = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const respond = (body: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/api/scope/display') {
      displayHits.push(url.searchParams.get('workspaceRoot') ?? '');
      respond({
        success: true,
        data: {
          displayLine: DISPLAY_LINE,
          deckId: '33333333-3333-4333-8333-333333333333',
          deckName: 'dev',
          source: 'session_override',
          badge: 'moss',
        },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/scope/bindings') {
      bindingsHits.count += 1;
      respond({
        success: true,
        data: [
          {
            badge: 'moss',
            deckId: '33333333-3333-4333-8333-333333333333',
            deckName: 'dev',
            source: 'session_override',
            workspaceRoot: WORKSPACE,
            clientName: 'cursor',
            cardCounts: { mcp: 2, credentials: 1, playbooks: 3 },
            updatedAt: '2026-07-03T12:00:00.000Z',
            lastActivityAt: '2026-07-03T12:00:00.000Z',
          },
        ],
      });
      return;
    }

    respond({ success: false, error: `stub: unhandled ${req.method} ${url.pathname}` });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        displayHits,
        bindingsHits,
        get closed() {
          return closed;
        },
        close: () =>
          new Promise((done) => {
            if (closed) {
              done();
              return;
            }
            closed = true;
            server.close(() => done());
          }),
      });
    });
  });
}

function captureStdout(run: () => Promise<number>): Promise<{ code: number; output: string }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  return run()
    .then((code) => ({ code, output: chunks.join('') }))
    .finally(() => {
      process.stdout.write = originalWrite;
    });
}

describe('statusline + menubar display surfaces (HTTP stub)', () => {
  let stub: DisplayStub;
  let previousPort: string | undefined;
  let previousBackendPort: string | undefined;
  let previousTimeout: string | undefined;

  beforeEach(async () => {
    stub = await startDisplayStub();
    previousPort = process.env.AGENT_DECK_PORT;
    previousBackendPort = process.env.AGENT_DECK_BACKEND_PORT;
    previousTimeout = process.env.AGENT_DECK_STATUSLINE_TIMEOUT_MS;
    // AGENT_DECK_BACKEND_PORT wins over AGENT_DECK_PORT, and the suite now pins
    // it to an unreachable port so no test can reach the developer's own deck.
    // Point the authoritative variable at this stub, or the CLI reads the pin
    // and reports offline.
    process.env.AGENT_DECK_PORT = String(stub.port);
    process.env.AGENT_DECK_BACKEND_PORT = String(stub.port);
    process.env.AGENT_DECK_STATUSLINE_TIMEOUT_MS = '500';
  });

  afterEach(async () => {
    if (previousPort === undefined) {
      delete process.env.AGENT_DECK_PORT;
    } else {
      process.env.AGENT_DECK_PORT = previousPort;
    }
    if (previousBackendPort === undefined) {
      delete process.env.AGENT_DECK_BACKEND_PORT;
    } else {
      process.env.AGENT_DECK_BACKEND_PORT = previousBackendPort;
    }
    if (previousTimeout === undefined) {
      delete process.env.AGENT_DECK_STATUSLINE_TIMEOUT_MS;
    } else {
      process.env.AGENT_DECK_STATUSLINE_TIMEOUT_MS = previousTimeout;
    }
    await stub.close();
  });

  it('statusline prints bound displayLine with badge (not offline)', async () => {
    const { code, output } = await captureStdout(() =>
      runStatusline(['--workspace', WORKSPACE]),
    );
    expect(code).toBe(0);
    const line = output.replace(/\n$/, '');
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toBe(DISPLAY_LINE);
    expect(line).toContain('◆ dev');
    expect(line).toContain('⌘moss');
    expect(line).not.toMatch(/offline|Unbound/i);
    expect(stub.displayHits).toContain(WORKSPACE);
  });

  it('statusline falls back to offline when backend is down', async () => {
    await stub.close();
    process.env.AGENT_DECK_PORT = '1';
    process.env.AGENT_DECK_BACKEND_PORT = '1';
    process.env.AGENT_DECK_STATUSLINE_TIMEOUT_MS = '50';

    const { code, output } = await captureStdout(() =>
      runStatusline(['--workspace', WORKSPACE]),
    );
    expect(code).toBe(0);
    const line = output.replace(/\n$/, '');
    expect(line).toMatch(/^◆/);
    expect(line.toLowerCase()).toMatch(/offline|unbound|—/);
  });

  it('menubar renders live bindings from /api/scope/bindings', async () => {
    const { code, output } = await captureStdout(() => runMenubar());
    expect(code).toBe(0);
    expect(output).toContain('◆ dev ⌘moss');
    expect(output).toContain('display-surface-workspace/');
    expect(output).toContain('⌘moss');
    expect(output).toContain('cursor');
    expect(stub.bindingsHits.count).toBe(1);
  });

  it('menubar shows offline title when backend is down', async () => {
    await stub.close();
    process.env.AGENT_DECK_PORT = '1';
    process.env.AGENT_DECK_BACKEND_PORT = '1';
    process.env.AGENT_DECK_STATUSLINE_TIMEOUT_MS = '50';

    const { code, output } = await captureStdout(() => runMenubar());
    expect(code).toBe(0);
    expect(output.split('\n')[0]).toContain('off');
    expect(output).not.toContain('⌘moss');
  });
});
