import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_DECK_CORRELATION_HEADER,
  AGENT_DECK_DECK_ID_HEADER,
  AGENT_DECK_RECOVERED_SESSION_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
  countDeckCards,
  ensureGitExcluded,
  formatDisplayLine,
} from '@agent-deck/shared';
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { getAgentDeckVersion } from './lib/version';
import { resolveDatabasePath } from './lib/paths';
import { resolveLiveDisplayStaleMs } from './scope/live-display-registry';
import {
  ClientGrantStore,
  parseGrantToken,
  principalAllowsDeck,
  resolveGrantDeck,
} from './auth/client-grants';
import { BackendApiError, parseBackendErrorBody } from './lib/backend-api-error';
import { formatMcpToolError } from './mcp-tools/policy';
import {
  McpSessionBindingStore,
  resolveDeckBindingSource,
} from './mcp-session-binding';
import { registerMcpTools } from './mcp-tools/register';
import {
  DECK_SWITCH_ELICITATION_TIMEOUT_MS,
  supportsFormElicitation,
} from './mcp-tools/elicitation';
import { McpToolProfile, resolveMcpToolProfile } from './mcp-tools/profile';
import {
  skipDeckHeaderAuth,
  UNASSIGNED_DECK_MESSAGE,
} from './mcp-unassigned';
import {
  healUseManifest,
  isStubSyncEnabled,
  stubSyncChanged,
  syncPlaybookStubs,
  type StubBindSyncResult,
  type PlaybookStubInput,
} from './playbooks/stub-sync';
import { RequestLimiter } from './auth/request-limiter';
import { AuditStore, auditDeckTarget, type AuditActor } from './audit/store';

function readWorkspaceRootHeader(req: Request): string | undefined {
  const raw = req.headers[AGENT_DECK_WORKSPACE_HEADER];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || undefined;
}

function readLaunchDeckHeader(req: Request): string | undefined {
  const raw = req.headers[AGENT_DECK_DECK_ID_HEADER];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || undefined;
}

/**
 * Opaque run-correlation id for launch-selected sessions (NOT-304).
 * Returned unvalidated — the binding store normalizes and adopt-once
 * semantics keep it observability-only: it can never select a deck, grant
 * access, change mode, or participate in authorization.
 */
function readCorrelationIdHeader(req: Request): string | undefined {
  const raw = req.headers[AGENT_DECK_CORRELATION_HEADER];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || undefined;
}

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

/**
 * NOT-318: hosted-mode flag. When `AGENT_DECK_MCP_REQUIRE_BEARER=1`, every
 * `/mcp` request requires a valid per-agent grant secret, regardless of
 * peer address. Peer-address detection is explicitly rejected as the
 * trigger (TLS-terminating proxies forward internet traffic over
 * loopback), and `X-Forwarded-*` headers are never trusted for auth.
 * The local launcher never sets this flag, so loopback sessions stay
 * bearer-free with zero config change.
 */
export const MCP_REQUIRE_BEARER_ENV_VAR = 'AGENT_DECK_MCP_REQUIRE_BEARER';
export const MCP_INITIALIZE_RATE_LIMIT = 30;
export const MCP_INITIALIZE_RATE_WINDOW_MS = 60_000;

export function isBearerGrantRequired(raw: string | undefined = process.env[MCP_REQUIRE_BEARER_ENV_VAR]): boolean {
  return raw === '1' || raw?.trim().toLowerCase() === 'true';
}

/** Extract the bearer secret without ever logging or echoing it. */
function readBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(header.trim());
  const token = match?.[1]?.trim();
  return token || null;
}

/**
 * NOT-309: keep-alive touch cadence for idle-but-connected MCP sessions.
 * Every MCP tool call already bumps `lastActivityAt` (debounced POST touch),
 * but a session with an open transport and no tool calls sends no HTTP POSTs
 * (the SSE stream is a GET), so without a keep-alive it would expire out of
 * the live-display registry while still connected. Override via
 * `AGENT_DECK_MCP_LIVE_TOUCH_KEEPALIVE_MS` (`0` disables); the default is
 * also clamped under a third of the stale bound so a shortened
 * `LIVE_DISPLAY_STALE_MS` never outruns it.
 *
 * Both processes must see the same `LIVE_DISPLAY_STALE_MS`: the MCP server
 * runs separately (mcp-index) and resolves the bound from its own
 * environment, so shortening it only on the backend leaves the keep-alive
 * at 5 minutes and idle sessions expire. Export it for both processes.
 */
export const DEFAULT_LIVE_TOUCH_KEEPALIVE_MS = 5 * 60_000;
export const LIVE_TOUCH_KEEPALIVE_ENV_VAR = 'AGENT_DECK_MCP_LIVE_TOUCH_KEEPALIVE_MS';

export function resolveLiveTouchKeepAliveMs(raw: string | undefined, staleMs: number): number {
  const fallback =
    staleMs > 0
      ? Math.max(1, Math.min(DEFAULT_LIVE_TOUCH_KEEPALIVE_MS, Math.floor(staleMs / 3)))
      : DEFAULT_LIVE_TOUCH_KEEPALIVE_MS;
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Clients that were connected to a previous process (NOT-101). Transport sessions
 * live in memory only, so every restart — upgrade, crash, `agent-deck stop/start` —
 * orphans them. We keep a bounded tally so `/health` (and `agent-deck status`) can
 * say "clients are talking to sessions this process never issued" instead of
 * reporting a clean "running" while every tool call fails.
 *
 * The tally separates two very different states. `recoveredSessions` counts stale
 * sessions whose client came back and re-initialized (our bridge names the session
 * it lost on the replayed handshake); `unresolvedSessions` is what is left — the
 * clients that are still stranded, which is the only number worth warning about.
 */
type StaleSessionStats = {
  count: number;
  distinctSessions: number;
  recoveredSessions: number;
  unresolvedSessions: number;
  lastSessionId?: string;
  firstAt?: string;
  lastAt?: string;
  /** Last attempt from a session nobody has re-initialized away from. */
  lastUnresolvedAt?: string;
};

export class AgentDeckMCPServer {
  /** Cap on remembered stale session ids — the tally is diagnostics, not a ledger. */
  private static readonly STALE_SESSION_SAMPLE_LIMIT = 200;

  private port: number;
  private host: string;
  private app: express.Application;
  private httpServer: HttpServer | null = null;
  private backendUrl: string;
  private toolProfile: McpToolProfile;
  private sessions = new Map<string, McpSession>();
  /** Set only while registerTools/registerResources run for a new session server. */
  private mcpServerForRegistration: McpServer | undefined;
  /** Per-session workspace + optional deck override (see mcp-session-binding.ts). */
  private sessionBinding: McpSessionBindingStore;
  /** Session badge from the backend registry (POST /api/scope/live-display response). */
  private badgeBySession = new Map<string, string>();
  private lastTouchAtMs = new Map<string, number>();
  /** NOT-309: keep-alive timer proving idle-but-connected sessions still live. */
  private liveTouchKeepAliveTimer: NodeJS.Timeout | null = null;
  /** In-flight live-display unregisters so `stop()` can drain them before closing. */
  private unregisterTasks = new Map<string, Promise<void>>();
  /** Changes on every process start — how a client detects it outlived the server. */
  private readonly instanceId = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private staleSessionCount = 0;
  /** Pre-restart session id → whether its client has since re-initialized. */
  private staleSessionsById = new Map<string, { recovered: boolean; lastAt: string }>();
  /**
   * Sessions this process issued and then closed. A late request on one of them is
   * an ordinary end-of-session race, not a client left behind by a restart, and
   * tallying it would make `agent-deck status` warn about a restart that never
   * happened.
   */
  private closedSessionIds = new Set<string>();
  private staleSessionFirstAt: string | undefined;
  private staleSessionLastAt: string | undefined;
  private staleSessionLastId: string | undefined;

  private get server(): McpServer {
    if (!this.mcpServerForRegistration) {
      throw new Error('Internal: MCP server not in registration context');
    }
    return this.mcpServerForRegistration;
  }

  /** Injected grant store (tests). `undefined` means "resolve lazily". */
  private grantStoreOverride: ClientGrantStore | null | undefined;
  /** Lazily opened grant store for hosted mode (shared backend database file). */
  private grantStoreCache: ClientGrantStore | null = null;
  private auditStoreOverride: AuditStore | null | undefined;
  private auditStoreCache: AuditStore | null = null;
  private sharedSecurityDb: Database.Database | null = null;
  private readonly initializeLimiter: RequestLimiter;

  constructor(
    port: number = 3001,
    backendUrl: string = 'http://localhost:8000',
    toolProfile?: McpToolProfile,
    host: string = '127.0.0.1',
    options?: {
      grantStore?: ClientGrantStore | null;
      auditStore?: AuditStore | null;
      now?: () => number;
    },
  ) {
    this.port = port;
    this.backendUrl = backendUrl;
    this.toolProfile = toolProfile ?? resolveMcpToolProfile();
    this.host = host;
    this.grantStoreOverride = options?.grantStore;
    this.auditStoreOverride = options?.auditStore;
    this.initializeLimiter = new RequestLimiter(MCP_INITIALIZE_RATE_WINDOW_MS, options?.now);

    this.app = express();
    this.app.use(
      process.env.AGENT_DECK_HOSTED_MODE === '1'
        ? express.json({ limit: 1024 * 1024 })
        : express.json(),
    );
    this.setupRoutes();

    this.sessionBinding = new McpSessionBindingStore({
      workspace: process.env.AGENT_DECK_WORKSPACE,
      deckId: process.env.AGENT_DECK_DECK_ID,
    });
  }

  /**
   * NOT-318: grant metadata store. An injected store (tests) wins; otherwise
   * the shared backend database file is opened lazily — only when a bearer
   * is presented or hosted mode requires one, so loopback-only processes
   * and existing tests never touch the database file.
   */
  private getGrantStore(): ClientGrantStore | null {
    if (this.grantStoreOverride !== undefined) {
      return this.grantStoreOverride;
    }
    if (this.grantStoreCache) {
      return this.grantStoreCache;
    }
    try {
      const dbPath = process.env.AGENT_DECK_DB_PATH?.trim() || resolveDatabasePath();
      this.sharedSecurityDb ??= new Database(dbPath);
      this.grantStoreCache = new ClientGrantStore(this.sharedSecurityDb);
      return this.grantStoreCache;
    } catch {
      return null;
    }
  }

  private getAuditStore(): AuditStore | null {
    if (this.auditStoreOverride !== undefined) return this.auditStoreOverride;
    if (this.auditStoreCache) return this.auditStoreCache;
    try {
      const dbPath = process.env.AGENT_DECK_DB_PATH?.trim() || resolveDatabasePath();
      this.sharedSecurityDb ??= new Database(dbPath);
      this.auditStoreCache = new AuditStore(this.sharedSecurityDb);
      return this.auditStoreCache;
    } catch {
      return null;
    }
  }

  /**
   * NOT-318: authenticate one bearer token to a grant principal. Every
   * failure mode (missing store, malformed, unknown id, secret mismatch,
   * expired, revoked) returns null — the caller answers one uniform 401
   * with no oracle. Touches `lastUsedAt`; never logs or returns the secret.
   */
  private authenticateGrant(
    token: string | null,
  ): Extract<import('./auth/client-grants').ClientPrincipal, { kind: 'grant' }> | null {
    if (!token) {
      return null;
    }
    const store = this.getGrantStore();
    if (!store) {
      return null;
    }
    return store.authenticateToken(token);
  }

  /** Actual listening port (resolves OS-assigned `port: 0` after `start()`). */
  getPort(): number {
    return this.port;
  }

  /**
   * One McpServer per transport session. Tools/resources close over `sessionId`
   * so concurrent requests cannot steal another session's backend authority.
   */
  private createMcpServer(sessionId: string): McpServer {
    const unassigned = this.sessionBinding.isUnassigned(sessionId);
    this.mcpServerForRegistration = new McpServer(
      {
        name: "agent-deck-server",
        version: getAgentDeckVersion(),
      },
      unassigned ? { instructions: UNASSIGNED_DECK_MESSAGE } : undefined,
    );
    this.setupTools(sessionId);
    if (!unassigned) {
      this.setupResources(sessionId);
    }
    const server = this.mcpServerForRegistration;
    this.mcpServerForRegistration = undefined;
    return server;
  }

  private async fetchDeck(
    deckId: string,
    sessionId: string,
  ): Promise<{ id: string; name: string }> {
    const deck = await fetch(`${this.backendUrl}/api/decks/${deckId}`, {
      headers: this.sessionBinding.getAgentHeaders(sessionId),
    });
    const body = (await deck.json()) as {
      success: boolean;
      error?: string;
      error_code?: string;
      data?: { id: string; name: string };
    };
    if (!deck.ok || !body.success || !body.data?.id) {
      throw parseBackendErrorBody(
        JSON.stringify(body),
        deck.status,
      );
    }
    return body.data;
  }

  private async buildBindingPayload(sessionId: string) {
    const snapshot = this.sessionBinding.getBinding(sessionId);
    const deck = snapshot.deckId
      ? await this.fetchDeck(snapshot.deckId, sessionId)
      : await this.callBackendAPI('/api/scope/deck', {}, sessionId);
    const badge = this.badgeBySession.get(sessionId);
    const cardCounts = deck ? countDeckCards(deck) : { mcp: 0, credentials: 0, playbooks: 0 };
    return {
      workspaceRoot: snapshot.workspaceRoot,
      deck_id: (deck?.id ?? snapshot.deckId) as string,
      deck_name: deck?.name as string,
      deck_source: resolveDeckBindingSource(snapshot),
      session_deck_override: this.sessionBinding.hasSessionDeckOverride(sessionId),
      mode: snapshot.mode ?? 'normal',
      runtime_session_id: snapshot.runtimeSessionId,
      badge,
      display_summary: formatDisplayLine(deck?.name ?? null, cardCounts, { badge }),
    };
  }

  private async registerLiveDisplay(sessionId: string): Promise<void> {
    const snapshot = this.sessionBinding.getBinding(sessionId);
    // A deck bind is what makes a session live; the workspace may be absent
    // (header/auto-bound sessions surface in the dashboard without a folder).
    const deck = await this.callBackendAPI('/api/scope/deck', {}, sessionId);
    if (!deck?.id || !deck?.name) {
      return;
    }

    const clientName = this.sessions.get(sessionId)?.server.server.getClientVersion()?.name;
    const result = await this.callBackendAPI(
      '/api/scope/live-display',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mcpSessionId: sessionId,
          workspaceRoot: snapshot.workspaceRoot,
          deckId: deck.id,
          deckName: deck.name,
          source: resolveDeckBindingSource(snapshot),
          clientName,
          cardCounts: countDeckCards(deck),
          updatedAt: new Date().toISOString(),
        }),
      },
      sessionId,
    );
    if (result && typeof result.badge === 'string') {
      this.badgeBySession.set(sessionId, result.badge);
    }
  }

  private static readonly TOUCH_DEBOUNCE_MS = 5_000;

  /**
   * Fire-and-forget lastActivityAt bump; only for sessions this process
   * registered (badge-holding). `force` bypasses the per-request debounce —
   * the keep-alive already runs on a minutes-long cadence, so debouncing it
   * would only delay proof of life.
   *
   * NOT-309 repair round 2: when the backend reports `found: false` the
   * entry was swept while this transport stayed open (host sleep longer
   * than the stale bound, then a status-line read on wake). Re-register so
   * the live session returns to the status line without a reconnect. An
   * explicit `found === false` is required — older backends answer `{}` and
   * must not trigger a re-register storm.
   */
  private touchLiveDisplay(sessionId: string, force = false): void {
    if (!this.badgeBySession.has(sessionId)) {
      return;
    }
    const now = Date.now();
    if (
      !force &&
      now - (this.lastTouchAtMs.get(sessionId) ?? 0) < AgentDeckMCPServer.TOUCH_DEBOUNCE_MS
    ) {
      return;
    }
    this.lastTouchAtMs.set(sessionId, now);
    void this.callBackendAPI(
      `/api/scope/live-display/${encodeURIComponent(sessionId)}/touch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ at: new Date().toISOString() }),
      },
      sessionId,
    )
      .then((result) => {
        // Guard against the close race: a keep-alive touch in flight when
        // transport.onclose sends DELETE answers found:false after the entry
        // is gone. Re-registering then would resurrect a closed session, so
        // only re-register while the transport is still open.
        if (result && result.found === false && this.sessions.has(sessionId)) {
          void this.registerLiveDisplay(sessionId).catch(() => {});
        }
      })
      .catch(() => {});
  }

  private static readonly UNREGISTER_TIMEOUT_MS = 3_000;

  /** Override via AGENT_DECK_MCP_UNREGISTER_TIMEOUT_MS (tests use a short value). */
  private static unregisterTimeoutMs(): number {
    const raw = process.env.AGENT_DECK_MCP_UNREGISTER_TIMEOUT_MS;
    if (!raw) {
      return AgentDeckMCPServer.UNREGISTER_TIMEOUT_MS;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : AgentDeckMCPServer.UNREGISTER_TIMEOUT_MS;
  }

  /**
   * NOT-309: keep the registry fresh for sessions with an open transport but
   * no tool calls. Only badge-holding (registered) sessions are touched; the
   * backend ignores touches for sessions it never saw, so unassigned or
   * half-initialized sessions are harmless no-ops by construction.
   */
  private touchAllLiveDisplays(): void {
    for (const sessionId of this.sessions.keys()) {
      this.touchLiveDisplay(sessionId, true);
    }
  }

  private startLiveDisplayKeepAlive(): void {
    this.stopLiveDisplayKeepAlive();
    const staleMs = resolveLiveDisplayStaleMs(process.env.LIVE_DISPLAY_STALE_MS);
    const intervalMs = resolveLiveTouchKeepAliveMs(
      process.env[LIVE_TOUCH_KEEPALIVE_ENV_VAR],
      staleMs,
    );
    if (intervalMs <= 0) {
      return;
    }
    const timer = setInterval(() => {
      this.touchAllLiveDisplays();
    }, intervalMs);
    timer.unref?.();
    this.liveTouchKeepAliveTimer = timer;
  }

  private stopLiveDisplayKeepAlive(): void {
    if (this.liveTouchKeepAliveTimer) {
      clearInterval(this.liveTouchKeepAliveTimer);
      this.liveTouchKeepAliveTimer = null;
    }
  }

  private async unregisterLiveDisplay(sessionId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      AgentDeckMCPServer.unregisterTimeoutMs(),
    );
    try {
      await this.callBackendAPI(
        `/api/scope/live-display/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE', signal: controller.signal },
        sessionId,
      );
    } catch {
      // Best effort when MCP session closes (includes abort on hung backend).
    } finally {
      clearTimeout(timer);
    }
  }

  private async callBackendAPI(
    endpoint: string,
    init: RequestInit = {},
    sessionId: string,
  ): Promise<any> {
    try {
      const headers = this.sessionBinding.getAgentHeaders(sessionId);
      const response = await fetch(`${this.backendUrl}${endpoint}`, {
        ...init,
        headers: {
          ...headers,
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        const text = await response.text();
        throw parseBackendErrorBody(text, response.status);
      }
      const body = await response.json();

      // Unwrap ApiResponse shape { success, data?, error? }
      if (typeof body === 'object' && body !== null && 'success' in body) {
        if (body.success) {
          // Some endpoints return the raw data (legacy); fallback to body if data missing
          return 'data' in body ? body.data : body;
        }
        const message = 'error' in body ? String(body.error) : 'Unknown backend error';
        const errorCode =
          'error_code' in body && body.error_code ? (body.error_code as BackendApiError['errorCode']) : undefined;
        throw new BackendApiError(
          message,
          response.ok ? 400 : response.status,
          errorCode,
        );
      }

      // Fallback: return as-is if not wrapped
      return body;
    } catch (error) {
      console.error(`Failed to call backend API ${endpoint}:`, error);
      throw error;
    }
  }

  private async getBoundDeckId(sessionId: string): Promise<string> {
    const deck = await this.callBackendAPI('/api/scope/deck', {}, sessionId);
    if (!deck?.id) {
      throw new Error('No bound deck — call bind_workspace (optionally with deckId) first');
    }
    return deck.id as string;
  }

  private toolResult(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }

  private toolError(error: unknown) {
    return formatMcpToolError(error);
  }

  /** Avoid TS2589 when registering many MCP tools (SDK overload recursion). */
  private registerTool(
    name: string,
    config: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (...args: any[]) => Promise<any>,
  ): void {
    (this.server as { registerTool: (...args: unknown[]) => unknown }).registerTool(
      name,
      config,
      handler,
    );
  }

  private async syncWorkspaceOnBind(
    workspaceRoot: string,
    deck: { id: string; name: string },
    sessionId: string,
  ): Promise<StubBindSyncResult | null> {
    if (!isStubSyncEnabled()) {
      return null;
    }

    const summaries = (await this.callBackendAPI(
      '/api/playbooks/summaries',
      {},
      sessionId,
    )) as PlaybookStubInput[];
    const stubs = syncPlaybookStubs(workspaceRoot, summaries ?? []);
    const manifestPath = healUseManifest(workspaceRoot, deck);
    ensureGitExcluded(workspaceRoot);

    await this.callBackendAPI(
      '/api/scope/deck-workspace',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceRoot, deckId: deck.id }),
      },
      sessionId,
    );

    return {
      stubs,
      host_reload_required: stubSyncChanged(stubs),
      manifestPath,
    };
  }

  private setupTools(sessionId: string) {
    // NOT-213: capture the session server while in the registration context;
    // the closures below run later at tool-call time and must not touch
    // `this.server` (registration-only getter).
    const elicitingServer = this.server;
    registerMcpTools({
      registerTool: (name, config, handler) => this.registerTool(name, config, handler),
      profile: this.toolProfile,
      unassigned: this.sessionBinding.isUnassigned(sessionId),
      getSessionId: () => sessionId,
      getMode: () => this.sessionBinding.getMode(sessionId) ?? 'normal',
      refreshRuntimeSession: () => this.refreshRuntimeSession(sessionId),
      getAgentHeaders: () => this.sessionBinding.getAgentHeaders(sessionId),
      getBoundDeckId: () => this.getBoundDeckId(sessionId),
      callBackendAPI: (endpoint, init) => this.callBackendAPI(endpoint, init ?? {}, sessionId),
      fetchDeck: (deckId) => this.fetchDeck(deckId, sessionId),
      buildBindingPayload: (id) => this.buildBindingPayload(id),
      registerLiveDisplay: (id) => this.registerLiveDisplay(id),
      syncWorkspaceOnBind: (workspaceRoot, deck) =>
        this.syncWorkspaceOnBind(workspaceRoot, deck, sessionId),
      sessionBinding: this.sessionBinding,
      badgeBySession: this.badgeBySession,
      backendUrl: this.backendUrl,
      toolResult: (data) => this.toolResult(data),
      toolError: (error) => this.toolError(error),
      // NOT-213: host-native approval form for this session. Capability
      // detection reads the capabilities the client reported at initialize;
      // elicitation itself goes through the session server so the host UI
      // answers. Timeouts/errors degrade to the browser fallback downstream.
      elicitation: {
        supportsFormElicitation: () =>
          supportsFormElicitation(elicitingServer.server.getClientCapabilities()),
        elicitForm: async (input) => {
          const params = {
            message: input.message,
            requestedSchema: input.requestedSchema,
          } as Parameters<typeof elicitingServer.server.elicitInput>[0];
          const result = await elicitingServer.server.elicitInput(params, {
            timeout: DECK_SWITCH_ELICITATION_TIMEOUT_MS,
          });
          return {
            action: result.action,
            ...(result.content ? { content: { ...result.content } } : {}),
          };
        },
      },
    });
  }


  private setupResources(sessionId: string) {
    this.server.resource("bound_deck_summary", "agent-deck://bound-deck/summary", {
      description: "One-line summary of the workspace-bound deck for status display",
      mimeType: "text/plain",
    }, async () => {
      try {
        const deck = await this.callBackendAPI('/api/scope/deck', {}, sessionId);
        const summary = formatDisplayLine(deck?.name ?? null, countDeckCards(deck ?? {}));

        return {
          contents: [{
            uri: "agent-deck://bound-deck/summary",
            mimeType: "text/plain",
            text: summary,
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: "agent-deck://bound-deck/summary",
            mimeType: "text/plain",
            text: formatDisplayLine(null, { mcp: 0, credentials: 0, playbooks: 0 }),
          }],
        };
      }
    });

    this.server.resource("bound_deck_services", "agent-deck://bound-deck/services", {
      description: "MCP services on the workspace-bound deck",
      mimeType: "application/json"
    }, async () => {
      try {
        const deck = await this.callBackendAPI('/api/scope/deck', {}, sessionId);
        const services = deck?.services ?? [];
        
        return {
          contents: [{
            uri: "agent-deck://bound-deck/services",
            mimeType: "application/json",
            text: JSON.stringify(services, null, 2)
          }]
        };
      } catch (error) {
        return {
          contents: [{
            uri: "agent-deck://bound-deck/services",
            mimeType: "application/json",
            text: JSON.stringify({ error: `Failed to get bound deck services: ${error}` }, null, 2)
          }]
        };
      }
    });

    this.server.resource("active_deck_services", "agent-deck://active-deck/services", {
      description: "Deprecated — use agent-deck://bound-deck/services",
      mimeType: "application/json"
    }, async () => {
      try {
        const deck = await this.callBackendAPI('/api/scope/deck', {}, sessionId);
        const services = deck?.services ?? [];
        
        return {
          contents: [{
            uri: "agent-deck://active-deck/services",
            mimeType: "application/json",
            text: JSON.stringify(services, null, 2)
          }]
        };
      } catch (error) {
        return {
          contents: [{
            uri: "agent-deck://active-deck/services",
            mimeType: "application/json",
            text: JSON.stringify({ error: `Failed to get bound deck services: ${error}` }, null, 2)
          }]
        };
      }
    });

    this.server.resource("bound_deck_credentials", "agent-deck://bound-deck/credentials", {
      description: "API key metadata on the workspace-bound deck",
      mimeType: "application/json"
    }, async () => {
      try {
        const credentials = await this.callBackendAPI('/api/credentials', {}, sessionId);

        return {
          contents: [{
            uri: "agent-deck://bound-deck/credentials",
            mimeType: "application/json",
            text: JSON.stringify(credentials, null, 2)
          }]
        };
      } catch (error) {
        return {
          contents: [{
            uri: "agent-deck://bound-deck/credentials",
            mimeType: "application/json",
            text: JSON.stringify({ error: `Failed to get bound deck credentials: ${error}` }, null, 2)
          }]
        };
      }
    });

    this.server.resource("active_deck_credentials", "agent-deck://active-deck/credentials", {
      description: "Deprecated — use agent-deck://bound-deck/credentials",
      mimeType: "application/json"
    }, async () => {
      try {
        const credentials = await this.callBackendAPI('/api/credentials', {}, sessionId);

        return {
          contents: [{
            uri: "agent-deck://active-deck/credentials",
            mimeType: "application/json",
            text: JSON.stringify(credentials, null, 2)
          }]
        };
      } catch (error) {
        return {
          contents: [{
            uri: "agent-deck://active-deck/credentials",
            mimeType: "application/json",
            text: JSON.stringify({ error: `Failed to get bound deck credentials: ${error}` }, null, 2)
          }]
        };
      }
    });

    this.server.resource("bound_deck", "agent-deck://bound-deck", {
      description: "Deck bound to this MCP session",
      mimeType: "application/json"
    }, async () => {
      try {
        const deck = await this.callBackendAPI('/api/scope/deck', {}, sessionId);
        
        return {
          contents: [{
            uri: "agent-deck://bound-deck",
            mimeType: "application/json",
            text: JSON.stringify(deck, null, 2)
          }]
        };
      } catch (error) {
        return {
          contents: [{
            uri: "agent-deck://bound-deck",
            mimeType: "application/json",
            text: JSON.stringify({ error: `Failed to get bound deck: ${error}` }, null, 2)
          }]
        };
      }
    });

    this.server.resource("active_deck", "agent-deck://active-deck", {
      description: "Deprecated — use agent-deck://bound-deck",
      mimeType: "application/json"
    }, async () => {
      try {
        const deck = await this.callBackendAPI('/api/scope/deck', {}, sessionId);
        
        return {
          contents: [{
            uri: "agent-deck://active-deck",
            mimeType: "application/json",
            text: JSON.stringify(deck, null, 2)
          }]
        };
      } catch (error) {
        return {
          contents: [{
            uri: "agent-deck://active-deck",
            mimeType: "application/json",
            text: JSON.stringify({ error: `Failed to get bound deck: ${error}` }, null, 2)
          }]
        };
      }
    });

    // Register resource for all decks
    this.server.resource("decks", "agent-deck://decks", {
      description: "List of all available decks",
      mimeType: "application/json"
    }, async () => {
      try {
        const decks = await this.callBackendAPI('/api/decks', {}, sessionId);
        
        return {
          contents: [{
            uri: "agent-deck://decks",
            mimeType: "application/json",
            text: JSON.stringify(decks, null, 2)
          }]
        };
      } catch (error) {
        return {
          contents: [{
            uri: "agent-deck://decks",
            mimeType: "application/json",
            text: JSON.stringify({ error: `Failed to get decks: ${error}` }, null, 2)
          }]
        };
      }
    });
  }

  private setupRoutes() {
    this.app.post('/mcp', async (req: Request, res: Response) => {
      await this.handleMcpPost(req, res);
    });

    this.app.get('/mcp', async (req: Request, res: Response) => {
      await this.handleMcpSessionRequest(req, res);
    });

    this.app.delete('/mcp', async (req: Request, res: Response) => {
      await this.handleMcpSessionRequest(req, res);
    });

    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'agent-deck-mcp-server',
        backendUrl: this.backendUrl,
        toolProfile: this.toolProfile,
        instanceId: this.instanceId,
        startedAt: this.startedAt,
        liveSessions: this.sessions.size,
        staleSessions: this.getStaleSessionStats(),
      });
    });

    // Backend connectivity check
    this.app.get('/backend-status', async (req: Request, res: Response) => {
      try {
        const response = await fetch(`${this.backendUrl}/health`);
        const backendStatus = await response.json();
        res.json({
          mcpServer: 'ok',
          backend: backendStatus,
          connected: response.ok
        });
      } catch (error) {
        res.json({
          mcpServer: 'ok',
          backend: 'unreachable',
          connected: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  private getSessionIdHeader(req: Request): string | undefined {
    const value = req.headers['mcp-session-id'];
    return typeof value === 'string' ? value : undefined;
  }

  private getStaleSessionStats(): StaleSessionStats {
    let recoveredSessions = 0;
    let lastUnresolvedAt: string | undefined;
    for (const entry of this.staleSessionsById.values()) {
      if (entry.recovered) {
        recoveredSessions += 1;
        continue;
      }
      if (!lastUnresolvedAt || entry.lastAt > lastUnresolvedAt) {
        lastUnresolvedAt = entry.lastAt;
      }
    }

    return {
      count: this.staleSessionCount,
      distinctSessions: this.staleSessionsById.size,
      recoveredSessions,
      unresolvedSessions: this.staleSessionsById.size - recoveredSessions,
      lastSessionId: this.staleSessionLastId,
      firstAt: this.staleSessionFirstAt,
      lastAt: this.staleSessionLastAt,
      lastUnresolvedAt,
    };
  }

  /**
   * A client that re-initializes after a restart names the session it lost, so we
   * can stop counting it as stranded. Without this the tally only ever grows and
   * `agent-deck status` would warn about clients that recovered on their own
   * seconds earlier.
   *
   * Call this only once the replacement session exists: a handshake that is then
   * rejected (launch-deck auth, a transport that fails to initialize) leaves the
   * client just as stranded as before, and clearing the warning for it would hide
   * exactly the case operators need to see.
   */
  private markStaleSessionRecovered(req: Request): void {
    // Node lower-cases request header names, which is how the constant is written.
    const header = req.headers[AGENT_DECK_RECOVERED_SESSION_HEADER];
    const recoveredId = Array.isArray(header) ? header[0] : header;
    if (!recoveredId) {
      return;
    }
    const entry = this.staleSessionsById.get(recoveredId);
    if (entry) {
      entry.recovered = true;
    }
  }

  /**
   * Answer a request carrying a session id this process never issued (NOT-101).
   *
   * The streamable-HTTP spec says a server MUST reply 404 to an unknown
   * `Mcp-Session-Id`, and that a client seeing 404 MUST re-initialize. The old
   * 400 "Bad Request: No valid session ID provided" was indistinguishable from a
   * malformed request, so bridges parked on it forever instead of reconnecting.
   */
  private sendSessionNotFound(sessionId: string, res: Response): void {
    if (this.closedSessionIds.has(sessionId)) {
      // We issued this session and it ended here; the client is not stranded.
      this.sendSessionExpired(sessionId, res);
      return;
    }

    const at = new Date().toISOString();
    const known = this.staleSessionsById.get(sessionId);

    this.staleSessionCount += 1;
    this.staleSessionLastId = sessionId;
    this.staleSessionLastAt = at;
    this.staleSessionFirstAt ??= at;
    if (known) {
      // Note the attempt, but never un-recover: once a client has re-initialized it
      // holds a session of ours and keeps using it. What still arrives on the old id
      // is a request that was already in flight when the restart hit, and the bridge
      // will not handshake again for it — so flipping this back would strand a
      // healthy client in `agent-deck status` with nothing left to clear it.
      known.lastAt = at;
    } else if (this.staleSessionsById.size < AgentDeckMCPServer.STALE_SESSION_SAMPLE_LIMIT) {
      this.staleSessionsById.set(sessionId, { recovered: false, lastAt: at });
    }

    // One line per session id, not per request — a wedged bridge retries forever.
    if (!known) {
      console.warn(
        `[agent-deck] MCP session ${sessionId} is unknown to this process ` +
          `(instance ${this.instanceId}, started ${this.startedAt}). ` +
          'The client connected before the last restart; replying 404 so it re-initializes.',
      );
    }

    this.sendSessionExpired(sessionId, res);
  }

  /** The wire half of a 404: the same answer whether or not the session was tallied. */
  private sendSessionExpired(sessionId: string, res: Response): void {
    res.status(404)
      .set('mcp-session-status', 'expired')
      .json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message:
            `Session not found: ${sessionId}. The Agent Deck MCP server restarted ` +
            `(instance ${this.instanceId}, started ${this.startedAt}); re-initialize to get a new session.`,
        },
        id: null,
      });
  }

  /** Remember a session we closed ourselves, keeping the set bounded like the tally. */
  private rememberClosedSession(sessionId: string): void {
    if (this.closedSessionIds.size >= AgentDeckMCPServer.STALE_SESSION_SAMPLE_LIMIT) {
      const oldest = this.closedSessionIds.values().next().value;
      if (oldest !== undefined) {
        this.closedSessionIds.delete(oldest);
      }
    }
    this.closedSessionIds.add(sessionId);
  }

  private async refreshRuntimeSession(sessionId: string): Promise<{ mode: 'normal' | 'agent-admin'; deckId: string }> {
    const binding = this.sessionBinding.getBinding(sessionId);
    if (!binding.runtimeSessionId) {
      throw new Error('GRANT_REQUIRED');
    }

    const data = await this.callBackendAPI('/api/trusted-session/runtime-session', {}, sessionId);
    const mode = (data?.mode ?? 'normal') as 'normal' | 'agent-admin';
    const deckId = String(data?.deckId ?? binding.deckId ?? '');

    this.sessionBinding.setTrustedSession(sessionId, {
      runtimeSessionId: binding.runtimeSessionId,
      deckId,
      workspaceRoot: binding.workspaceRoot,
      mode,
    });

    return { mode, deckId };
  }

  private sendDeckRequired(res: Response): void {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'GRANT_REQUIRED' },
      id: null,
    });
  }

  /**
   * NOT-318: the single 401 envelope for every credential failure on a
   * hosted endpoint (missing / malformed / invalid / expired / revoked).
   * Byte-identical every time — including the constant `WWW-Authenticate:
   * Bearer` challenge — so probers learn nothing, and generic HTTP
   * clients stay well-behaved. Never carries grant state or deck detail.
   */
  private sendGrantRequired(res: Response): void {
    res.status(401).set('WWW-Authenticate', 'Bearer').json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'GRANT_REQUIRED' },
      id: null,
    });
  }

  /**
   * NOT-318: authenticated but outside the grant allowlist. Only reachable
   * post-auth, so it oracles the allowlist solely to the already-
   * authenticated owner. Transport kept.
   */
  private sendOutOfScope(res: Response): void {
    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'RESOURCE_OUT_OF_SCOPE' },
      id: null,
    });
  }

  /**
   * NOT-318: bind a fresh MCP session to an authenticated grant principal.
   * Mirrors `authenticateLaunchDeck` (workspace + correlation handling) but
   * resolves through the grant: the deck was already constrained by
   * `resolveGrantDeck`, and the owning grant id is linked on the runtime
   * session so deck-switch creation/approval enforces the same allowlist.
   */
  private async authenticateGrantDeck(
    sessionId: string,
    req: Request,
    principal: Extract<import('./auth/client-grants').ClientPrincipal, { kind: 'grant' }>,
    deckId: string,
  ): Promise<void> {
    const response = await fetch(`${this.backendUrl}/api/trusted-session/mcp/connect-deck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        deckId,
        mcpSessionId: sessionId,
        grantId: principal.grantId,
      }),
    });

    const body = (await response.json()) as {
      success?: boolean;
      error?: string;
      data?: {
        sessionId: string;
        deckId: string;
        deckName?: string;
        mode: 'normal' | 'agent-admin';
      };
    };

    if (!response.ok || !body.success || !body.data) {
      throw new Error(body.error ?? 'GRANT_DECK_INVALID');
    }

    const existing = this.sessionBinding.getBinding(sessionId);
    const workspaceRoot =
      readWorkspaceRootHeader(req) ??
      existing.workspaceRoot ??
      (process.env.AGENT_DECK_WORKSPACE?.trim() || undefined);

    this.sessionBinding.setGrantSession(sessionId, {
      grantId: principal.grantId,
      label: principal.label,
      defaultDeck: principal.defaultDeck,
      allowedDecks: principal.allowedDecks,
      runtimeSessionId: body.data.sessionId,
      deckId: body.data.deckId,
      workspaceRoot,
      mode: body.data.mode,
    });

    const correlationId = readCorrelationIdHeader(req);
    if (correlationId) {
      this.sessionBinding.setCorrelationId(sessionId, correlationId);
    }
  }

  /**
   * NOT-318: revalidate a grant-bound session on every follow-up request.
   * The grant (not a cached decision) is re-resolved per request, so
   * revocation and expiry fail the *next* request closed — no grace
   * window, strictly inside the 60s bound. The deck header is
   * request-only: a header outside the allowlist is denied with 403 and
   * the binding is left untouched; a header for another allowed deck is
   * ignored (deck changes go through human-approved switch_deck, which
   * re-checks the same allowlist). Transport kept on every denial so a
   * correct credential on the next attempt can succeed.
   */
  private async requireGrantFollowUp(sessionId: string, req: Request, res: Response): Promise<boolean> {
    const scope = this.sessionBinding.getGrantScope(sessionId);
    if (!scope) {
      this.sendGrantRequired(res);
      return false;
    }
    const principal = this.authenticateGrant(readBearerToken(req));
    if (!principal || principal.grantId !== scope.grantId) {
      const presented = parseGrantToken(readBearerToken(req) ?? '');
      console.warn(
        '[agent-deck] Grant follow-up auth failed (transport kept):',
        `grantId=${presented?.grantId ?? 'none'}`,
      );
      this.sendGrantRequired(res);
      return false;
    }
    // Renew the backend lease and pick up post-approval deck/mode moves,
    // mirroring the launch follow-up refresh. A backend-revoked session
    // (grant revoked via the owner API) fails closed here as well.
    try {
      await this.refreshRuntimeSession(sessionId);
    } catch {
      console.warn(
        '[agent-deck] Grant session refresh failed (transport kept):',
        `grantId=${principal.grantId}`,
      );
      this.sendGrantRequired(res);
      return false;
    }
    // The unified authorization path: the session principal must allow
    // the requested deck. `principalAllowsDeck` is the same check local
    // launch sessions resolve through (local principals allow all).
    const header = readLaunchDeckHeader(req);
    const boundDeck = this.sessionBinding.getBinding(sessionId).deckId;
    if (header && header !== boundDeck && !principalAllowsDeck(principal, header)) {
      this.getAuditStore()?.append({
        actor: principal.grantId as AuditActor,
        event: 'deck.selection_denied',
        targetId: auditDeckTarget(header),
        outcome: 'denied',
        reasonCode: 'resource_out_of_scope',
      });
      console.warn(
        '[agent-deck] Grant follow-up deck denied (transport kept):',
        `grantId=${principal.grantId}`,
      );
      this.sendOutOfScope(res);
      return false;
    }
    const workspaceRoot = readWorkspaceRootHeader(req);
    if (workspaceRoot) {
      this.sessionBinding.setWorkspace(sessionId, workspaceRoot);
    }
    const followUpCorrelation = readCorrelationIdHeader(req);
    if (followUpCorrelation) {
      this.sessionBinding.setCorrelationId(sessionId, followUpCorrelation);
    }
    return true;
  }

  private async authenticateLaunchDeck(sessionId: string, req: Request): Promise<void> {
    const deckId = readLaunchDeckHeader(req);
    if (!deckId) {
      throw new Error('GRANT_REQUIRED');
    }

    const existing = this.sessionBinding.getBinding(sessionId);
    // Follow-up after elevated assignment switch (NOT-108): the launcher may still
    // send the old deck header until reconnect. Keep the runtime session and refresh.
    if (this.sessionBinding.isLaunchSession(sessionId) && existing.runtimeSessionId) {
      await this.refreshRuntimeSession(sessionId);
      const workspaceRoot =
        readWorkspaceRootHeader(req) ??
        existing.workspaceRoot ??
        (process.env.AGENT_DECK_WORKSPACE?.trim() || undefined);
      if (workspaceRoot) {
        this.sessionBinding.setWorkspace(sessionId, workspaceRoot);
      }
      // Adopt-once: a launch that arrived without correlation can still
      // attach one; an established value never moves (NOT-304).
      const followUpCorrelation = readCorrelationIdHeader(req);
      if (followUpCorrelation) {
        this.sessionBinding.setCorrelationId(sessionId, followUpCorrelation);
      }
      return;
    }

    const response = await fetch(`${this.backendUrl}/api/trusted-session/mcp/connect-deck`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        deckId,
        mcpSessionId: sessionId,
      }),
    });

    const body = (await response.json()) as {
      success?: boolean;
      error?: string;
      data?: {
        sessionId: string;
        deckId: string;
        deckName?: string;
        mode: 'normal' | 'agent-admin';
      };
    };

    if (!response.ok || !body.success || !body.data) {
      throw new Error(body.error ?? 'LAUNCH_DECK_INVALID');
    }

    const workspaceRoot =
      readWorkspaceRootHeader(req) ??
      existing.workspaceRoot ??
      (process.env.AGENT_DECK_WORKSPACE?.trim() || undefined);

    this.sessionBinding.setLaunchSession(sessionId, {
      runtimeSessionId: body.data.sessionId,
      deckId: body.data.deckId,
      workspaceRoot,
      mode: body.data.mode,
    });

    // Attach the opaque run-correlation id to this launch-selected session
    // (NOT-304). Adopt-once and validated inside the store: an invalid or
    // later-changed value can never affect deck, workspace, mode, or auth.
    const correlationId = readCorrelationIdHeader(req);
    if (correlationId) {
      this.sessionBinding.setCorrelationId(sessionId, correlationId);
    }
  }

  private async disconnectTrustedSession(sessionId: string, _req: Request): Promise<void> {
    if (this.sessionBinding.isLaunchSession(sessionId) || this.sessionBinding.isGrantSession(sessionId)) {
      try {
        await fetch(`${this.backendUrl}/api/trusted-session/mcp/disconnect-deck`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ mcpSessionId: sessionId }),
        });
      } catch {
        // best-effort cleanup
      }
    }
  }

  /**
   * Re-validate launch deck on every follow-up MCP HTTP request.
   * Fail closed with 401 for launch sessions that drop the deck header — do not
   * destroy the transport session so a correct credential on the next attempt
   * can succeed. Unassigned sessions (NOT-50) have no deck and stay open.
   * AGENT_DECK_MCP_SKIP_DECK_HEADER=1 only relaxes *missing* deck header (unit tests).
   */
  private async requireFollowUpDeckHeader(sessionId: string, req: Request, res: Response): Promise<boolean> {
    const skipDeckHeader = skipDeckHeaderAuth();

    // Unassigned sessions stay explain-only for their lifetime. A late deck header
    // must not promote them into a trusted launch session mid-flight (NOT-50).
    if (this.sessionBinding.isUnassigned(sessionId)) {
      return true;
    }

    const launchDeck = readLaunchDeckHeader(req);
    if (launchDeck) {
      try {
        await this.authenticateLaunchDeck(sessionId, req);
        return true;
      } catch (error) {
        console.warn(
          '[agent-deck] Follow-up launch-deck auth failed (transport kept):',
          error instanceof Error ? error.message : error,
        );
        this.sendLaunchDeckInvalid(
          res,
          error instanceof Error ? error.message : 'LAUNCH_DECK_INVALID',
        );
        return false;
      }
    }

    if (this.sessionBinding.isLaunchSession(sessionId)) {
      this.sendDeckRequired(res);
      return false;
    }

    if (skipDeckHeader) {
      return true;
    }
    this.sendDeckRequired(res);
    return false;
  }

  private sendLaunchDeckInvalid(res: Response, message: string): void {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: `LAUNCH_DECK_INVALID: ${message}` },
      id: null,
    });
  }

  /**
   * NOT-318: initialize with a bearer grant. Authenticates before
   * advertising any `mcp-session-id`: failure answers the uniform 401
   * with no transport or session record created. Success binds the fresh
   * session to the grant-constrained deck (absent header → default;
   * out-of-grant header → 403, no session).
   */
  private async handleGrantInitialize(req: Request, res: Response, bearer: string): Promise<void> {
    const principal = this.authenticateGrant(bearer);
    if (!principal) {
      const presented = parseGrantToken(bearer);
      console.warn(
        '[agent-deck] Grant initialize auth failed (no session created):',
        `grantId=${presented?.grantId ?? 'none'}`,
      );
      this.sendGrantRequired(res);
      return;
    }
    const deckId = resolveGrantDeck(principal, readLaunchDeckHeader(req));
    if (!deckId) {
      this.getAuditStore()?.append({
        actor: principal.grantId as AuditActor,
        event: 'deck.selection_denied',
        targetId: auditDeckTarget(readLaunchDeckHeader(req)!),
        outcome: 'denied',
        reasonCode: 'resource_out_of_scope',
      });
      console.warn(
        '[agent-deck] Grant initialize deck denied (no session created):',
        `grantId=${principal.grantId}`,
      );
      this.sendOutOfScope(res);
      return;
    }
    const sessionId = randomUUID();
    try {
      await this.authenticateGrantDeck(sessionId, req, principal, deckId);
    } catch (error) {
      console.warn(
        '[agent-deck] Grant deck bind failed before MCP init (no session created):',
        `grantId=${principal.grantId}`,
        error instanceof Error ? error.message : error,
      );
      this.sessionBinding.clearSession(sessionId);
      this.sendGrantRequired(res);
      return;
    }
    this.getAuditStore()?.append({
      actor: principal.grantId as AuditActor,
      event: 'grant.used',
      targetId: auditDeckTarget(deckId),
      outcome: 'succeeded',
      reasonCode: null,
    });
    await this.establishTransportSession(req, res, sessionId);
  }

  private async handleMcpPost(req: Request, res: Response): Promise<void> {
    const sessionIdHeader = this.getSessionIdHeader(req);
    const existing = sessionIdHeader ? this.sessions.get(sessionIdHeader) : undefined;
    const bearerRequired = isBearerGrantRequired();

    if (existing && sessionIdHeader) {
      // Grant-bound sessions revalidate the bearer on every request and
      // never take the trust-the-header launch path: a forged deck header
      // is denied by the grant allowlist, not trusted into a new deck.
      if (this.sessionBinding.isGrantSession(sessionIdHeader)) {
        if (!(await this.requireGrantFollowUp(sessionIdHeader, req, res))) {
          return;
        }
      } else {
        // Hosted mode has no bearer-free sessions; a non-grant session id
        // is unusable there — fail closed before touching the transport.
        if (bearerRequired) {
          this.sendGrantRequired(res);
          return;
        }
        if (!(await this.requireFollowUpDeckHeader(sessionIdHeader, req, res))) {
          return;
        }
      }
      this.touchLiveDisplay(sessionIdHeader);
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    const body = req.body;
    const isInit =
      body &&
      typeof body === 'object' &&
      (isInitializeRequest(body) ||
        (Array.isArray(body) && body.some((message) => isInitializeRequest(message))));

    if (isInit && process.env.AGENT_DECK_HOSTED_MODE === '1') {
      const principal = this.authenticateGrant(readBearerToken(req));
      const clientKey = principal
        ? `grant:${principal.grantId}`
        : `ip:${req.socket.remoteAddress ?? 'unknown'}`;
      const rate = this.initializeLimiter.consume(clientKey, MCP_INITIALIZE_RATE_LIMIT);
      if (!rate.allowed) {
        res.set('Retry-After', String(rate.retryAfterSeconds));
        res.status(429).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Too many initialize requests' },
          id: null,
        });
        return;
      }
    }

    if (!isInit) {
      // Hosted endpoints run the bearer-grant gate before session
      // existence: an unauthenticated prober gets 401, never the NOT-101
      // 404 body (which echoes the session id plus instance metadata).
      if (bearerRequired && !this.authenticateGrant(readBearerToken(req))) {
        this.sendGrantRequired(res);
        return;
      }
      // A session id we don't know is a restart, not a malformed request — 404 so
      // the client re-initializes. An initialize carrying a stale id falls through
      // and gets a fresh session, which is exactly the recovery we want.
      if (sessionIdHeader) {
        this.sendSessionNotFound(sessionIdHeader, res);
        return;
      }
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
      return;
    }

    // A presented bearer always resolves as a remote grant — even in local
    // mode — while loopback launcher connections without one keep the
    // existing deck-header path with zero config change.
    const presentedBearer = readBearerToken(req);
    if (presentedBearer) {
      await this.handleGrantInitialize(req, res, presentedBearer);
      return;
    }
    if (bearerRequired) {
      this.sendGrantRequired(res);
      return;
    }

    const launchDeck = readLaunchDeckHeader(req);
    const skipDeckHeader = skipDeckHeaderAuth();
    const unassigned = !launchDeck && !skipDeckHeader;

    // Authenticate before advertising mcp-session-id.
    const sessionId = randomUUID();
    if (launchDeck) {
      try {
        await this.authenticateLaunchDeck(sessionId, req);
      } catch (error) {
        this.getAuditStore()?.append({
          actor: 'local-launch',
          event: 'deck.selection_denied',
          targetId: auditDeckTarget(launchDeck),
          outcome: 'denied',
          reasonCode: 'resource_out_of_scope',
        });
        console.warn(
          '[agent-deck] Launch-deck auth failed before MCP init:',
          error instanceof Error ? error.message : error,
        );
        this.sendLaunchDeckInvalid(
          res,
          error instanceof Error ? error.message : 'LAUNCH_DECK_INVALID',
        );
        return;
      }
    } else if (unassigned) {
      this.sessionBinding.markUnassigned(sessionId);
      const workspaceRoot = readWorkspaceRootHeader(req);
      if (workspaceRoot) {
        this.sessionBinding.setWorkspace(sessionId, workspaceRoot);
      }
    }

    await this.establishTransportSession(req, res, sessionId);
  }

  /**
   * Shared transport handshake tail: create the per-session MCP server,
   * connect the streamable transport, and register the live session. Runs
   * only after the session is authenticated and bound (launch, grant, or
   * unassigned) — never before.
   */
  private async establishTransportSession(req: Request, res: Response, sessionId: string): Promise<void> {
    const body = req.body;
    const server = this.createMcpServer(sessionId);
    let sessionEntry: McpSession | undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
      onsessioninitialized: (initializedSessionId) => {
        sessionEntry = { transport, server };
        this.sessions.set(initializedSessionId, sessionEntry);
      },
    });

    transport.onclose = () => {
      const closedSessionId = transport.sessionId;
      if (closedSessionId) {
        this.sessions.delete(closedSessionId);
        this.rememberClosedSession(closedSessionId);
        // Unregister while session headers still resolve — clearSession would drop
        // the runtime session id and live-display DELETE would 401.
        const task = this.unregisterLiveDisplay(closedSessionId).finally(() => {
          this.sessionBinding.clearSession(closedSessionId);
          this.badgeBySession.delete(closedSessionId);
          this.lastTouchAtMs.delete(closedSessionId);
          this.unregisterTasks.delete(closedSessionId);
        });
        this.unregisterTasks.set(closedSessionId, task);
      }
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.warn(
        '[agent-deck] MCP initialize failed after session auth — revoking runtime session:',
        error instanceof Error ? error.message : error,
      );
      this.sessions.delete(sessionId);
      await this.disconnectTrustedSession(sessionId, req);
      this.sessionBinding.clearSession(sessionId);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'MCP initialize failed' },
          id: null,
        });
      }
      return;
    }

    if (transport.sessionId && !this.sessions.has(transport.sessionId)) {
      this.sessions.set(transport.sessionId, { transport, server });
    }

    if (transport.sessionId) {
      // The replacement session is live, so the session this client lost to the
      // restart is genuinely recovered and no longer a stranded client.
      this.markStaleSessionRecovered(req);
      if (!this.sessionBinding.isUnassigned(transport.sessionId)) {
        void this.registerLiveDisplay(transport.sessionId).catch(() => {});
      }
    }
  }

  private async handleMcpSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = this.getSessionIdHeader(req);
    const bearerRequired = isBearerGrantRequired();

    // Hosted endpoints run the Bearer [REDACTED] before session existence
    // (same no-oracle order as POST): 401 before any 404 metadata.
    if (bearerRequired && !this.authenticateGrant(readBearerToken(req))) {
      this.sendGrantRequired(res);
      return;
    }

    if (!sessionId) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sendSessionNotFound(sessionId, res);
      return;
    }

    if (this.sessionBinding.isGrantSession(sessionId)) {
      if (!(await this.requireGrantFollowUp(sessionId, req, res))) {
        return;
      }
    } else {
      if (bearerRequired) {
        this.sendGrantRequired(res);
        return;
      }
      if (!(await this.requireFollowUpDeckHeader(sessionId, req, res))) {
        return;
      }
    }

    this.touchLiveDisplay(sessionId);
    await session.transport.handleRequest(req, res);
  }

  async start() {
    if (this.httpServer) {
      throw new Error('MCP server already started');
    }

    try {
      console.log(
        `🚀 Starting Agent Deck MCP Server on port ${this.port === 0 ? '(OS-assigned)' : this.port}...`,
      );
      console.log(`🔗 Backend API URL: ${this.backendUrl}`);

      await new Promise<void>((resolve, reject) => {
        const httpServer = this.app.listen(this.port, this.host, () => {
          const address = httpServer.address();
          if (typeof address === 'object' && address && typeof address.port === 'number') {
            this.port = address.port;
          }
          console.log(`✅ Agent Deck MCP Server is ready to accept connections`);
          console.log(`📋 Available tools:`);
          console.log(`   - bind_workspace: Bind session to workspace + deck (deckId required)`);
          console.log(`   - switch_deck: Request a human-approved deck switch (session or workspace default)`);
          console.log(`   - get_session_context: One-call session bootstrap (workspace + deck + cards)`);
          console.log(`   - get_session_binding: Show session workspace + effective deck`);
          console.log(`   - get_bound_deck: Get session-bound deck`);
          console.log(`   - list_service_tools: List tools for a specific service`);
          console.log(`   - call_service_tool: Call a tool on a service`);
          console.log(`📋 Available resources:`);
          console.log(`   - agent-deck://decks: List of all available decks`);
          console.log(`   - agent-deck://active-deck: The currently active deck`);
          console.log(`   - agent-deck://active-deck/credentials: API keys on the active deck`);
          console.log(`   - agent-deck://active-deck/services: Services in the active deck`);
          console.log(`🌐 Server running on http://${this.host}:${this.port}`);
          console.log(`🔧 MCP endpoint: http://${this.host}:${this.port}/mcp`);
          console.log(`❤️  Health check: http://${this.host}:${this.port}/health`);
          console.log(`🔗 Backend status: http://${this.host}:${this.port}/backend-status`);
          console.log(`📝 Architecture: MCP Server → Backend API → Active Deck Services`);
          resolve();
        });
        httpServer.once('error', reject);
        this.httpServer = httpServer;
      });
      this.startLiveDisplayKeepAlive();

      return this.app;
    } catch (error) {
      this.httpServer = null;
      console.error(`❌ Failed to start MCP server:`, error);
      throw error;
    }
  }

  async stop() {
    try {
      this.stopLiveDisplayKeepAlive();
      for (const [sessionId, session] of this.sessions) {
        try {
          await session.transport.close();
        } catch (error) {
          console.error(`Error closing MCP session ${sessionId}:`, error);
        }
      }
      this.sessions.clear();
      // Drain fire-and-forget live-display unregisters before tearing down HTTP —
      // otherwise tests close the stub backend and see ECONNRESET console.error noise.
      await Promise.all([...this.unregisterTasks.values()]);

      // Release the port too, otherwise a restart on the same port races the old
      // listener and the "did it come back?" probe can't tell the two apart.
      await this.closeHttpServer();
      this.sharedSecurityDb?.close();
      this.sharedSecurityDb = null;
      this.grantStoreCache = null;
      this.auditStoreCache = null;
      console.log(`🛑 MCP server stopped`);
    } catch (error) {
      console.error(`❌ Error stopping MCP server:`, error);
      throw error;
    }
  }

  private async closeHttpServer(): Promise<void> {
    const server = this.httpServer;
    if (!server) {
      return;
    }
    this.httpServer = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Keep-alive sockets (the SSE stream in particular) never end on their own.
      server.closeAllConnections?.();
    });
  }
}
