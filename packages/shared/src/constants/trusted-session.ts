/** Bearer token presented by the trusted MCP launcher (raw grant secret). */
export const AGENT_DECK_GRANT_AUTH_SCHEME = 'Bearer';

/** Runtime session id returned to MCP layer after grant authentication. */
export const AGENT_DECK_SESSION_HEADER = 'x-agent-deck-session-id';

/** Dashboard session cookie name. */
export const AGENT_DECK_DASHBOARD_COOKIE = 'agent_deck_dashboard';

/** Normal MCP session inactivity lease (PRD C3). */
export const RUNTIME_SESSION_LEASE_MS = 24 * 60 * 60 * 1000;

/** Agent-admin inactivity lease (PRD C4). */
export const ADMIN_MODE_LEASE_MS = 30 * 60 * 1000;

/** Admin elevation challenge validity (PRD C4). */
export const ADMIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Dashboard bootstrap nonce validity. */
export const DASHBOARD_NONCE_TTL_MS = 2 * 60 * 1000;
