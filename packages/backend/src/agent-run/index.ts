/**
 * `@agent-deck/backend/agent-run` — the host-local agent run service shared
 * by the `agent-deck run` CLI and the backend (NOT-479). Node built-ins only:
 * importing it never loads the store, HTTP server, or vault.
 */
export * from './adapter';
export * from './claude';
export * from './claude-probe';
export * from './codex';
export * from './cursor';
export * from './muse';
export * from './records';
export * from './service';
