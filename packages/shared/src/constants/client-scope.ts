/** HTTP header distinguishing dashboard (human UI) from agent API clients. */
export const AGENT_DECK_CLIENT_HEADER = 'x-agent-deck-client';

/** Value sent by the Agent Deck dashboard for vault management. */
export const AGENT_DECK_DASHBOARD_CLIENT = 'dashboard';

/** Value sent by MCP and other agent integrations (deck-scoped reads only). */
export const AGENT_DECK_AGENT_CLIENT = 'agent';

/** Workspace root for session grouping and display (agent clients). */
export const AGENT_DECK_WORKSPACE_HEADER = 'x-agent-deck-workspace';

/** Launch-selected deck (NOT-105). */
export const AGENT_DECK_DECK_ID_HEADER = 'x-agent-deck-deck-id';

/**
 * Opaque run-correlation id for launch-selected MCP sessions (NOT-304).
 *
 * Observability metadata only: it never selects a deck, grants access,
 * changes mode, or participates in authorization. Validated as an opaque
 * UUID or equivalently strict bounded token — never free text.
 */
export const AGENT_DECK_CORRELATION_HEADER = 'x-agent-deck-correlation-id';

/**
 * Session a client lost to a server restart, named on the handshake it replays
 * (NOT-101). It lets the server mark that session recovered instead of counting
 * the client as stranded forever.
 */
export const AGENT_DECK_RECOVERED_SESSION_HEADER = 'x-agent-deck-recovered-session';
