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
    });

    const rendered = lines.join('\n');
    expect(rendered).toContain('0 live');
    expect(rendered).toContain('7 clients');
    expect(rendered).toContain('before the last MCP restart');
    expect(rendered).toContain('2026-09-16T04:51:02.000Z');
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
