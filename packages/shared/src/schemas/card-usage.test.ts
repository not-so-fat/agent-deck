import { describe, expect, it } from 'vitest';

import {
  AGENT_DECK_CORRELATION_HEADER,
  AGENT_DECK_SESSION_HEADER,
  isValidCorrelationId,
  normalizeCorrelationId,
} from '../index';

describe('run-correlation id validation (NOT-304)', () => {
  it('uses a distinct header from the trusted session header', () => {
    expect(AGENT_DECK_CORRELATION_HEADER).toBe('x-agent-deck-correlation-id');
    expect(AGENT_DECK_CORRELATION_HEADER).not.toBe(AGENT_DECK_SESSION_HEADER);
  });

  it('accepts UUIDs and strict bounded tokens', () => {
    expect(isValidCorrelationId('123e4567-e89b-42d3-a456-426614174000')).toBe(true);
    expect(isValidCorrelationId('123E4567-E89B-42D3-A456-426614174000')).toBe(true);
    expect(isValidCorrelationId('dealer-run_abc123')).toBe(true);
    expect(isValidCorrelationId('a1b2c3d4')).toBe(true);
    expect(isValidCorrelationId('x'.repeat(128))).toBe(true);
  });

  it('rejects repository names, titles, prompts, and unbounded input', () => {
    // Qualified repo path (slash).
    expect(isValidCorrelationId('not-so-fat/agent_deck')).toBe(false);
    // Issue titles / prompts / task content (whitespace).
    expect(isValidCorrelationId('Fix the login bug')).toBe(false);
    expect(isValidCorrelationId('NOT-304 correlate sessions')).toBe(false);
    expect(isValidCorrelationId('fetch the playbook and summarize it')).toBe(false);
    // URLs, paths, traversal.
    expect(isValidCorrelationId('https://example.com/run/1')).toBe(false);
    expect(isValidCorrelationId('../../etc/passwd')).toBe(false);
    expect(isValidCorrelationId('run.id')).toBe(false);
    expect(isValidCorrelationId('run:id')).toBe(false);
    // Empty, too short, too long.
    expect(isValidCorrelationId('')).toBe(false);
    expect(isValidCorrelationId('short')).toBe(false);
    expect(isValidCorrelationId('x'.repeat(129))).toBe(false);
  });

  it('normalizeCorrelationId trims, drops invalid input, and never coerces', () => {
    expect(normalizeCorrelationId('  dealer-run_abc123  ')).toBe('dealer-run_abc123');
    expect(normalizeCorrelationId('not-so-fat/agent_deck')).toBeNull();
    expect(normalizeCorrelationId('Fix the login bug')).toBeNull();
    expect(normalizeCorrelationId('')).toBeNull();
    expect(normalizeCorrelationId('   ')).toBeNull();
    expect(normalizeCorrelationId(null)).toBeNull();
    expect(normalizeCorrelationId(undefined)).toBeNull();
    expect(normalizeCorrelationId(123)).toBeNull();
  });
});
