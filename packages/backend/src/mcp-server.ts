import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_DECK_AGENT_CLIENT,
  AGENT_DECK_CLIENT_HEADER,
  AGENT_DECK_DECK_ID_HEADER,
  countDeckCards,
  formatDisplayLine,
} from '@agent-deck/shared';
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAgentDeckVersion } from './lib/version';
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

const agentClientHeaders = {
  [AGENT_DECK_CLIENT_HEADER]: AGENT_DECK_AGENT_CLIENT,
  Accept: 'application/json',
};

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
  private activeSessionId: string | undefined;
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

  private createMcpServer(): McpServer {
    this.mcpServerForRegistration = new McpServer({
      name: "agent-deck-server",
      version: getAgentDeckVersion(),
    });
    this.setupTools();
    this.setupResources();
    const server = this.mcpServerForRegistration;
    this.mcpServerForRegistration = undefined;
    return server;
  }

  private getSessionId(): string {
    return this.activeSessionId ?? 'default';
  }

  private getAgentHeaders(): Record<string, string> {
    return this.sessionBinding.getAgentHeaders(this.getSessionId());
  }

  private async fetchDeck(deckId: string): Promise<{ id: string; name: string }> {
    const deck = await fetch(`${this.backendUrl}/api/decks/${deckId}`, {
      headers: {
        ...agentClientHeaders,
        Accept: 'application/json',
      },
    });
    const body = (await deck.json()) as {
      success: boolean;
      error?: string;
      data?: { id: string; name: string };
    };
    if (!deck.ok || !body.success || !body.data?.id) {
      throw new Error(body.error ?? `Deck not found: ${deckId}`);
    }
    return body.data;
  }

  private async buildBindingPayload(sessionId: string) {
    const snapshot = this.sessionBinding.getBinding(sessionId);
    const deck = await this.callBackendAPI('/api/scope/deck');
    const badge = this.badgeBySession.get(sessionId);
    const cardCounts = deck ? countDeckCards(deck) : { mcp: 0, credentials: 0, playbooks: 0 };
    return {
      workspaceRoot: snapshot.workspaceRoot,
      deck_id: deck?.id as string,
      deck_name: deck?.name as string,
      deck_source: resolveDeckBindingSource(snapshot),
      session_deck_override: this.sessionBinding.hasSessionDeckOverride(sessionId),
      badge,
      display_summary: formatDisplayLine(deck?.name ?? null, cardCounts, { badge }),
    };
  }

  private async registerLiveDisplay(sessionId: string): Promise<void> {
    const snapshot = this.sessionBinding.getBinding(sessionId);
    // A deck bind is what makes a session live; the workspace may be absent
    // (header/auto-bound sessions surface in the dashboard without a folder).
    const deck = await this.callBackendAPI('/api/scope/deck');
    if (!deck?.id || !deck?.name) {
      return;
    }

    const clientName = this.sessions.get(sessionId)?.server.server.getClientVersion()?.name;
    const result = await this.callBackendAPI('/api/scope/live-display', {
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
    });
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
    ).catch(() => {});
  }

  private async unregisterLiveDisplay(sessionId: string): Promise<void> {
    try {
      await this.callBackendAPI(`/api/scope/live-display/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
    } catch {
      // Best effort when MCP session closes.
    }
  }

  private async callBackendAPI(endpoint: string, init: RequestInit = {}): Promise<any> {
    try {
      const response = await fetch(`${this.backendUrl}${endpoint}`, {
        ...init,
        headers: {
          ...this.getAgentHeaders(),
          ...(init.headers ?? {}),
        },
      });
      if (!response.ok) {
        const text = await response.text();
        let message = `Backend API error: ${response.status} ${response.statusText}`;
        try {
          const body = JSON.parse(text);
          if (body.error) message = String(body.error);
        } catch {
          if (text.trim()) message = text;
        }
        throw new Error(message);
      }
      const body = await response.json();

      // Unwrap ApiResponse shape { success, data?, error? }
      if (typeof body === 'object' && body !== null && 'success' in body) {
        if (body.success) {
          // Some endpoints return the raw data (legacy); fallback to body if data missing
          return 'data' in body ? body.data : body;
        }
        const message = 'error' in body ? body.error : 'Unknown backend error';
        throw new Error(String(message));
      }

      // Fallback: return as-is if not wrapped
      return body;
    } catch (error) {
      console.error(`Failed to call backend API ${endpoint}:`, error);
      throw error;
    }
  }

  private async getBoundDeckId(): Promise<string> {
    const deck = await this.callBackendAPI('/api/scope/deck');
    if (!deck?.id) {
      throw new Error('No bound deck — call bind_workspace (optionally with deckId) or switch_bound_deck first');
    }
    return deck.id as string;
  }

  private toolResult(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }

  private toolError(error: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(error) }) }] };
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
  ): Promise<StubBindSyncResult | null> {
    if (!isStubSyncEnabled()) {
      return null;
    }

    const summaries = (await this.callBackendAPI('/api/playbooks/summaries')) as PlaybookStubInput[];
    const stubs = syncPlaybookStubs(workspaceRoot, summaries ?? []);
    const manifestPath = healUseManifest(workspaceRoot, deck);

    await this.callBackendAPI('/api/scope/deck-workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceRoot, deckId: deck.id }),
    });

    return {
      stubs,
      host_reload_required: stubSyncChanged(stubs),
      manifestPath,
    };
  }

  private setupTools() {
    registerMcpTools({
      registerTool: (name, config, handler) => this.registerTool(name, config, handler),
      profile: this.toolProfile,
      getSessionId: () => this.getSessionId(),
      getAgentHeaders: () => this.getAgentHeaders(),
      getBoundDeckId: () => this.getBoundDeckId(),
      callBackendAPI: (endpoint, init) => this.callBackendAPI(endpoint, init),
      fetchDeck: (deckId) => this.fetchDeck(deckId),
      buildBindingPayload: (sessionId) => this.buildBindingPayload(sessionId),
      registerLiveDisplay: (sessionId) => this.registerLiveDisplay(sessionId),
      syncWorkspaceOnBind: (workspaceRoot, deck) => this.syncWorkspaceOnBind(workspaceRoot, deck),
      sessionBinding: this.sessionBinding,
      badgeBySession: this.badgeBySession,
      backendUrl: this.backendUrl,
      toolResult: (data) => this.toolResult(data),
      toolError: (error) => this.toolError(error),
    });
  }


  private setupResources() {
    this.server.resource("bound_deck_summary", "agent-deck://bound-deck/summary", {
      description: "One-line summary of the workspace-bound deck for status display",
      mimeType: "text/plain",
    }, async () => {
      try {
        const deck = await this.callBackendAPI('/api/scope/deck');
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
        const deck = await this.callBackendAPI('/api/scope/deck');
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
        const deck = await this.callBackendAPI('/api/scope/deck');
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
        const credentials = await this.callBackendAPI('/api/credentials');

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
        const credentials = await this.callBackendAPI('/api/credentials');

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
        const deck = await this.callBackendAPI('/api/scope/deck');
        
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
        const deck = await this.callBackendAPI('/api/scope/deck');
        
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
        const decks = await this.callBackendAPI('/api/decks');
        
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

  /**
   * Pre-bind a newly-initialized session to the deck the client advertised via the
   * `x-agent-deck-deck-id` header (written into the workspace's MCP config by
   * `agent-deck use`). Removes the "agent forgot to call bind_workspace" gap; an
   * explicit bind_workspace / switch_bound_deck later still overrides it.
   */
  private preBindSessionDeck(sessionId: string, req: Request): void {
    const value = req.headers[AGENT_DECK_DECK_ID_HEADER];
    const deckId = typeof value === 'string' ? value.trim() : undefined;
    if (deckId) {
      this.sessionBinding.setDeckId(sessionId, deckId);
    }
  }

  private async handleMcpPost(req: Request, res: Response): Promise<void> {
    const sessionIdHeader = this.getSessionIdHeader(req);
    const existing = sessionIdHeader ? this.sessions.get(sessionIdHeader) : undefined;

    if (existing && sessionIdHeader) {
      this.activeSessionId = sessionIdHeader;
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

    const server = this.createMcpServer();
    let sessionEntry: McpSession | undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        sessionEntry = { transport, server };
        this.sessions.set(sessionId, sessionEntry);
        this.preBindSessionDeck(sessionId, req);
      },
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        this.sessions.delete(sessionId);
        this.sessionBinding.clearSession(sessionId);
        this.badgeBySession.delete(sessionId);
        this.lastTouchAtMs.delete(sessionId);
        void this.unregisterLiveDisplay(sessionId);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, body);

    if (transport.sessionId && !this.sessions.has(transport.sessionId)) {
      this.sessions.set(transport.sessionId, { transport, server });
    }
    this.activeSessionId = transport.sessionId;

    // Surface header/auto-bound sessions in the dashboard's live list. Runs after
    // activeSessionId is set so the deck fetch resolves this session. bind_workspace
    // sessions register on their own tool call; this only covers the header path.
    if (transport.sessionId && this.sessionBinding.hasSessionDeckOverride(transport.sessionId)) {
      void this.registerLiveDisplay(transport.sessionId);
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

    this.activeSessionId = sessionId;
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