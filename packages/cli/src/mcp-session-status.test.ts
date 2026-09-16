import { describe, expect, it } from 'vitest';

import { formatMcpSessionStatus } from './ports';

describe('formatMcpSessionStatus (NOT-101)', () => {
  it('reports live sessions without noise when nothing is stale', () => {
    const lines = formatMcpSessionStatus({
      instanceId: 'abc',
      startedAt: '2026-09-16T04:43:40.009Z',
      liveSessions: 2,
      staleSessionCount: 0,
      staleSessionClients: 0,
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
      staleSessionCount: 41,
      staleSessionClients: 7,
      staleSessionLastAt: '2026-09-16T04:51:02.000Z',
      staleSessionsRecovered: 0,
      staleSessionsUnresolved: 7,
      staleSessionLastUnresolvedAt: '2026-09-16T04:51:02.000Z',
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
      staleSessionCount: 2,
      staleSessionClients: 1,
      staleSessionLastAt: '2026-09-16T04:51:02.000Z',
      staleSessionsRecovered: 1,
      staleSessionsUnresolved: 0,
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
      staleSessionCount: 30,
      staleSessionClients: 4,
      staleSessionLastAt: '2026-09-16T05:00:00.000Z',
      staleSessionsRecovered: 3,
      staleSessionsUnresolved: 1,
      staleSessionLastUnresolvedAt: '2026-09-16T04:58:00.000Z',
    }).join('\n');

    expect(rendered).toContain('1 client still using');
    expect(rendered).toContain('2026-09-16T04:58:00.000Z');
  });

  it('falls back to the totals against a server that predates recovery reporting', () => {
    const rendered = formatMcpSessionStatus({
      liveSessions: 0,
      staleSessionCount: 5,
      staleSessionClients: 2,
    }).join('\n');

    expect(rendered).toContain('2 clients still using');
  });

  it('uses the singular form for a single stranded client', () => {
    const lines = formatMcpSessionStatus({
      liveSessions: 1,
      staleSessionCount: 3,
      staleSessionClients: 1,
    });

    expect(lines.join('\n')).toContain('1 client still using');
  });

  it('prints nothing when the MCP server is down', () => {
    expect(formatMcpSessionStatus(undefined)).toEqual([]);
  });
});
