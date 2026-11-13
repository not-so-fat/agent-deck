/**
 * NOT-597: implementation moved to `@agent-deck/shared` so the daemon
 * approval path shares one writer. This module re-exports for backwards
 * compatibility; new code imports from `@agent-deck/shared`.
 */
export * from '@agent-deck/shared';
