import { describe, expect, it } from 'vitest';

import { formatMcpSessionStatus, readMcpSessionHealth } from './ports';

describe('formatMcpSessionStatus (NOT-101)', () => {
  it('reports live sessions without noise when nothing is stale', () => {
    const lines = formatMcpSessionStatus({
      instanceId: 'abc',
      startedAt: '2026-09-16T04:43:40.009Z',
      liveSessions: 2,
      staleSessions: { count: 0, distinctSessions: 0 },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 live');
    expect(lines[0]).toContain('2026-09-16T04:43:40.009Z');
  });

  it('flags clients left on a pre-restart session instead of reporting all clear', () => {
    const lines = formatMcpSessionStatus({
      instanceId: 'abc',
      startedAt: '2026-09-16T04:43:40.009Z',
      liveSessions: 0,
      staleSessions: {
        count: 41,
        distinctSessions: 7,
        recoveredSessions: 0,
        unresolvedSessions: 7,
        lastAt: '2026-09-16T04:51:02.000Z',
        lastUnresolvedAt: '2026-09-16T04:51:02.000Z',
      },
    });

    const rendered = lines.join('\n');
    expect(rendered).toContain('0 live');
    expect(rendered).toContain('7 clients');
    expect(rendered).toContain('before the last MCP restart');
    expect(rendered).toContain('2026-09-16T04:51:02.000Z');
  });

  it('reports a client that reconnected as history, not as still stranded', () => {
    const lines = formatMcpSessionStatus({
      liveSessions: 1,
      staleSessions: {
        count: 2,
        distinctSessions: 1,
        recoveredSessions: 1,
        unresolvedSessions: 0,
        lastAt: '2026-09-16T04:51:02.000Z',
      },
    });

    const rendered = lines.join('\n');
    expect(rendered).not.toContain('⚠');
    expect(rendered).not.toContain('still using');
    expect(rendered).toContain('1 client re-initialized after a restart');
    expect(rendered).toContain('2 requests rejected');
  });

  it('warns about the one client that never came back, ignoring the ones that did', () => {
    const rendered = formatMcpSessionStatus({
      liveSessions: 2,
      staleSessions: {
        count: 30,
        distinctSessions: 4,
        recoveredSessions: 3,
        unresolvedSessions: 1,
        lastAt: '2026-09-16T05:00:00.000Z',
        lastUnresolvedAt: '2026-09-16T04:58:00.000Z',
      },
    }).join('\n');

    expect(rendered).toContain('1 client still using');
    expect(rendered).toContain('2026-09-16T04:58:00.000Z');
  });

  it('falls back to the totals against a server that predates recovery reporting', () => {
    const rendered = formatMcpSessionStatus({
      liveSessions: 0,
      staleSessions: { count: 5, distinctSessions: 2 },
    }).join('\n');

    expect(rendered).toContain('2 clients still using');
  });

  it('uses the singular form for a single stranded client', () => {
    const lines = formatMcpSessionStatus({
      liveSessions: 1,
      staleSessions: { count: 3, distinctSessions: 1 },
    });

    expect(lines.join('\n')).toContain('1 client still using');
  });

  it('prints nothing when the MCP server is down', () => {
    expect(formatMcpSessionStatus(undefined)).toEqual([]);
  });
});

describe('readMcpSessionHealth', () => {
  it('reads the tally straight off /health', () => {
    const health = readMcpSessionHealth({
      instanceId: 'abc',
      startedAt: '2026-09-16T04:43:40.009Z',
      liveSessions: 2,
      staleSessions: { count: 4, distinctSessions: 2, recoveredSessions: 1, unresolvedSessions: 1 },
    });

    expect(health.liveSessions).toBe(2);
    expect(health.staleSessions.unresolvedSessions).toBe(1);
  });

  it('defaults the totals when an older server omits the tally', () => {
    const health = readMcpSessionHealth({ status: 'ok' });

    expect(health.staleSessions).toEqual({
      count: 0,
      distinctSessions: 0,
      recoveredSessions: undefined,
      unresolvedSessions: undefined,
      lastAt: undefined,
      lastUnresolvedAt: undefined,
    });
  });
});
