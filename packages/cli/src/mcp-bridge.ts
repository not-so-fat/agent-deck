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
import {
  AGENT_DECK_DECK_ID_HEADER,
  AGENT_DECK_RECOVERED_SESSION_HEADER,
} from '@agent-deck/shared';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** JSON-RPC message as it crosses the bridge — we route on shape, not on schema. */
type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export type McpBridgeOptions = {
  url: string;
  /** Sent on every request — the server re-validates the launch deck each call. */
  headers: Record<string, string>;
  /**
   * Re-read the folder assignment before replaying a handshake. It can have moved
   * to another deck — or another endpoint — while we were connected
   * (`switch_bound_deck`, `agent-deck use`), and the values we launched with would
   * otherwise reconnect us to the deck and server we started on.
   */
  resolveTarget?: () => Promise<{ url?: string; headers?: Record<string, string> } | undefined>;
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

/**
 * Tools that move this session to another deck. A session override does not
 * survive a restart, so the deck a replayed handshake lands on is whatever the
 * launch headers say — which is why we track what the client bound to and refuse
 * to replay a request across a deck change.
 */
const DECK_REBINDING_TOOLS = new Set(['bind_workspace', 'switch_bound_deck']);

/** Read-only tool that reports the deck a session actually acts on. */
const SESSION_BINDING_TOOL = 'get_session_binding';

/**
 * Requests whose answer depends on which deck the session acts on. While a
 * recovery has moved the session off the deck the client bound, these are the
 * ones that must not go out unannounced.
 */
const DECK_SCOPED_METHODS = new Set(['tools/call', 'resources/read']);

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

/**
 * A call that chooses or reports the session's deck. These are how a client gets
 * out of a deck mismatch, so they are never the calls we hold back.
 */
function isBindingCall(message: JsonRpcMessage): boolean {
  const tool = readToolCallName(message);
  return tool !== undefined && (DECK_REBINDING_TOOLS.has(tool) || tool === SESSION_BINDING_TOOL);
}

/** A call that moves the session to another deck, as opposed to just reporting it. */
function isDeckRebindingCall(message: JsonRpcMessage): boolean {
  const tool = readToolCallName(message);
  return tool !== undefined && DECK_REBINDING_TOOLS.has(tool);
}

function readToolCallName(message: JsonRpcMessage): string | undefined {
  if (message.method !== 'tools/call') {
    return undefined;
  }
  const name = (message.params as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * Deck id out of an MCP tool result — the binding tools answer with one JSON
 * document in a text content block.
 */
export function readDeckIdFromToolResult(result: unknown): string | undefined {
  const payload = result as
    | { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
    | undefined;
  if (!payload || payload.isError || !Array.isArray(payload.content)) {
    return undefined;
  }
  for (const item of payload.content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') {
      continue;
    }
    try {
      const parsed = JSON.parse(item.text) as Record<string, unknown>;
      const deckId = parsed.effective_deck_id ?? parsed.deck_id;
      if (typeof deckId === 'string' && deckId) {
        return deckId;
      }
    } catch {
      // Prose, not a binding payload.
    }
  }
  return undefined;
}

/** Header maps arrive with whatever casing the launcher wrote. */
function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
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
  /**
   * Bumped every time the session id changes — including to `undefined`. A reply
   * is only about the session it was sent on, and after a recovery the id alone
   * cannot say that (the replacement may reuse a value we once held).
   */
  private sessionGeneration = 0;
  /** MCP endpoint as it stands now — re-read from the assignment on recovery. */
  private url: string;
  /** Launch headers as they stand now — re-read from the assignment on recovery. */
  private launchHeaders: Record<string, string>;
  /** The deck the client is working against: launch deck, or whatever it bound to. */
  private boundDeckId: string | undefined;
  /**
   * In-flight `bind_workspace` / `switch_bound_deck` calls: request id → the session
   * generation the call went out on. A binding result only describes the session that
   * answered it, so one that arrives after a restart must not be read as the deck the
   * replacement session is on.
   */
  private readonly pendingDeckRebinds = new Map<string, number>();
  /**
   * The deck the *client* asked for, if it ever did. Only a client that bound a deck
   * itself can be surprised by a reconnect landing somewhere else — a client that
   * simply took the folder assignment gets whatever that assignment says now.
   */
  private clientChosenDeckId: string | undefined;
  /**
   * Set when a recovery moved the session off the deck the client chose. Held until
   * it binds again: reporting the gap on the one request that happened to be in
   * flight is not enough, because the call the client sends next would go to the
   * new deck with nothing to show for it.
   */
  private deckAwaitingRebind: { chosen: string } | undefined;
  /**
   * A session lost to a restart that the server still counts as stranded. Held
   * across failed recovery attempts so the handshake that finally lands can name
   * it — dropping it would leave that client unresolved on the server forever.
   */
  private unresolvedSessionId: string | undefined;
  private bindingProbeSeq = 0;
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
    this.url = options.url;
    this.launchHeaders = { ...options.headers };
    this.boundDeckId = readHeader(this.launchHeaders, AGENT_DECK_DECK_ID_HEADER);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getRecoveryCount(): number {
    return this.recoveryCount;
  }

  /** The deck this bridge believes its session acts on — diagnostics and tests. */
  getBoundDeckId(): string | undefined {
    return this.boundDeckId;
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

  /**
   * Hand a message to the client. `sentOnGeneration` is the session generation the
   * response came back on — absent for anything the bridge writes itself.
   */
  private writeToClient(message: JsonRpcMessage, sentOnGeneration?: number): void {
    const outgoing = this.noteDeckRebinding(message, sentOnGeneration) ?? message;
    this.options.stdout.write(`${JSON.stringify(outgoing)}\n`);
  }

  /**
   * Follow the client's own binding calls. `bind_workspace` moves the session to a
   * deck the launch headers know nothing about, so this is the only place the
   * bridge can learn which deck a later request expects to act on.
   *
   * Returns a replacement message when the binding answer belongs to a session a
   * restart has since taken away: the deck it names is not where the bridge is now,
   * and letting the success through would leave the client acting on the wrong deck
   * believing it had bound.
   */
  private noteDeckRebinding(
    message: JsonRpcMessage,
    sentOnGeneration: number | undefined,
  ): JsonRpcMessage | undefined {
    if (message.id === undefined || message.id === null) {
      return undefined;
    }
    const id = String(message.id);
    const sentAt = this.pendingDeckRebinds.get(id);
    if (sentAt === undefined || sentAt !== sentOnGeneration) {
      // Not a binding call of ours, or a reply superseded by a later attempt on
      // the same id — the attempt that is still outstanding owns the answer.
      return undefined;
    }
    this.pendingDeckRebinds.delete(id);
    const deckId = readDeckIdFromToolResult(message.result);
    if (!deckId) {
      // An error or a payload naming no deck: nothing to record either way.
      return undefined;
    }

    // Whichever session answered, the client has told us which deck it wants — so
    // a later recovery landing elsewhere is a change it needs to hear about.
    this.clientChosenDeckId = deckId;

    if (sentOnGeneration === this.sessionGeneration) {
      this.boundDeckId = deckId;
      // The client has chosen a deck on the current session, so whatever the last
      // recovery moved it away from is settled.
      this.deckAwaitingRebind = undefined;
      return undefined;
    }

    if (this.boundDeckId === deckId) {
      // The replacement session happens to sit on the deck it asked for; the
      // binding stands even though the session that granted it is gone.
      this.deckAwaitingRebind = undefined;
      return undefined;
    }

    // Latched, not merely reported: the client believes it is on `deckId`, so every
    // deck-scoped call it sends next would land on the replacement's deck unnoticed.
    this.deckAwaitingRebind = { chosen: deckId };
    const reason =
      `${deckChangeNotice(this.boundDeckId, deckId)} — the binding was applied to a session ` +
      `that no longer exists; ${rebindInstruction(deckId)} again`;
    this.log(`[agent-deck] bridge: ${reason}`);
    return {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32001, message: `agent-deck bridge: ${reason}` },
    };
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.launchHeaders,
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
    return this.fetchImpl(this.url, {
      method: 'POST',
      headers: { ...this.requestHeaders(), ...extraHeaders },
      body: JSON.stringify(message),
    });
  }

  private async forwardFromClient(message: JsonRpcMessage): Promise<void> {
    if (isInitializeRequest(message)) {
      this.cachedInitialize = message;
      // A fresh handshake supersedes any session we were holding — and with it the
      // deck that session had landed on. The new one binds from the launch headers,
      // and the client makes its own binding choices on top of that, so a refusal
      // latched against the old session must not outlive it.
      this.setSessionId(undefined);
      this.boundDeckId = readHeader(this.launchHeaders, AGENT_DECK_DECK_ID_HEADER);
      this.clientChosenDeckId = undefined;
      this.deckAwaitingRebind = undefined;
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
    if (this.refuseUntilRebound(message)) {
      return;
    }
    await this.deliver(message, { allowRecovery: true });
  }

  /**
   * Refuse a deck-scoped call while the session sits on a deck the client never
   * chose. The binding tools themselves go through — they are how it gets out.
   */
  private refuseUntilRebound(message: JsonRpcMessage): boolean {
    if (this.deckAwaitingRebind === undefined) {
      return false;
    }
    if (!message.method || !DECK_SCOPED_METHODS.has(message.method)) {
      return false;
    }
    if (isBindingCall(message)) {
      return false;
    }
    const { chosen } = this.deckAwaitingRebind;
    this.failRequest(
      message,
      `${deckChangeNotice(this.boundDeckId, chosen)} — the call was not sent; ` +
        `${rebindInstruction(chosen)} first`,
    );
    return true;
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
    // The session this particular request went out on. Concurrent requests can
    // come back stale one after another; without this we would re-initialize once
    // per response and throw away the session the first recovery just won.
    const sentWithSession = this.sessionId;
    const sentWithGeneration = this.sessionGeneration;
    // ...and the deck it was meant for. A replayed handshake re-binds from the
    // launch headers, which can land on a different deck than the one the client
    // bound this session to; a retry then applies the call to the wrong deck.
    const sentWithDeck = this.boundDeckId;
    // Recorded per attempt, not per request: a retry after recovery goes out on
    // the new session, and its answer is the one that describes where we are.
    if (isRequest(message) && isDeckRebindingCall(message)) {
      this.pendingDeckRebinds.set(String(message.id), sentWithGeneration);
    }
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
        `[agent-deck] bridge: MCP session ${sentWithSession ?? '(none)'} is no longer valid ` +
          `(HTTP ${response.status}) — the server restarted. Re-initializing.`,
      );
      if (!(await this.ensureRecovered(sentWithSession))) {
        this.failRequest(message, 'MCP server restarted and re-initialization failed');
        return;
      }
      // Recovery replays the handshake itself — retrying it would send the new
      // session a duplicate `initialized`.
      if (isInitializedNotification(message)) {
        return;
      }
      if (this.boundDeckId !== sentWithDeck && !isBindingCall(message)) {
        // The session is healthy again, but on another deck. Replaying here could
        // apply a mutation to a deck the client never chose, so hand the gap back
        // instead: the client re-binds and decides whether to send this again.
        // A binding call is exempt — it is the client doing exactly that.
        this.failRequest(
          message,
          `${deckChangeNotice(this.boundDeckId, sentWithDeck)} — the request was not retried; ` +
            `${rebindInstruction(sentWithDeck)} and send it again`,
        );
        return;
      }
      await this.deliver(message, { allowRecovery: false });
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
    this.emitResponseBody(response, bodyText, sentWithGeneration);

    if (isInitializeRequest(message)) {
      this.startServerStream();
    }
  }

  /** Every session change goes through here, so the generation cannot drift. */
  private setSessionId(sessionId: string | undefined): void {
    if (this.sessionId === sessionId) {
      return;
    }
    this.sessionId = sessionId;
    this.sessionGeneration += 1;
  }

  private captureSessionId(response: Response): void {
    const sessionId = response.headers.get(SESSION_HEADER);
    if (sessionId) {
      this.setSessionId(sessionId);
    }
  }

  private emitResponseBody(
    response: Response,
    bodyText: string,
    sentOnGeneration: number | undefined,
  ): void {
    const messages = decodeJsonRpcMessages(response, bodyText);
    if (!messages) {
      this.log('[agent-deck] bridge: dropping non-JSON response from MCP server');
      return;
    }
    for (const message of messages) {
      this.writeToClient(message, sentOnGeneration);
    }
  }

  /**
   * Recover the session a request was sent on — once, no matter how many of its
   * siblings come back stale. A second handshake for the same invalidation would
   * discard a session that is already working and leave the first one orphaned on
   * the server, where it shows up as another stranded client.
   */
  private async ensureRecovered(sentWithSession: string | undefined): Promise<boolean> {
    if (this.recovering) {
      // Someone is already re-initializing; that handshake is this one's answer.
      return this.recovering;
    }
    if (this.sessionId && this.sessionId !== sentWithSession) {
      // A recovery finished while this request was in flight. Retry on its session.
      return true;
    }
    return this.recover();
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
    if (this.sessionId) {
      // A session we still hold is the one we are about to lose. With none in
      // hand we are retrying an earlier failed recovery, so keep naming the
      // session that one never resolved.
      this.unresolvedSessionId = this.sessionId;
    }
    const lostSessionId = this.unresolvedSessionId;
    this.setSessionId(undefined);

    // The folder assignment may have moved to another deck while we were up; the
    // handshake has to go out with the binding that is current now.
    await this.refreshLaunchTarget();

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
      this.setSessionId(undefined);
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

    // The replacement exists, so the server has been told which session it stands
    // in for and nothing is left unresolved for this client.
    this.unresolvedSessionId = undefined;
    this.recoveryCount += 1;

    // Only a deck the client bound itself can be lost here. Following the folder
    // assignment somewhere else is the reconnect working as intended, and latching
    // on it would wedge every host that never calls `bind_workspace`.
    const chosen = this.clientChosenDeckId;
    this.boundDeckId = await this.resolveSessionDeck();
    if (chosen === undefined || this.boundDeckId === chosen) {
      // Either the client never chose, or a later restart put us back where it was.
      this.deckAwaitingRebind = undefined;
    } else {
      // Latched, not just reported: every deck-scoped call waits for the client to
      // bind again, so none of them lands on this deck by accident.
      this.deckAwaitingRebind = { chosen };
      this.log(
        `[agent-deck] bridge: ${deckChangeNotice(this.boundDeckId, chosen)} — deck-scoped ` +
          'requests are refused until the client binds again.',
      );
    }

    this.log(`[agent-deck] bridge: reconnected with MCP session ${this.sessionId}`);
    this.startServerStream();
    return true;
  }

  private async refreshLaunchTarget(): Promise<void> {
    if (!this.options.resolveTarget) {
      return;
    }
    try {
      const target = await this.options.resolveTarget();
      if (target?.headers) {
        this.launchHeaders = { ...target.headers };
      }
      if (target?.url) {
        // The assignment can name a different MCP endpoint than the one we
        // launched against; replaying to the old one would reconnect nowhere.
        this.url = target.url;
      }
    } catch (error) {
      this.log(
        `[agent-deck] bridge: could not re-read the folder assignment (${describeError(error)}); ` +
          'reconnecting with the values we launched with',
      );
    }
  }

  /**
   * Ask the recovered session which deck it actually acts on. A session deck
   * override is gone after a restart, so this is the answer to compare a pending
   * request against — and the launch header is only the fallback for a server
   * that does not expose the binding tool.
   */
  private async resolveSessionDeck(): Promise<string | undefined> {
    const headerDeck = readHeader(this.launchHeaders, AGENT_DECK_DECK_ID_HEADER);
    this.bindingProbeSeq += 1;
    // Namespaced so it can never collide with a client's own request id; the
    // answer is read here and never forwarded upstream.
    const id = `agent-deck-bridge/binding-${this.bindingProbeSeq}`;
    try {
      const response = await this.post({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: SESSION_BINDING_TOOL, arguments: {} },
      });
      const bodyText = await readBodyText(response);
      if (!response.ok || bodyText === undefined) {
        return headerDeck;
      }
      for (const message of decodeJsonRpcMessages(response, bodyText) ?? []) {
        if (String(message.id) === id) {
          return readDeckIdFromToolResult(message.result) ?? headerDeck;
        }
      }
    } catch (error) {
      this.log(`[agent-deck] bridge: could not read the new session binding: ${describeError(error)}`);
    }
    return headerDeck;
  }

  private failRequest(message: JsonRpcMessage, reason: string): void {
    this.log(`[agent-deck] bridge: ${reason}`);
    if (message.id !== undefined && message.id !== null) {
      // No result is coming, so this call tells us nothing about the deck.
      this.pendingDeckRebinds.delete(String(message.id));
    }
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
    // A response that arrives over this stream belongs to the session that opened
    // it, the same way a POST reply belongs to the session it was sent on.
    const generation = this.sessionGeneration;
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'GET',
        headers: { ...this.launchHeaders, Accept: 'text/event-stream', [SESSION_HEADER]: sessionId! },
        signal: abort.signal,
      });

      if (isSessionInvalidResponse(response.status, await peekBody(response))) {
        if (!abort.signal.aborted) {
          // Same rule as on POST: only re-initialize if this stream's session is
          // still the current one, otherwise a POST already recovered it.
          await this.ensureRecovered(sessionId);
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
          this.writeToClient(message, generation);
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
 * JSON-RPC messages out of a response body, whichever framing the server chose.
 * `undefined` means the body was not JSON at all — the caller logs that; an empty
 * array is a legitimately empty body (202 Accepted for a notification).
 */
function decodeJsonRpcMessages(response: Response, bodyText: string): JsonRpcMessage[] | undefined {
  if (!bodyText.trim()) {
    return [];
  }
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return parseSseMessages(bodyText);
  }
  try {
    const parsed = JSON.parse(bodyText) as JsonRpcMessage | JsonRpcMessage[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return undefined;
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

/** One phrasing of "this session is not on the deck you bound", used on both paths. */
function deckChangeNotice(currentDeck: string | undefined, chosenDeck: string | undefined): string {
  return (
    `the MCP server restarted and the new session is bound to deck ${currentDeck ?? '(none)'}, ` +
    `not ${chosenDeck ?? '(none)'}`
  );
}

/**
 * The way out, naming the deck to bind back to. Without the id an agent tends to
 * reach for the first deck in the sentence — the one it must not act on.
 */
function rebindInstruction(chosenDeck: string | undefined): string {
  return chosenDeck
    ? `re-bind with bind_workspace(deckId: "${chosenDeck}")`
    : 're-bind with bind_workspace';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
