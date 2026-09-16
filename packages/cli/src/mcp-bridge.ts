/**
 * First-party stdio ↔ streamable-HTTP bridge (NOT-101).
 *
 * The MCP server keeps transport sessions in memory, so every restart — upgrade,
 * crash recovery, `agent-deck stop && agent-deck start` — invalidates them. The
 * spec's answer is that the server replies 404 to an unknown `Mcp-Session-Id` and
 * the client re-initializes; `supergateway`, the bridge we used to shell out to,
 * never implemented that half and stayed wedged until someone killed it by hand.
 *
 * This bridge owns the recovery: it caches the client's `initialize` handshake and
 * replays it against the server when a session goes missing, then retries the
 * request that failed. The stdio client upstream never sees the gap.
 */
import { AGENT_DECK_RECOVERED_SESSION_HEADER } from '@agent-deck/shared';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** JSON-RPC message as it crosses the bridge — we route on shape, not on schema. */
type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  result?: unknown;
  error?: unknown;
};

export type McpBridgeOptions = {
  url: string;
  /** Sent on every request — the server re-validates the launch deck each call. */
  headers: Record<string, string>;
  stdin: Readable;
  stdout: Writable;
  /** Diagnostics only; never stdout, which carries the protocol. */
  log?: (message: string) => void;
  /** Backoff between failed server→client stream reconnects. */
  streamRetryDelayMs?: number;
  /** How long `run()` waits for in-flight requests after the host closes stdin. */
  drainTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const SESSION_HEADER = 'mcp-session-id';
const MCP_ACCEPT = 'application/json, text/event-stream';

const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

/**
 * Pre-NOT-101 servers answered an unknown session with 400 + this JSON-RPC message
 * instead of 404. Treat it as session-invalid so a new bridge recovers against an
 * older backend that a user has not upgraded yet.
 */
const LEGACY_SESSION_INVALID_MESSAGE = 'no valid session id provided';

export function isSessionInvalidResponse(status: number, body: string): boolean {
  if (status === 404) {
    return true;
  }
  return status === 400 && body.toLowerCase().includes(LEGACY_SESSION_INVALID_MESSAGE);
}

function isInitializeRequest(message: JsonRpcMessage): boolean {
  return message.method === 'initialize';
}

function isInitializedNotification(message: JsonRpcMessage): boolean {
  return message.method === 'notifications/initialized';
}

/** A message with an `id` and a `method` expects a response; everything else does not. */
function isRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === 'string' && message.id !== undefined && message.id !== null;
}

/** Pull JSON-RPC payloads out of an SSE body (`data:` lines, blank-line delimited). */
export function parseSseMessages(chunk: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const payload = line.slice('data:'.length).trim();
    if (!payload) {
      continue;
    }
    try {
      messages.push(JSON.parse(payload) as JsonRpcMessage);
    } catch {
      // A partial frame — the caller re-feeds the remainder with the next chunk.
    }
  }
  return messages;
}

export class McpStdioHttpBridge {
  private readonly options: McpBridgeOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;

  private sessionId: string | undefined;
  /** The client's own handshake, replayed verbatim when a session disappears. */
  private cachedInitialize: JsonRpcMessage | undefined;
  private cachedInitialized: JsonRpcMessage | undefined;
  private streamAbort: AbortController | undefined;
  private closed = false;
  private recovering: Promise<boolean> | undefined;
  /** The in-flight `initialize` exchange; later messages wait for it, not for each other. */
  private handshake: Promise<void> | undefined;
  /** Every dispatched client message, so stdin closing can drain instead of cutting them off. */
  private readonly inFlight = new Set<Promise<void>>();
  /** How many times we re-initialized after a restart — otherwise invisible, so the tests read it. */
  private recoveryCount = 0;

  constructor(options: McpBridgeOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getRecoveryCount(): number {
    return this.recoveryCount;
  }

  /** Resolves when stdin ends (the host closed the server). */
  async run(): Promise<void> {
    const reader = createInterface({ input: this.options.stdin });
    try {
      for await (const line of reader) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(trimmed) as JsonRpcMessage;
        } catch {
          this.log('[agent-deck] bridge: dropping non-JSON line from client');
          continue;
        }
        // Deliberately not awaited: a slow tool call must not hold back the
        // cancellation, ping, or unrelated request the client sends next.
        this.dispatch(message);
      }
    } finally {
      reader.close();
      await this.drain();
      this.close();
    }
  }

  /**
   * Start one client message and keep it tracked. Nothing here may reject: an
   * escaping error would tear down `run()` and, with it, the whole bridge process
   * — the exact failure mode a restart is supposed to be recoverable from.
   */
  private dispatch(message: JsonRpcMessage): void {
    const task = this.forwardFromClient(message).catch((error) => {
      this.failRequest(message, `bridge error: ${describeError(error)}`);
    });
    this.inFlight.add(task);
    void task.then(() => this.inFlight.delete(task));
  }

  /** Give in-flight exchanges a bounded chance to finish once stdin is gone. */
  private async drain(): Promise<void> {
    const timeoutMs = this.options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.log(`[agent-deck] bridge: ${this.inFlight.size} request(s) still open at shutdown`);
        return;
      }
      const timer = deadlineTimer(remaining);
      try {
        await Promise.race([Promise.all([...this.inFlight]), timer.expired]);
      } finally {
        timer.cancel();
      }
    }
  }

  close(): void {
    this.closed = true;
    this.streamAbort?.abort();
    this.streamAbort = undefined;
  }

  private writeToClient(message: JsonRpcMessage): void {
    this.options.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.options.headers,
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
    };
    if (this.sessionId) {
      headers[SESSION_HEADER] = this.sessionId;
    }
    return headers;
  }

  private async post(
    message: JsonRpcMessage,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    return this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: { ...this.requestHeaders(), ...extraHeaders },
      body: JSON.stringify(message),
    });
  }

  private async forwardFromClient(message: JsonRpcMessage): Promise<void> {
    if (isInitializeRequest(message)) {
      this.cachedInitialize = message;
      // A fresh handshake supersedes any session we were holding.
      this.sessionId = undefined;
      // Assigned before the first await so a message read on the very next line
      // already sees the gate and waits for the session id.
      const handshake = this.deliver(message, { allowRecovery: false });
      this.handshake = handshake;
      try {
        await handshake;
      } finally {
        if (this.handshake === handshake) {
          this.handshake = undefined;
        }
      }
      return;
    }

    if (isInitializedNotification(message)) {
      this.cachedInitialized = message;
    }

    await this.awaitSession();
    await this.deliver(message, { allowRecovery: true });
  }

  /**
   * Hold a message only for the two exchanges that own the session id — the
   * handshake and a restart recovery. Everything else goes out concurrently, so
   * one long tool call cannot block the cancellation that would end it.
   */
  private async awaitSession(): Promise<void> {
    // Waiting on one gate can admit the other (a recovery can start while the
    // handshake is still running), so loop until neither is outstanding.
    while (this.handshake || this.recovering) {
      await settled(this.handshake);
      await settled(this.recovering);
    }
  }

  /** POST one client message, recovering once if the session went away. */
  private async deliver(
    message: JsonRpcMessage,
    { allowRecovery }: { allowRecovery: boolean },
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.post(message);
    } catch (error) {
      this.failRequest(message, `transport error: ${describeError(error)}`);
      return;
    }

    // `undefined` means the status line arrived but the body never finished —
    // a restart that lands between the two. Status alone still classifies a 404.
    const bodyText = await readBodyText(response);

    if (allowRecovery && isSessionInvalidResponse(response.status, bodyText ?? '')) {
      this.log(
        `[agent-deck] bridge: MCP session ${this.sessionId ?? '(none)'} is no longer valid ` +
          `(HTTP ${response.status}) — the server restarted. Re-initializing.`,
      );
      if (!(await this.recover())) {
        this.failRequest(message, 'MCP server restarted and re-initialization failed');
        return;
      }
      // Recovery replays the handshake itself — retrying it would send the new
      // session a duplicate `initialized`.
      if (!isInitializedNotification(message)) {
        await this.deliver(message, { allowRecovery: false });
      }
      return;
    }

    if (!response.ok) {
      const detail = (bodyText ?? '').trim();
      this.failRequest(message, `MCP server returned HTTP ${response.status}: ${detail}`);
      return;
    }

    if (bodyText === undefined) {
      // The server accepted the request before the connection died, so the call
      // may well have run. Replaying it could double-apply a mutation, so report
      // the gap to the client and let it decide; the bridge stays up and the next
      // request re-initializes through the normal 404 path.
      this.failRequest(
        message,
        'connection to the MCP server was interrupted while reading the response ' +
          '(the server may have restarted mid-call) — the request was not retried ' +
          'automatically because it may already have been applied',
      );
      return;
    }

    this.captureSessionId(response);
    this.emitResponseBody(response, bodyText);

    if (isInitializeRequest(message)) {
      this.startServerStream();
    }
  }

  private captureSessionId(response: Response): void {
    const sessionId = response.headers.get(SESSION_HEADER);
    if (sessionId) {
      this.sessionId = sessionId;
    }
  }

  private emitResponseBody(response: Response, bodyText: string): void {
    if (!bodyText.trim()) {
      // 202 Accepted for notifications — nothing to hand back to the client.
      return;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      for (const message of parseSseMessages(bodyText)) {
        this.writeToClient(message);
      }
      return;
    }
    try {
      const parsed = JSON.parse(bodyText) as JsonRpcMessage | JsonRpcMessage[];
      for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
        this.writeToClient(message);
      }
    } catch {
      this.log('[agent-deck] bridge: dropping non-JSON response from MCP server');
    }
  }

  /**
   * Replay the cached handshake against the restarted server. Its responses are
   * swallowed — the client already completed its handshake and would reject a
   * second `initialize` result for an id it no longer has outstanding.
   */
  private async recover(): Promise<boolean> {
    this.recovering ??= this.runRecovery().finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }

  private async runRecovery(): Promise<boolean> {
    const initialize = this.cachedInitialize;
    if (!initialize) {
      this.log('[agent-deck] bridge: cannot re-initialize — no initialize request seen yet');
      return false;
    }

    this.streamAbort?.abort();
    this.streamAbort = undefined;
    const lostSessionId = this.sessionId;
    this.sessionId = undefined;

    let response: Response;
    try {
      // Naming the lost session lets the server mark it recovered instead of
      // reporting this client as stranded forever (a wedged supergateway sends no
      // such header and stays unresolved, which is the case operators need to see).
      response = await this.post(
        initialize,
        lostSessionId ? { [AGENT_DECK_RECOVERED_SESSION_HEADER]: lostSessionId } : undefined,
      );
    } catch (error) {
      this.log(`[agent-deck] bridge: re-initialize failed: ${describeError(error)}`);
      return false;
    }

    if (!response.ok) {
      this.log(`[agent-deck] bridge: re-initialize rejected with HTTP ${response.status}`);
      return false;
    }

    this.captureSessionId(response);
    if ((await readBodyText(response)) === undefined) {
      // A handshake we could not read to the end is not a session we can trust —
      // drop it so the next request takes the 404 path and recovers cleanly.
      this.sessionId = undefined;
      this.log('[agent-deck] bridge: re-initialize response was cut off; will retry');
      return false;
    }
    if (!this.sessionId) {
      this.log('[agent-deck] bridge: re-initialize returned no session id');
      return false;
    }

    if (this.cachedInitialized) {
      try {
        const ack = await this.post(this.cachedInitialized);
        await readBodyText(ack);
      } catch (error) {
        this.log(`[agent-deck] bridge: initialized notification failed: ${describeError(error)}`);
      }
    }

    this.recoveryCount += 1;
    this.log(`[agent-deck] bridge: reconnected with MCP session ${this.sessionId}`);
    this.startServerStream();
    return true;
  }

  private failRequest(message: JsonRpcMessage, reason: string): void {
    this.log(`[agent-deck] bridge: ${reason}`);
    if (!isRequest(message)) {
      // Notifications have no reply channel; the log line is all we can offer.
      return;
    }
    this.writeToClient({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32001, message: `agent-deck bridge: ${reason}` },
    });
  }

  /**
   * Server→client stream (`GET /mcp`). Reconnects on drop; a 404 here is the same
   * restart signal as on POST, so it recovers through the same path.
   */
  private startServerStream(): void {
    if (this.closed || !this.sessionId) {
      return;
    }
    this.streamAbort?.abort();
    const abort = new AbortController();
    this.streamAbort = abort;
    void this.consumeServerStream(abort);
  }

  private async consumeServerStream(abort: AbortController): Promise<void> {
    const sessionId = this.sessionId;
    try {
      const response = await this.fetchImpl(this.options.url, {
        method: 'GET',
        headers: { ...this.options.headers, Accept: 'text/event-stream', [SESSION_HEADER]: sessionId! },
        signal: abort.signal,
      });

      if (isSessionInvalidResponse(response.status, await peekBody(response))) {
        if (!abort.signal.aborted && this.sessionId === sessionId) {
          await this.recover();
        }
        return;
      }

      if (!response.ok || !response.body) {
        // 405 means this server has no server→client stream; stay POST-only.
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      // Node's fetch body is async-iterable at runtime; the DOM lib types it as
      // a ReadableStream only.
      const stream = response.body as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lastBreak = buffer.lastIndexOf('\n');
        if (lastBreak === -1) {
          continue;
        }
        const complete = buffer.slice(0, lastBreak + 1);
        buffer = buffer.slice(lastBreak + 1);
        for (const message of parseSseMessages(complete)) {
          this.writeToClient(message);
        }
      }
    } catch {
      // Abort or socket reset — the retry below decides whether to come back.
    }

    if (abort.signal.aborted || this.closed || this.sessionId !== sessionId) {
      return;
    }
    await delay(this.options.streamRetryDelayMs ?? 1_000);
    if (!abort.signal.aborted && !this.closed && this.sessionId === sessionId) {
      this.startServerStream();
    }
  }
}

/**
 * Read a response body, distinguishing "empty" from "the connection died before
 * the body finished". `fetch` resolves as soon as the headers land, so a server
 * that restarts mid-response rejects here — and an unhandled rejection at this
 * point used to take the whole bridge process down with it.
 */
async function readBodyText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

async function peekBody(response: Response): Promise<string> {
  if (response.ok) {
    return '';
  }
  return (await readBodyText(response)) ?? '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A timer we can cancel, so shutdown is not held open by its own deadline. */
function deadlineTimer(ms: number): { expired: Promise<void>; cancel: () => void } {
  let handle: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    expired,
    cancel: () => {
      if (handle) {
        clearTimeout(handle);
      }
    },
  };
}

/** Await a gate without adopting its failure — the caller has its own error path. */
function settled(promise: Promise<unknown> | undefined): Promise<void> {
  return promise ? promise.then(noop, noop) : Promise.resolve();
}

function noop(): void {
  // Intentionally empty.
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
