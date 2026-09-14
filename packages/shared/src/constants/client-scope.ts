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
