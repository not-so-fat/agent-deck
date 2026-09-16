import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assessClaudeMcpConfig,
  buildMcpProbePlan,
  probeMcpInitialize,
} from './debug-mcp';

describe('probeMcpInitialize', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards launch-selected deck and workspace headers', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        'x-agent-deck-deck-id': 'deck_test',
        'x-agent-deck-workspace': '/workspace',
      });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await probeMcpInitialize('http://127.0.0.1:1110', {
      'x-agent-deck-deck-id': 'deck_test',
      'x-agent-deck-workspace': '/workspace',
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('buildMcpProbePlan', () => {
  it('skips the authenticated initialize probe when no folder assignment exists', () => {
    expect(buildMcpProbePlan('/workspace', null)).toEqual({
      shouldProbe: false,
      launchHeaders: {},
    });
  });

  it('uses the assignment and workspace headers when an assignment exists', () => {
    expect(buildMcpProbePlan('/workspace', { deckId: 'deck_test' })).toEqual({
      shouldProbe: true,
      launchHeaders: {
        'x-agent-deck-deck-id': 'deck_test',
        'x-agent-deck-workspace': '/workspace',
      },
    });
  });
});

describe('assessClaudeMcpConfig', () => {
  const missing = { kind: 'missing' } as const;
  const launcher = {
    kind: 'entry',
    entry: { type: 'stdio', command: 'agent-deck', args: ['mcp-launch'] },
  } as const;
  const bareHttp = {
    kind: 'entry',
    entry: { type: 'http', url: 'http://127.0.0.1:1110/mcp' },
  } as const;

  it('accepts a project launcher without requiring a user-scope entry', () => {
    const result = assessClaudeMcpConfig(launcher, missing);

    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('OK  Claude project config');
    expect(result.lines.join('\n')).not.toContain('Fix:');
  });

  it('accepts the global launcher written by setup when no project entry exists', () => {
    const result = assessClaudeMcpConfig(missing, launcher);

    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('OK  Claude user config');
    expect(result.lines.join('\n')).not.toContain('Fix:');
  });

  it('rejects a stale user HTTP entry that conflicts with a project launcher', () => {
    const result = assessClaudeMcpConfig(launcher, bareHttp);

    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('conflicts with the project launcher');
    expect(result.lines.join('\n')).toContain('cannot select a deck');
  });

  it('reports how to configure Claude only when both scopes are missing', () => {
    const result = assessClaudeMcpConfig(missing, missing);

    expect(result.ok).toBe(true);
    expect(result.lines).toContain('  Fix: agent-deck setup --client claude');
  });
});
