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
  fetchImpl?: typeof fetch;
};

const SESSION_HEADER = 'mcp-session-id';
const MCP_ACCEPT = 'application/json, text/event-stream';

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
  /** Test/observability hook: how many times we re-initialized after a restart. */
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
        await this.forwardFromClient(message);
      }
    } finally {
      reader.close();
      this.close();
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

  private async post(message: JsonRpcMessage): Promise<Response> {
    return this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(message),
    });
  }

  private async forwardFromClient(message: JsonRpcMessage): Promise<void> {
    if (isInitializeRequest(message)) {
      this.cachedInitialize = message;
      // A fresh handshake supersedes any session we were holding.
      this.sessionId = undefined;
      await this.deliver(message, { allowRecovery: false });
      return;
    }

    if (isInitializedNotification(message)) {
      this.cachedInitialized = message;
    }

    await this.deliver(message, { allowRecovery: true });
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

    const bodyText = await response.text();

    if (allowRecovery && isSessionInvalidResponse(response.status, bodyText)) {
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
      this.failRequest(message, `MCP server returned HTTP ${response.status}: ${bodyText.trim()}`);
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
    this.sessionId = undefined;

    let response: Response;
    try {
      response = await this.post(initialize);
    } catch (error) {
      this.log(`[agent-deck] bridge: re-initialize failed: ${describeError(error)}`);
      return false;
    }

    if (!response.ok) {
      this.log(`[agent-deck] bridge: re-initialize rejected with HTTP ${response.status}`);
      return false;
    }

    this.captureSessionId(response);
    await response.text();
    if (!this.sessionId) {
      this.log('[agent-deck] bridge: re-initialize returned no session id');
      return false;
    }

    if (this.cachedInitialized) {
      try {
        const ack = await this.post(this.cachedInitialized);
        await ack.text();
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

async function peekBody(response: Response): Promise<string> {
  if (response.ok) {
    return '';
  }
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
