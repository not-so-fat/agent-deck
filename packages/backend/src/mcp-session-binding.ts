import path from 'node:path';
import {
  AGENT_DECK_AGENT_CLIENT,
  AGENT_DECK_CLIENT_HEADER,
  AGENT_DECK_CORRELATION_HEADER,
  AGENT_DECK_SESSION_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
  normalizeCorrelationId,
  type BindingActiveSource,
} from '@agent-deck/shared';
import type { ClientPrincipal } from './auth/client-grants';

export type DeckBindingSource =
  | 'session_override'
  | 'env'
  | 'launch';

export type SessionBindingSnapshot = {
  workspaceRoot?: string;
  deckId?: string;
  runtimeSessionId?: string;
  mode?: 'normal' | 'agent-admin';
  deckSource?: DeckBindingSource;
  /**
   * Opaque run-correlation id (NOT-304). Observability metadata only —
   * reported in the snapshot and forwarded to the backend for usage
   * recording; never consulted for deck, workspace, mode, or auth.
   */
  correlationId?: string;
};

/** Remote-grant scope held per MCP session (NOT-318). */
export type GrantSessionScope = {
  grantId: string;
  label: string;
  defaultDeck: string;
  allowedDecks: string[];
};

/** Per-MCP-session workspace + trusted runtime session. */
export class McpSessionBindingStore {
  private workspaceBySession = new Map<string, string>();
  private deckIdBySession = new Map<string, string>();
  private runtimeSessionByMcp = new Map<string, string>();
  private modeByMcp = new Map<string, 'normal' | 'agent-admin'>();
  /**
   * Opaque run-correlation id per MCP session (NOT-304). Adopt-once: the
   * first valid value seen at launch sticks for the session lifetime, so a
   * later header change can never move usage attribution or authority.
   */
  private correlationByMcp = new Map<string, string>();
  /** MCP session ids authenticated via launch-selected deck (NOT-105). */
  private launchByMcp = new Set<string>();
  /** MCP session ids authenticated via remote bearer grant (NOT-318). */
  private grantByMcp = new Map<string, GrantSessionScope>();
  /** MCP sessions with no deck header — explain-only, no deck access (NOT-50). */
  private unassignedByMcp = new Set<string>();
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
    // Do NOT clear launchByMcp — bind_workspace re-calls setTrustedSession.
    this.runtimeSessionByMcp.set(mcpSessionId, input.runtimeSessionId);
    this.deckIdBySession.set(mcpSessionId, input.deckId);
    this.modeByMcp.set(mcpSessionId, input.mode ?? 'normal');
    if (input.workspaceRoot) {
      this.workspaceBySession.set(mcpSessionId, path.resolve(input.workspaceRoot.trim()));
    }
  }

  setLaunchSession(
    mcpSessionId: string,
    input: {
      runtimeSessionId: string;
      deckId: string;
      workspaceRoot?: string;
      mode?: 'normal' | 'agent-admin';
    },
  ): void {
    this.unassignedByMcp.delete(mcpSessionId);
    this.setTrustedSession(mcpSessionId, input);
    this.launchByMcp.add(mcpSessionId);
  }

  isLaunchSession(mcpSessionId: string): boolean {
    return this.launchByMcp.has(mcpSessionId);
  }

  /**
   * NOT-318: bind an MCP session to an authenticated remote grant. The
   * grant scope travels with the session so every follow-up revalidates
   * against the same allowlist; the deck header can never widen it.
   */
  setGrantSession(
    mcpSessionId: string,
    input: {
      grantId: string;
      label: string;
      defaultDeck: string;
      allowedDecks: string[];
      runtimeSessionId: string;
      deckId: string;
      workspaceRoot?: string;
      mode?: 'normal' | 'agent-admin';
    },
  ): void {
    this.unassignedByMcp.delete(mcpSessionId);
    this.setTrustedSession(mcpSessionId, input);
    this.grantByMcp.set(mcpSessionId, {
      grantId: input.grantId,
      label: input.label,
      defaultDeck: input.defaultDeck,
      allowedDecks: [...input.allowedDecks],
    });
  }

  isGrantSession(mcpSessionId: string): boolean {
    return this.grantByMcp.has(mcpSessionId);
  }

  getGrantScope(mcpSessionId: string): GrantSessionScope | undefined {
    const scope = this.grantByMcp.get(mcpSessionId);
    return scope ? { ...scope, allowedDecks: [...scope.allowedDecks] } : undefined;
  }

  /**
   * NOT-318: the unified authorization principal. Loopback launcher
   * sessions resolve to `local` (unconstrained); remote bearer sessions
   * resolve to their grant (constrained by the allowlist). Both flow
   * through the same deck-scope check downstream.
   */
  resolveClientPrincipal(mcpSessionId: string): ClientPrincipal {
    const scope = this.grantByMcp.get(mcpSessionId);
    if (scope) {
      return {
        kind: 'grant',
        grantId: scope.grantId,
        label: scope.label,
        defaultDeck: scope.defaultDeck,
        allowedDecks: [...scope.allowedDecks],
      };
    }
    return { kind: 'local' };
  }

  markUnassigned(mcpSessionId: string): void {
    this.launchByMcp.delete(mcpSessionId);
    this.runtimeSessionByMcp.delete(mcpSessionId);
    this.deckIdBySession.delete(mcpSessionId);
    this.modeByMcp.delete(mcpSessionId);
    this.correlationByMcp.delete(mcpSessionId);
    this.unassignedByMcp.add(mcpSessionId);
  }

  /**
   * Adopt the session's run-correlation id (NOT-304). First valid value
   * wins; later values — valid or not — are ignored so correlation can
   * never steer an established session. Invalid input is dropped, never
   * coerced. Returns the stored value (or undefined when nothing stuck).
   */
  setCorrelationId(mcpSessionId: string, raw: unknown): string | undefined {
    const existing = this.correlationByMcp.get(mcpSessionId);
    if (existing) {
      return existing;
    }
    const normalized = normalizeCorrelationId(raw);
    if (normalized) {
      this.correlationByMcp.set(mcpSessionId, normalized);
      return normalized;
    }
    return undefined;
  }

  getCorrelationId(mcpSessionId: string): string | undefined {
    return this.correlationByMcp.get(mcpSessionId);
  }

  isUnassigned(mcpSessionId: string): boolean {
    return this.unassignedByMcp.has(mcpSessionId);
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
    this.correlationByMcp.delete(sessionId);
    this.launchByMcp.delete(sessionId);
    this.grantByMcp.delete(sessionId);
    this.unassignedByMcp.delete(sessionId);
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
    const isLaunch = this.launchByMcp.has(sessionId);
    return {
      workspaceRoot: this.getWorkspace(sessionId),
      deckId,
      runtimeSessionId,
      correlationId: this.correlationByMcp.get(sessionId),
      mode: this.modeByMcp.get(sessionId),
      // Every authenticated MCP session is a launch session (NOT-105/108).
      // Non-launch paths are env defaults or explicit session overrides (tests / skip-header).
      deckSource: isLaunch
        ? 'launch'
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

    // Forward the opaque correlation id so backend usage recording can
    // attribute events to this launch. It carries no authority — the
    // backend never reads it for deck, workspace, mode, or auth.
    const correlationId = this.getCorrelationId(sessionId);
    if (correlationId) {
      headers[AGENT_DECK_CORRELATION_HEADER] = correlationId;
    }

    return headers;
  }
}

/**
 * Resolve the NOT-211 active source reported by `get_session_binding`.
 *
 * The saved workspace default (`.agent-deck/use.json` assignment) wins the
 * comparison, and the comparison is by deck id — never by display name, which
 * goes stale after a rename: when a default exists, the source is `session`
 * only if the active deck id differs from it, otherwise `workspace`, so an
 * active deck that equals the default never implies an override. A
 * launch-selected deck with no assignment file reports `launch` with the
 * missing default left explicit. Without any saved default, a bound active
 * deck is session-held (`session`).
 */
export function resolveBindingActiveSource(input: {
  isLaunchSession: boolean;
  activeDeckId?: string | null;
  workspaceDefaultDeckId?: string | null;
}): BindingActiveSource {
  if (input.workspaceDefaultDeckId) {
    if (input.activeDeckId && input.activeDeckId !== input.workspaceDefaultDeckId) {
      return 'session';
    }
    return 'workspace';
  }
  if (input.isLaunchSession) {
    return 'launch';
  }
  return input.activeDeckId ? 'session' : 'workspace';
}

export function resolveDeckBindingSource(binding: SessionBindingSnapshot): DeckBindingSource {
  if (binding.deckSource === 'launch') {
    return 'launch';
  }
  return binding.deckSource === 'env' ? 'env' : 'session_override';
}
