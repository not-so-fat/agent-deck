import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  McpStdioHttpBridge,
  isSessionInvalidResponse,
  parseSseMessages,
  readDeckIdFromToolResult,
  type McpBridgeOptions,
} from './mcp-bridge';

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

type Recorded = { sessionId?: string; body: any; deck?: string };

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

async function driveBridge(
  state: BridgeState,
  fetchImpl?: typeof fetch,
  overrides?: Partial<McpBridgeOptions>,
) {
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
    ...overrides,
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
  it('hands the result to the host, then runs host-neutral tool-result follow-ups', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    const observed: Array<{ name: string; result: unknown; mcpUrl: string }> = [];
    const toolFetch = (async (url: any, init: any): Promise<Response> => {
      const body = JSON.parse(init.body as string);
      if (body.method === 'tools/call') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: '{"approvalUrl":"/admin/approve"}' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return stubFetch(state)(url, init);
    }) as typeof fetch;
    const { send, waitFor, finish } = await driveBridge(state, toolFetch, {
      onToolResult: async (name, result, source) => {
        observed.push({ name, result, mcpUrl: source.mcpUrl });
      },
    });

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'request_admin_elevation', arguments: {} },
    });
    const response = await waitFor(2);
    await finish();

    expect(response.result).toBeDefined();
    await vi.waitFor(() =>
      expect(observed).toEqual([
        { name: 'request_admin_elevation', result: response.result, mcpUrl: 'http://stub/mcp' },
      ]),
    );
  });

  it('returns the tool result even when a follow-up never settles', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    let started = false;
    const { send, waitFor, finish } = await driveBridge(state, undefined, {
      onToolResult: () => {
        started = true;
        return new Promise<void>(() => {});
      },
    });

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'request_admin_elevation', arguments: {} },
    });
    const response = await waitFor(2);
    await finish();

    expect(response.result).toEqual({ pong: true });
    expect(started).toBe(true);
  });

  it('still returns the tool result when a follow-up cannot open its surface', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    const logs: string[] = [];
    const { send, waitFor, finish } = await driveBridge(state, undefined, {
      log: (message) => logs.push(message),
      onToolResult: () => {
        throw new Error('browser unavailable');
      },
    });

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'request_admin_elevation', arguments: {} },
    });
    const response = await waitFor(2);
    await finish();

    expect(response.result).toEqual({ pong: true });
    expect(logs).toContainEqual(expect.stringContaining('browser unavailable'));
  });

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

  it('keeps naming the lost session until a handshake actually lands', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    const recoveryHeaders: Array<string | undefined> = [];
    const inner = stubFetch(state);
    let rejectNextHandshake = true;

    const flakyFetch = (async (url: any, init: any): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.method === 'POST' ? JSON.parse(init.body as string) : undefined;
      if (body?.method === 'initialize') {
        recoveryHeaders.push(headers['x-agent-deck-recovered-session']);
        if (headers['x-agent-deck-recovered-session'] && rejectNextHandshake) {
          rejectNextHandshake = false;
          return new Response('', { status: 503 });
        }
      }
      return inner(url, init);
    }) as unknown as typeof fetch;

    const { bridge, send, waitFor, finish } = await driveBridge(state, flakyFetch);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);

    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect((await waitFor(2)).error?.message).toContain('re-initialization failed');

    send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    expect((await waitFor(3)).result).toEqual({ pong: true });
    await finish();

    // The attempt that failed must not consume the identity: the handshake that
    // succeeds still names session-a, or the server counts it stranded forever.
    expect(recoveryHeaders).toEqual([undefined, 'session-a', 'session-a']);
    expect(bridge.getRecoveryCount()).toBe(1);
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

describe('readDeckIdFromToolResult', () => {
  const textResult = (payload: unknown) => ({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });

  it('reads the deck a binding tool reports', () => {
    expect(readDeckIdFromToolResult(textResult({ deck_id: 'deck-2' }))).toBe('deck-2');
    expect(readDeckIdFromToolResult(textResult({ effective_deck_id: 'deck-3' }))).toBe('deck-3');
  });

  it('ignores errors and payloads that name no deck', () => {
    expect(
      readDeckIdFromToolResult({ isError: true, ...textResult({ deck_id: 'deck-2' }) }),
    ).toBeUndefined();
    expect(readDeckIdFromToolResult(textResult({ ok: true }))).toBeUndefined();
    expect(readDeckIdFromToolResult({ content: [{ type: 'text', text: 'bound.' }] })).toBeUndefined();
    expect(readDeckIdFromToolResult(undefined)).toBeUndefined();
  });
});

type DeckState = BridgeState & {
  /** Deck the live session acts on — an override the next restart forgets. */
  sessionDeck?: string;
  /** The folder assignment, which an elevated switch does update. */
  assignedDeck: string;
};

/**
 * Streamable-HTTP stand-in that models deck binding the way the server does: a
 * fresh session binds to the launch header, and `bind_workspace` overrides that
 * for the life of the session only.
 */
function deckAwareFetch(state: DeckState) {
  const toolResult = (id: unknown, payload: unknown) =>
    new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  return async (_url: any, init: any): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const sessionId = headers['mcp-session-id'];
    if (init?.method === 'GET') {
      return new Response('', { status: 405 });
    }

    const body = JSON.parse(init.body as string);
    state.calls.push({ sessionId, body, deck: headers['x-agent-deck-deck-id'] });

    if (body.method === 'initialize') {
      // The restart forgot every session override; the launch header decides.
      state.sessionDeck = headers['x-agent-deck-deck-id'];
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'mcp-session-id': state.sessionId },
      });
    }

    if (sessionId !== state.sessionId) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001 }, id: null }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (body.id === undefined) {
      return new Response('', { status: 202 });
    }

    const tool = body.params?.name;
    if (tool === 'bind_workspace') {
      state.sessionDeck = body.params.arguments.deckId;
      return toolResult(body.id, { deck_id: state.sessionDeck, deck_source: 'session_override' });
    }
    if (tool === 'switch_bound_deck') {
      state.sessionDeck = body.params.arguments.deckId;
      state.assignedDeck = state.sessionDeck!;
      return toolResult(body.id, { deck_id: state.sessionDeck, assignment_updated: true });
    }
    if (tool === 'get_session_binding') {
      return toolResult(body.id, { effective_deck_id: state.sessionDeck });
    }
    return toolResult(body.id, { applied_to_deck: state.sessionDeck });
  };
}

describe('McpStdioHttpBridge across a deck change', () => {
  it('does not replay a tool call onto a deck the client never bound', async () => {
    // bind_workspace moved this session to deck-2; the launch header still says
    // deck-1, which is the deck a replayed handshake would land on.
    const state: DeckState = { sessionId: 'session-a', calls: [], assignedDeck: 'deck-1' };
    const { bridge, send, waitFor, finish } = await driveBridge(
      state,
      deckAwareFetch(state) as unknown as typeof fetch,
    );

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bind_workspace', arguments: { deckId: 'deck-2' } },
    });
    await waitFor(2);
    expect(bridge.getBoundDeckId()).toBe('deck-2');

    state.sessionId = 'session-b';
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'register_service', arguments: { name: 'svc' } },
    });
    const refused = await waitFor(3);
    await finish();

    expect(refused.error?.message).toContain('deck-1');
    expect(refused.error?.message).toContain('not deck-2');
    // The mutation reached deck-2's session once and was never re-sent to deck-1.
    const writes = state.calls.filter((call) => call.body.params?.name === 'register_service');
    expect(writes).toHaveLength(1);
    expect(bridge.getRecoveryCount()).toBe(1);
    expect(bridge.getBoundDeckId()).toBe('deck-1');
  });

  it('keeps refusing deck-scoped calls until the client binds again', async () => {
    const state: DeckState = { sessionId: 'session-a', calls: [], assignedDeck: 'deck-1' };
    const { bridge, send, waitFor, finish } = await driveBridge(
      state,
      deckAwareFetch(state) as unknown as typeof fetch,
    );

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bind_workspace', arguments: { deckId: 'deck-2' } },
    });
    await waitFor(2);

    // The restart: recovery lands on deck-1, the deck the launch headers name.
    state.sessionId = 'session-b';
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'register_service', arguments: { name: 'svc' } },
    });
    await waitFor(3);

    // The client retries instead of re-binding — the call must still not go out.
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'register_service', arguments: { name: 'svc' } },
    });
    const refusedAgain = await waitFor(4);
    expect(refusedAgain.error?.message).toContain('not sent');
    expect(refusedAgain.error?.message).toContain('not deck-2');
    // Deck-scoped reads are held back on the same grounds.
    send({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'agent-deck://bound-deck' } });
    expect((await waitFor(5)).error?.message).toContain('not deck-2');
    expect(state.calls.filter((call) => call.body.params?.name === 'register_service')).toHaveLength(
      1,
    );

    // Binding again is how the client gets out, and the next call goes through.
    send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'bind_workspace', arguments: { deckId: 'deck-2' } },
    });
    await waitFor(6);
    send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'register_service', arguments: { name: 'svc' } },
    });
    const applied = await waitFor(7);
    await finish();

    expect(applied.error).toBeUndefined();
    expect(JSON.parse(applied.result.content[0].text).applied_to_deck).toBe('deck-2');
    expect(bridge.getRecoveryCount()).toBe(1);
  });

  it('reconnects to the deck an elevated switch persisted, and retries there', async () => {
    const state: DeckState = { sessionId: 'session-a', calls: [], assignedDeck: 'deck-1' };
    const { bridge, send, waitFor, finish } = await driveBridge(
      state,
      deckAwareFetch(state) as unknown as typeof fetch,
      // What the launcher wires up: the assignment, re-read at recovery time.
      { resolveTarget: async () => ({ headers: { 'x-agent-deck-deck-id': state.assignedDeck } }) },
    );

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'switch_bound_deck', arguments: { deckId: 'deck-2' } },
    });
    await waitFor(2);

    state.sessionId = 'session-b';
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'register_service', arguments: { name: 'svc' } },
    });
    const retried = await waitFor(3);
    await finish();

    // The replayed handshake carried deck-2, so the retry stayed on the deck the
    // client switched to instead of silently falling back to deck-1.
    expect(retried.error).toBeUndefined();
    expect(JSON.parse(retried.result.content[0].text).applied_to_deck).toBe('deck-2');
    const handshakes = state.calls.filter((call) => call.body.method === 'initialize');
    expect(handshakes.map((call) => call.deck)).toEqual(['deck-1', 'deck-2']);
    expect(bridge.getBoundDeckId()).toBe('deck-2');
  });

  // `agent-deck use <other-deck>` while we are connected. The client never chose a
  // deck, so following the assignment is the reconnect doing its job — latching on
  // it would wedge every host that does not call bind_workspace.
  it('follows a reassigned folder without holding later calls back', async () => {
    const state: DeckState = { sessionId: 'session-a', calls: [], assignedDeck: 'deck-1' };
    const { bridge, send, waitFor, finish } = await driveBridge(
      state,
      deckAwareFetch(state) as unknown as typeof fetch,
      { resolveTarget: async () => ({ headers: { 'x-agent-deck-deck-id': state.assignedDeck } }) },
    );

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);

    state.assignedDeck = 'deck-2';
    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'register_service' } });
    // The in-flight call was meant for deck-1, so it is still not replayed blind…
    expect((await waitFor(2)).error?.message).toContain('not deck-1');

    // …but the client is on deck-2 now, and its next call goes through there.
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'register_service' } });
    const applied = await waitFor(3);
    await finish();

    expect(applied.error).toBeUndefined();
    expect(JSON.parse(applied.result.content[0].text).applied_to_deck).toBe('deck-2');
    expect(bridge.getBoundDeckId()).toBe('deck-2');
  });

  it('lifts the refusal when a later restart lands back on the chosen deck', async () => {
    const state: DeckState = { sessionId: 'session-a', calls: [], assignedDeck: 'deck-1' };
    const { bridge, send, waitFor, finish } = await driveBridge(
      state,
      deckAwareFetch(state) as unknown as typeof fetch,
      { resolveTarget: async () => ({ headers: { 'x-agent-deck-deck-id': state.assignedDeck } }) },
    );

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bind_workspace', arguments: { deckId: 'deck-2' } },
    });
    await waitFor(2);

    // Restart 1: the assignment still says deck-1, so the override is lost.
    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'register_service' } });
    expect((await waitFor(3)).error?.message).toContain('not deck-2');

    // Restart 2, after someone moved the assignment to the deck the client chose.
    // A binding call is the one thing still allowed out, so it is what discovers
    // the second restart — and it lands on deck-2 this time.
    state.assignedDeck = 'deck-2';
    state.sessionId = 'session-c';
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_session_binding' } });
    expect((await waitFor(4)).error).toBeUndefined();

    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'register_service' } });
    const applied = await waitFor(5);
    await finish();

    // The session is where the client wanted it, so nothing is held back — and the
    // refusal must not have inverted into "deck-2, not deck-1".
    expect(applied.error).toBeUndefined();
    expect(JSON.parse(applied.result.content[0].text).applied_to_deck).toBe('deck-2');
    expect(bridge.getBoundDeckId()).toBe('deck-2');
  });

  it('drops the refusal when the client re-initializes on its own', async () => {
    const state: DeckState = { sessionId: 'session-a', calls: [], assignedDeck: 'deck-1' };
    const { bridge, send, waitFor, finish } = await driveBridge(
      state,
      deckAwareFetch(state) as unknown as typeof fetch,
    );

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bind_workspace', arguments: { deckId: 'deck-2' } },
    });
    await waitFor(2);

    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'register_service' } });
    expect((await waitFor(3)).error?.message).toContain('not deck-2');

    // The host re-handshakes over the same bridge process: a new session bound from
    // the launch headers, which is a clean slate rather than a locked-out one.
    state.sessionId = 'session-c';
    send({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} });
    await waitFor(4);
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'register_service' } });
    const applied = await waitFor(5);
    await finish();

    expect(applied.error).toBeUndefined();
    expect(JSON.parse(applied.result.content[0].text).applied_to_deck).toBe('deck-1');
    expect(bridge.getBoundDeckId()).toBe('deck-1');
  });

  // The binding call was answered by a session the restart then took away. Its deck
  // never applied to the replacement, so believing it would send every later call to
  // the wrong deck — the exact way a mutation lands somewhere the client never chose.
  it('does not let a binding answer from a lost session describe the new one', async () => {
    const state: DeckState = { sessionId: 'session-a', calls: [], assignedDeck: 'deck-1' };
    let releaseBind: () => void = () => {};
    const bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });

    const deckAware = deckAwareFetch(state);
    const gatedFetch = (async (url: any, init: any): Promise<Response> => {
      const body = init?.method === 'POST' ? JSON.parse(init.body as string) : undefined;
      const response = await deckAware(url, init);
      if (body?.params?.name === 'bind_workspace') {
        // The server bound deck-2 and then restarted before the answer got out.
        await bindGate;
      }
      return response;
    }) as unknown as typeof fetch;

    const { bridge, send, waitFor, finish } = await driveBridge(state, gatedFetch);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bind_workspace', arguments: { deckId: 'deck-2' } },
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (state.calls.some((call) => call.body.params?.name === 'bind_workspace')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // The restart, while the bind answer is still on the wire.
    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_session_binding' } });
    await waitFor(3);
    expect(bridge.getRecoveryCount()).toBe(1);

    releaseBind();
    const lostBind = await waitFor(2);
    // The client hears that its binding is gone instead of being told it holds deck-2.
    expect(lostBind.error?.message).toContain('no longer exists');
    expect(lostBind.error?.message).toContain('deck-2');
    expect(bridge.getBoundDeckId()).toBe('deck-1');

    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'register_service', arguments: { name: 'svc' } },
    });
    const refused = await waitFor(4);
    await finish();

    // …and the mutation it sends next is held back rather than applied to deck-1.
    expect(refused.error?.message).toContain('not deck-2');
    expect(state.calls.filter((call) => call.body.params?.name === 'register_service')).toHaveLength(
      0,
    );
  });

  // Same lost binding, but the answer lands while the recovery is still asking the
  // replacement session which deck it sits on. Recovery must read the client's
  // choice after that probe, or it clears the refusal the answer just raised.
  it('keeps the refusal a binding answer raises during the recovery probe', async () => {
    const state: DeckState = { sessionId: 'session-a', calls: [], assignedDeck: 'deck-1' };
    let releaseBind: () => void = () => {};
    const bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    // Filled in once the bridge exists; the probe waits on it to know the obsolete
    // bind answer has been handed to the client before it answers.
    let clientMessages: any[] = [];

    const deckAware = deckAwareFetch(state);
    const gatedFetch = (async (url: any, init: any): Promise<Response> => {
      const body = init?.method === 'POST' ? JSON.parse(init.body as string) : undefined;
      const response = await deckAware(url, init);
      if (body?.params?.name === 'bind_workspace') {
        await bindGate;
      }
      if (typeof body?.id === 'string' && body.id.startsWith('agent-deck-bridge/binding-')) {
        releaseBind();
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (clientMessages.some((message) => message.id === 2)) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      return response;
    }) as unknown as typeof fetch;

    const { bridge, send, waitFor, out, finish } = await driveBridge(state, gatedFetch);
    clientMessages = out;

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'bind_workspace', arguments: { deckId: 'deck-2' } },
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (state.calls.some((call) => call.body.params?.name === 'bind_workspace')) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // The restart, with the bind answer still on the wire. Recovery lands on
    // deck-1 — the same deck this call was sent for, so the retry guard alone
    // would wave it through.
    state.sessionId = 'session-b';
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'register_service', arguments: { name: 'svc' } },
    });

    expect((await waitFor(2)).error?.message).toContain('no longer exists');
    expect((await waitFor(3)).error?.message).toContain('not deck-2');
    await finish();

    expect(bridge.getBoundDeckId()).toBe('deck-1');
    // Its one attempt died with the old session; nothing was replayed onto the
    // live one, which is the deck the client did not choose.
    const writes = state.calls.filter((call) => call.body.params?.name === 'register_service');
    expect(writes.map((call) => call.sessionId)).toEqual(['session-a']);
  });

  it('replays the handshake to the endpoint the assignment names now', async () => {
    const state: DeckState = { sessionId: 'session-a', calls: [], assignedDeck: 'deck-1' };
    const urls: string[] = [];
    const deckAware = deckAwareFetch(state) as unknown as typeof fetch;
    const { send, waitFor, finish } = await driveBridge(
      state,
      ((url: any, init: any) => {
        urls.push(String(url));
        return deckAware(url, init);
      }) as unknown as typeof fetch,
      // `agent-deck use` can repoint the assignment at another MCP port.
      { resolveTarget: async () => ({ url: 'http://moved/mcp' }) },
    );

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);

    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'register_service' } });
    await waitFor(2);
    await finish();

    expect(urls[0]).toBe('http://stub/mcp');
    expect(urls[urls.length - 1]).toBe('http://moved/mcp');
  });

  it('reports the endpoint that answered a tool call after the assignment moved the bridge', async () => {
    const state: DeckState = { sessionId: 'session-a', calls: [], assignedDeck: 'deck-1' };
    const sources: string[] = [];
    const { send, waitFor, finish } = await driveBridge(
      state,
      deckAwareFetch(state) as unknown as typeof fetch,
      {
        resolveTarget: async () => ({ url: 'http://moved/mcp' }),
        onToolResult: (_name, _result, source) => {
          sources.push(source.mcpUrl);
        },
      },
    );

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'request_admin_elevation' } });
    await waitFor(2);

    // A restart invalidates the session; recovery re-reads the assignment and
    // moves the bridge, so this call is answered by the new endpoint.
    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_admin_elevation' } });
    await waitFor(3);
    await finish();

    await vi.waitFor(() => expect(sources).toEqual(['http://stub/mcp', 'http://moved/mcp']));
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

  it('re-initializes once when several in-flight requests come back stale', async () => {
    const state = { sessionId: 'session-a', calls: [] as Recorded[] };
    let releaseSecondStale: () => void = () => {};
    const secondStaleGate = new Promise<void>((resolve) => {
      releaseSecondStale = resolve;
    });

    const inner = stubFetch(state);
    let heldFirstAttempt = false;
    const staggeredFetch = (async (url: any, init: any): Promise<Response> => {
      const response = await inner(url, init);
      const body = init?.method === 'POST' ? JSON.parse(init.body as string) : undefined;
      // Hold the 404 for id 3 until id 2 has finished recovering, so the two
      // stale responses land one after the other rather than together.
      if (body?.id === 3 && response.status === 404 && !heldFirstAttempt) {
        heldFirstAttempt = true;
        await secondStaleGate;
      }
      return response;
    }) as unknown as typeof fetch;

    const { bridge, send, waitFor, finish } = await driveBridge(state, staggeredFetch);

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    state.sessionId = 'session-b';
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });

    expect((await waitFor(2)).result).toEqual({ pong: true });
    releaseSecondStale();

    // The late 404 must reuse the session the first recovery established rather
    // than handshaking again and orphaning it on the server.
    expect((await waitFor(3)).result).toEqual({ pong: true });
    await finish();

    expect(bridge.getRecoveryCount()).toBe(1);
    expect(bridge.getSessionId()).toBe('session-b');
    expect(state.calls.filter((call) => call.body.method === 'initialize')).toHaveLength(2);
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
