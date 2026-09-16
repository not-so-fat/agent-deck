import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { McpStdioHttpBridge, isSessionInvalidResponse, parseSseMessages } from './mcp-bridge';

describe('isSessionInvalidResponse', () => {
  it('treats 404 as the spec session-expired signal', () => {
    expect(isSessionInvalidResponse(404, '')).toBe(true);
  });

  it('treats the older 400 body as session-expired too', () => {
    // Older servers answered an unknown session with 400; a new bridge still has
    // to recover against a backend the user has not upgraded yet.
    const legacy = JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: null,
    });
    expect(isSessionInvalidResponse(400, legacy)).toBe(true);
  });

  it('leaves other failures alone', () => {
    expect(isSessionInvalidResponse(400, '{"error":"malformed json-rpc"}')).toBe(false);
    expect(isSessionInvalidResponse(401, 'GRANT_REQUIRED')).toBe(false);
    expect(isSessionInvalidResponse(500, '')).toBe(false);
  });
});

describe('parseSseMessages', () => {
  it('extracts JSON-RPC payloads from data frames', () => {
    const chunk = 'event: message\ndata: {"jsonrpc":"2.0","id":1}\n\ndata: {"jsonrpc":"2.0","id":2}\n\n';
    expect(parseSseMessages(chunk)).toEqual([
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 2 },
    ]);
  });

  it('ignores comments, blank frames, and partial JSON', () => {
    expect(parseSseMessages(': keep-alive\ndata:\ndata: {"jsonrpc"')).toEqual([]);
  });
});

type Recorded = { sessionId?: string; body: any };

/** Minimal streamable-HTTP stand-in whose session id we can invalidate at will. */
function stubFetch(state: { sessionId: string; calls: Recorded[]; legacy400?: boolean }) {
  return async (_url: any, init: any): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const sessionId = headers['mcp-session-id'];

    if (init?.method === 'GET') {
      // No server→client stream in this stub.
      return new Response('', { status: 405 });
    }

    const body = JSON.parse(init.body as string);
    state.calls.push({ sessionId, body });

    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': state.sessionId },
      });
    }

    if (sessionId !== state.sessionId) {
      return state.legacy400
        ? new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
              id: null,
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
        : new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001 }, id: null }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
    }

    if (body.id === undefined) {
      return new Response('', { status: 202 });
    }

    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { pong: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

type BridgeState = { sessionId: string; calls: Recorded[]; legacy400?: boolean };

async function driveBridge(state: BridgeState, fetchImpl?: typeof fetch) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: any[] = [];
  let buffer = '';
  stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        out.push(JSON.parse(line));
      }
      index = buffer.indexOf('\n');
    }
  });

  const bridge = new McpStdioHttpBridge({
    url: 'http://stub/mcp',
    headers: { 'x-agent-deck-deck-id': 'deck-1' },
    stdin,
    stdout,
    log: () => {},
    fetchImpl: fetchImpl ?? (stubFetch(state) as unknown as typeof fetch),
  });
  const running = bridge.run();

  const send = (message: Record<string, unknown>) => stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = async (id: number) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const match = out.find((message) => message.id === id);
      if (match) {
        return match;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no response for id ${id}`);
  };

  return { bridge, send, waitFor, out, finish: async () => (stdin.end(), running) };
}

describe('McpStdioHttpBridge', () => {
  it('sends the launch headers on every request, not just initialize', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    const { send, waitFor, finish } = await driveBridge(state);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await waitFor(2);
    await finish();

    expect(state.calls).toHaveLength(2);
    expect(state.calls[1].sessionId).toBe('session-a');
  });

  it('re-initializes and retries once the server rotates its session', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    const { bridge, send, waitFor, finish } = await driveBridge(state);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Round-trip a request so the handshake has landed before the session rotates.
    send({ jsonrpc: '2.0', id: 99, method: 'ping', params: {} });
    await waitFor(99);

    state.sessionId = 'session-b';

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const response = await waitFor(2);
    await finish();

    expect(response.result).toEqual({ pong: true });
    expect(bridge.getRecoveryCount()).toBe(1);
    expect(bridge.getSessionId()).toBe('session-b');
    // The cached handshake is replayed, including the initialized notification.
    expect(state.calls.filter((call) => call.body.method === 'initialize')).toHaveLength(2);
    expect(
      state.calls.filter((call) => call.body.method === 'notifications/initialized'),
    ).toHaveLength(2);
  });

  it('does not forward the replayed initialize result to the client', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    const { send, waitFor, out, finish } = await driveBridge(state);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await waitFor(2);
    await finish();

    // A second `initialize` result for id 1 would be an unsolicited response upstream.
    expect(out.filter((message) => message.id === 1)).toHaveLength(1);
  });

  it('recovers from the legacy 400 session-invalid body as well', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[], legacy400: true };
    const { bridge, send, waitFor, finish } = await driveBridge(state);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const response = await waitFor(2);
    await finish();

    expect(response.result).toEqual({ pong: true });
    expect(bridge.getRecoveryCount()).toBe(1);
  });

  it('answers the client with an error instead of hanging when recovery fails', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    const { send, waitFor, finish } = await driveBridge(state);

    // No initialize was ever seen, so there is no handshake to replay.
    send({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} });
    const response = await waitFor(9);
    await finish();

    expect(response.error?.message).toContain('agent-deck bridge');
  });

  it('names the session it lost so the server stops counting it as stranded', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    const seen: Array<string | undefined> = [];
    const inner = stubFetch(state);
    const recordingFetch = (async (url: any, init: any) => {
      seen.push((init?.headers ?? {})['x-agent-deck-recovered-session']);
      return inner(url, init);
    }) as unknown as typeof fetch;

    const { send, waitFor, finish } = await driveBridge(state, recordingFetch);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await waitFor(2);
    await finish();

    expect(seen).toContain('session-a');
  });
});

/** A body that starts arriving and then dies — a restart between headers and body. */
function truncatedBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":2,"resu'));
      controller.error(new Error('terminated'));
    },
  });
}

describe('McpStdioHttpBridge when a response body is cut off', () => {
  it('reports the interrupted request without replaying it, and stays up', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    const inner = stubFetch(state);
    let cutOffNext = false;

    const flakyFetch = (async (url: any, init: any): Promise<Response> => {
      const response = await inner(url, init);
      if (cutOffNext && init?.method === 'POST') {
        cutOffNext = false;
        return new Response(truncatedBody(), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return response;
    }) as unknown as typeof fetch;

    const { bridge, send, waitFor, finish } = await driveBridge(state, flakyFetch);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);

    cutOffNext = true;
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'register_service' } });
    const interrupted = await waitFor(2);

    expect(interrupted.error?.message).toContain('interrupted');
    // A tool call that may already have run must not be sent a second time.
    expect(state.calls.filter((call) => call.body.id === 2)).toHaveLength(1);

    // The bridge is still alive: the next request goes through, recovering if the
    // server rotated its session in the meantime.
    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const afterwards = await waitFor(3);
    await finish();

    expect(afterwards.result).toEqual({ pong: true });
    expect(bridge.getRecoveryCount()).toBe(1);
  });

  it('does not resolve run() with a rejection when the body fails', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    const alwaysTruncated = (async (_url: any, init: any): Promise<Response> => {
      if (init?.method === 'GET') {
        return new Response('', { status: 405 });
      }
      return new Response(truncatedBody(), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-a' },
      });
    }) as unknown as typeof fetch;

    const { send, waitFor, finish } = await driveBridge(state, alwaysTruncated);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const initResponse = await waitFor(1);
    expect(initResponse.error?.message).toContain('interrupted');

    // `finish()` awaiting run() is the assertion: an escaping rejection here is
    // what used to kill the bridge process.
    await expect(finish()).resolves.toBeUndefined();
  });
});

describe('McpStdioHttpBridge message pipelining', () => {
  it('keeps forwarding messages while a slow tool call is outstanding', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    let releaseSlowCall: () => void = () => {};
    const slowCallGate = new Promise<void>((resolve) => {
      releaseSlowCall = resolve;
    });

    const inner = stubFetch(state);
    const gatedFetch = (async (url: any, init: any): Promise<Response> => {
      const body = init?.method === 'POST' ? JSON.parse(init.body as string) : undefined;
      if (body?.method === 'tools/call') {
        await slowCallGate;
      }
      return inner(url, init);
    }) as unknown as typeof fetch;

    const { send, waitFor, finish } = await driveBridge(state, gatedFetch);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow' } });
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    send({ jsonrpc: '2.0', id: 3, method: 'ping', params: {} });

    // The point of the fix: both reach the server while id 2 is still hanging.
    const ping = await waitFor(3);
    expect(ping.result).toEqual({ pong: true });
    expect(state.calls.some((call) => call.body.method === 'notifications/cancelled')).toBe(true);

    releaseSlowCall();
    await waitFor(2);
    await finish();
  });

  it('still holds messages until the handshake has a session id', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    let releaseInit: (() => void) | undefined;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });

    const inner = stubFetch(state);
    const gatedFetch = (async (url: any, init: any): Promise<Response> => {
      const body = init?.method === 'POST' ? JSON.parse(init.body as string) : undefined;
      if (body?.method === 'initialize') {
        await initGate;
      }
      return inner(url, init);
    }) as unknown as typeof fetch;

    const { send, waitFor, finish } = await driveBridge(state, gatedFetch);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.calls).toHaveLength(0);

    releaseInit!();
    const response = await waitFor(2);
    await finish();

    // The follow-up carried the session id the handshake had just established.
    expect(response.result).toEqual({ pong: true });
    expect(state.calls[1].sessionId).toBe('session-a');
  });
});
