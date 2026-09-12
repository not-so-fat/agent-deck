import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_DECK_WORKSPACE_HEADER,
  countDeckCards,
  formatDisplayLine,
} from '@agent-deck/shared';
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAgentDeckVersion } from './lib/version';
import { parseBearerToken, parseWorkspaceGrantBearer } from './lib/http-auth';
import { parseAuthorityBearer } from './execution-authority/bearer';
import { BackendApiError, parseBackendErrorBody } from './lib/backend-api-error';
import { formatMcpToolError } from './mcp-tools/policy';
import {
  McpSessionBindingStore,
  resolveDeckBindingSource,
} from './mcp-session-binding';
import { registerMcpTools } from './mcp-tools/register';
import { McpToolProfile, resolveMcpToolProfile } from './mcp-tools/profile';
import {
  healUseManifest,
  isStubSyncEnabled,
  stubSyncChanged,
  syncPlaybookStubs,
  type StubBindSyncResult,
  type PlaybookStubInput,
} from './playbooks/stub-sync';

function readWorkspaceRootHeader(req: Request): string | undefined {
  const raw = req.headers[AGENT_DECK_WORKSPACE_HEADER];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || undefined;
}

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

export class AgentDeckMCPServer {
  private port: number;
  private host: string;
  private app: express.Application;
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

  private get server(): McpServer {
    if (!this.mcpServerForRegistration) {
      throw new Error('Internal: MCP server not in registration context');
    }
    return this.mcpServerForRegistration;
  }

  constructor(
    port: number = 3001,
    backendUrl: string = 'http://localhost:8000',
    toolProfile?: McpToolProfile,
    host: string = '127.0.0.1',
  ) {
    this.port = port;
    this.backendUrl = backendUrl;
    this.toolProfile = toolProfile ?? resolveMcpToolProfile();
    this.host = host;

    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();

    this.sessionBinding = new McpSessionBindingStore({
      workspace: process.env.AGENT_DECK_WORKSPACE,
      deckId: process.env.AGENT_DECK_DECK_ID,
    });
  }

  /**
   * One McpServer per transport session. Tools/resources close over `sessionId`
   * so concurrent requests cannot steal another session's backend authority.
   */
  private createMcpServer(sessionId: string): McpServer {
    this.mcpServerForRegistration = new McpServer({
      name: "agent-deck-server",
      version: getAgentDeckVersion(),
    });
    this.setupTools(sessionId);
    this.setupResources(sessionId);
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

  /** Fire-and-forget lastActivityAt bump; only for sessions the registry knows. */
  private touchLiveDisplay(sessionId: string): void {
    if (!this.badgeBySession.has(sessionId)) {
      return;
    }
    const now = Date.now();
    if (now - (this.lastTouchAtMs.get(sessionId) ?? 0) < AgentDeckMCPServer.TOUCH_DEBOUNCE_MS) {
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
    ).catch(() => {});
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
      throw new Error('No bound deck — call bind_workspace (optionally with deckId) or switch_bound_deck first');
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
    registerMcpTools({
      registerTool: (name, config, handler) => this.registerTool(name, config, handler),
      profile: this.toolProfile,
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

  private async refreshRuntimeSession(sessionId: string): Promise<{ mode: 'normal' | 'agent-admin'; deckId: string }> {
    const binding = this.sessionBinding.getBinding(sessionId);
    if (binding.authorityId && binding.deckId) {
      return { mode: 'normal', deckId: binding.deckId };
    }
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

  private parseGrantBearer(req: Request): { secret: string; claimedGrantId: string | null } | null {
    const raw = parseBearerToken({ headers: req.headers as Record<string, unknown> });
    if (!raw) return null;
    if (parseAuthorityBearer(raw)) return null;
    return parseWorkspaceGrantBearer(raw);
  }

  private parseAuthorityBearerCreds(
    req: Request,
  ): { authorityId: string; secret: string } | null {
    const raw = parseBearerToken({ headers: req.headers as Record<string, unknown> });
    return raw ? parseAuthorityBearer(raw) : null;
  }

  private sendGrantRequired(res: Response): void {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'GRANT_REQUIRED' },
      id: null,
    });
  }

  private sendAuthorityError(res: Response, code: string): void {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: code },
      id: null,
    });
  }

  private async authenticateExecutionAuthority(sessionId: string, req: Request): Promise<void> {
    const creds = this.parseAuthorityBearerCreds(req);
    if (!creds) {
      throw new Error('AUTHORITY_SECRET_INVALID');
    }

    const response = await fetch(`${this.backendUrl}/api/execution-authority/mcp/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${creds.authorityId}:${creds.secret}`,
      },
      body: JSON.stringify({
        authorityId: creds.authorityId,
        authoritySecret: creds.secret,
        audience: 'dealer-worker',
      }),
    });

    const body = (await response.json()) as {
      ok?: boolean;
      error_code?: string;
      data?: {
        authorityId: string;
        deckId: string;
        audience: string;
      };
    };

    if (!response.ok || !body.ok || !body.data) {
      throw new Error(body.error_code ?? 'AUTHORITY_SECRET_INVALID');
    }

    const existing = this.sessionBinding.getBinding(sessionId);
    const workspaceRoot =
      readWorkspaceRootHeader(req) ??
      existing.workspaceRoot ??
      (process.env.AGENT_DECK_WORKSPACE?.trim() || undefined);

    this.sessionBinding.setExecutionAuthority(sessionId, {
      authorityId: body.data.authorityId,
      authoritySecret: creds.secret,
      deckId: body.data.deckId,
      audience: body.data.audience,
      workspaceRoot,
    });
  }

  private async authenticateTrustedSession(sessionId: string, req: Request): Promise<void> {
    const grant = this.parseGrantBearer(req);
    if (!grant) {
      throw new Error('GRANT_REQUIRED');
    }

    const response = await fetch(`${this.backendUrl}/api/trusted-session/mcp/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grantSecret: grant.secret,
        mcpSessionId: sessionId,
        ...(grant.claimedGrantId ? { claimedGrantId: grant.claimedGrantId } : {}),
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
      throw new Error(body.error ?? 'GRANT_REQUIRED');
    }

    const existing = this.sessionBinding.getBinding(sessionId);
    const workspaceRoot =
      readWorkspaceRootHeader(req) ??
      existing.workspaceRoot ??
      (process.env.AGENT_DECK_WORKSPACE?.trim() || undefined);

    this.sessionBinding.setTrustedSession(sessionId, {
      runtimeSessionId: body.data.sessionId,
      deckId: body.data.deckId,
      // Prefer client header (mcp-launch); keep prior bind; server env is last resort.
      workspaceRoot,
      mode: body.data.mode,
    });
  }

  private async disconnectTrustedSession(sessionId: string, req: Request): Promise<void> {
    const grant = this.parseGrantBearer(req);
    if (!grant) {
      return;
    }
    try {
      await fetch(`${this.backendUrl}/api/trusted-session/mcp/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ grantSecret: grant.secret, mcpSessionId: sessionId }),
      });
    } catch {
      // best-effort cleanup
    }
  }

  /**
   * Re-validate workspace grant or execution authority on every follow-up MCP HTTP request.
   * Fail closed with 401 — do not destroy the transport session so a correct
   * Bearer on the next attempt can succeed.
   * AGENT_DECK_MCP_SKIP_GRANT_AUTH=1 only relaxes *missing* Bearer (unit tests).
   */
  private async requireFollowUpGrant(sessionId: string, req: Request, res: Response): Promise<boolean> {
    const skipGrantAuth = process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH === '1';
    const authority = this.parseAuthorityBearerCreds(req);
    if (authority) {
      try {
        await this.authenticateExecutionAuthority(sessionId, req);
        return true;
      } catch (error) {
        console.warn(
          '[agent-deck] Follow-up authority auth failed (transport kept):',
          error instanceof Error ? error.message : error,
        );
        this.sendAuthorityError(
          res,
          error instanceof Error ? error.message : 'AUTHORITY_SECRET_INVALID',
        );
        return false;
      }
    }

    const grant = this.parseGrantBearer(req);
    if (!grant) {
      if (skipGrantAuth) {
        return true;
      }
      this.sendGrantRequired(res);
      return false;
    }
    try {
      await this.authenticateTrustedSession(sessionId, req);
      return true;
    } catch (error) {
      console.warn(
        '[agent-deck] Follow-up grant auth failed (transport kept):',
        error instanceof Error ? error.message : error,
      );
      this.sendGrantRequired(res);
      return false;
    }
  }

  /**
   * @deprecated Legacy pre-bind from deck header — replaced by grant authentication.
   */
  private preBindSessionDeck(_sessionId: string, _req: Request): void {
    // no-op — grant auth handled in authenticateTrustedSession
  }

  private async handleMcpPost(req: Request, res: Response): Promise<void> {
    const sessionIdHeader = this.getSessionIdHeader(req);
    const existing = sessionIdHeader ? this.sessions.get(sessionIdHeader) : undefined;

    if (existing && sessionIdHeader) {
      if (!(await this.requireFollowUpGrant(sessionIdHeader, req, res))) {
        return;
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

    if (!isInit) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
      return;
    }

    const authorityCreds = this.parseAuthorityBearerCreds(req);
    const grant = this.parseGrantBearer(req);
    const skipGrantAuth = process.env.AGENT_DECK_MCP_SKIP_GRANT_AUTH === '1';
    if (!grant && !authorityCreds && !skipGrantAuth) {
      this.sendGrantRequired(res);
      return;
    }

    // Authenticate before advertising mcp-session-id. Previously we initialized
    // first, then deleted the session on grant failure — clients kept a dead id
    // and saw "No valid session ID provided" on the next request.
    // SKIP_GRANT_AUTH only allows *missing* Bearer (unit tests); a present Bearer
    // is always validated.
    const sessionId = randomUUID();
    if (authorityCreds) {
      try {
        await this.authenticateExecutionAuthority(sessionId, req);
      } catch (error) {
        console.warn(
          '[agent-deck] Authority auth failed before MCP init:',
          error instanceof Error ? error.message : error,
        );
        this.sendAuthorityError(
          res,
          error instanceof Error ? error.message : 'AUTHORITY_SECRET_INVALID',
        );
        return;
      }
    } else if (grant) {
      try {
        await this.authenticateTrustedSession(sessionId, req);
      } catch (error) {
        console.warn(
          '[agent-deck] Grant auth failed before MCP init:',
          error instanceof Error ? error.message : error,
        );
        this.sendGrantRequired(res);
        return;
      }
    }

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
        // Unregister while session headers still resolve — clearSession would drop
        // the runtime session id and live-display DELETE would 401.
        void this.unregisterLiveDisplay(closedSessionId).finally(() => {
          this.sessionBinding.clearSession(closedSessionId);
          this.badgeBySession.delete(closedSessionId);
          this.lastTouchAtMs.delete(closedSessionId);
        });
      }
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.warn(
        '[agent-deck] MCP initialize failed after grant auth — revoking runtime session:',
        error instanceof Error ? error.message : error,
      );
      this.sessions.delete(sessionId);
      this.sessionBinding.clearSession(sessionId);
      await this.disconnectTrustedSession(sessionId, req);
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
      void this.registerLiveDisplay(transport.sessionId).catch(() => {});
    }
  }

  private async handleMcpSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = this.getSessionIdHeader(req);
    if (!sessionId) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (!(await this.requireFollowUpGrant(sessionId, req, res))) {
      return;
    }

    this.touchLiveDisplay(sessionId);
    await session.transport.handleRequest(req, res);
  }

  async start() {
    try {
      console.log(`🚀 Starting Agent Deck MCP Server on port ${this.port}...`);
      console.log(`🔗 Backend API URL: ${this.backendUrl}`);

      this.app.listen(this.port, this.host, () => {
        console.log(`✅ Agent Deck MCP Server is ready to accept connections`);
        console.log(`📋 Available tools:`);
        console.log(`   - bind_workspace: Bind session to workspace + deck (deckId required)`);
        console.log(`   - switch_bound_deck: Switch deck for this session only`);
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
      });
      
      return this.app;
    } catch (error) {
      console.error(`❌ Failed to start MCP server:`, error);
      throw error;
    }
  }

  async stop() {
    try {
      for (const [sessionId, session] of this.sessions) {
        try {
          await session.transport.close();
        } catch (error) {
          console.error(`Error closing MCP session ${sessionId}:`, error);
        }
      }
      this.sessions.clear();
      console.log(`🛑 MCP server stopped`);
    } catch (error) {
      console.error(`❌ Error stopping MCP server:`, error);
    }
  }
}