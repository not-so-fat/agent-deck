import path from 'node:path';
import {
  AGENT_DECK_AGENT_CLIENT,
  AGENT_DECK_CLIENT_HEADER,
  AGENT_DECK_SESSION_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
} from '@agent-deck/shared';

export type DeckBindingSource = 'grant' | 'session_override' | 'env';

export type SessionBindingSnapshot = {
  workspaceRoot?: string;
  deckId?: string;
  runtimeSessionId?: string;
  mode?: 'normal' | 'agent-admin';
  deckSource?: DeckBindingSource;
};

/** Per-MCP-session workspace + trusted runtime session. */
export class McpSessionBindingStore {
  private workspaceBySession = new Map<string, string>();
  private deckIdBySession = new Map<string, string>();
  private runtimeSessionByMcp = new Map<string, string>();
  private modeByMcp = new Map<string, 'normal' | 'agent-admin'>();
  private readonly defaultWorkspace?: string;
  private readonly defaultDeckId?: string;

  constructor(env: { workspace?: string; deckId?: string } = {}) {
    this.defaultWorkspace = env.workspace?.trim() || undefined;
    this.defaultDeckId = env.deckId?.trim() || undefined;
  }

  setTrustedSession(
    mcpSessionId: string,
    input: {
      runtimeSessionId: string;
      deckId: string;
      workspaceRoot?: string;
      mode?: 'normal' | 'agent-admin';
    },
  ): void {
    this.runtimeSessionByMcp.set(mcpSessionId, input.runtimeSessionId);
    this.deckIdBySession.set(mcpSessionId, input.deckId);
    this.modeByMcp.set(mcpSessionId, input.mode ?? 'normal');
    if (input.workspaceRoot) {
      this.workspaceBySession.set(mcpSessionId, path.resolve(input.workspaceRoot.trim()));
    }
  }

  setWorkspace(sessionId: string, workspaceRoot: string): void {
    this.workspaceBySession.set(sessionId, path.resolve(workspaceRoot.trim()));
  }

  setDeckId(sessionId: string, deckId: string): void {
    this.deckIdBySession.set(sessionId, deckId);
  }

  clearDeckId(sessionId: string): void {
    this.deckIdBySession.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    this.workspaceBySession.delete(sessionId);
    this.deckIdBySession.delete(sessionId);
    this.runtimeSessionByMcp.delete(sessionId);
    this.modeByMcp.delete(sessionId);
  }

  getWorkspace(sessionId: string): string | undefined {
    return this.workspaceBySession.get(sessionId) ?? this.defaultWorkspace;
  }

  getDeckOverride(sessionId: string): string | undefined {
    return this.deckIdBySession.get(sessionId) ?? this.defaultDeckId;
  }

  getRuntimeSessionId(sessionId: string): string | undefined {
    return this.runtimeSessionByMcp.get(sessionId);
  }

  setSessionMode(mcpSessionId: string, mode: 'normal' | 'agent-admin'): void {
    if (this.modeByMcp.has(mcpSessionId)) {
      this.modeByMcp.set(mcpSessionId, mode);
    }
  }

  getMode(sessionId: string): 'normal' | 'agent-admin' | undefined {
    return this.modeByMcp.get(sessionId);
  }

  hasSessionDeckOverride(sessionId: string): boolean {
    return this.deckIdBySession.has(sessionId);
  }

  getBinding(sessionId: string): SessionBindingSnapshot {
    const sessionDeck = this.deckIdBySession.get(sessionId);
    const deckId = sessionDeck ?? this.defaultDeckId;
    const runtimeSessionId = this.runtimeSessionByMcp.get(sessionId);
    return {
      workspaceRoot: this.getWorkspace(sessionId),
      deckId,
      runtimeSessionId,
      mode: this.modeByMcp.get(sessionId),
      deckSource: runtimeSessionId
        ? 'grant'
        : sessionDeck
          ? 'session_override'
          : this.defaultDeckId
            ? 'env'
            : undefined,
    };
  }

  getAgentHeaders(sessionId: string): Record<string, string> {
    const headers: Record<string, string> = {
      [AGENT_DECK_CLIENT_HEADER]: AGENT_DECK_AGENT_CLIENT,
      Accept: 'application/json',
    };

    const workspace = this.getWorkspace(sessionId);
    if (workspace) {
      headers[AGENT_DECK_WORKSPACE_HEADER] = workspace;
    }

    const runtimeSessionId = this.getRuntimeSessionId(sessionId);
    if (runtimeSessionId) {
      headers[AGENT_DECK_SESSION_HEADER] = runtimeSessionId;
    }

    return headers;
  }
}

export function resolveDeckBindingSource(binding: SessionBindingSnapshot): DeckBindingSource {
  if (binding.deckSource === 'grant') {
    return 'grant';
  }
  return binding.deckSource === 'env' ? 'env' : 'session_override';
}
