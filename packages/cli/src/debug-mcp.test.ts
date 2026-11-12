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
  const projectHttp = {
    kind: 'entry',
    entry: {
      type: 'http',
      url: 'http://127.0.0.1:1110/mcp',
      headers: { 'x-agent-deck-workspace': '/work/repo' },
    },
  } as const;
  const fallbackHttp = {
    kind: 'entry',
    entry: { type: 'http', url: 'http://127.0.0.1:1110/mcp' },
  } as const;
  const custom = {
    kind: 'entry',
    entry: { command: 'npx', args: ['-y', 'custom-wrapper'] },
  } as const;

  it('NOT-566: accepts a project pure-HTTP entry without requiring a user-scope entry', () => {
    const result = assessClaudeMcpConfig(projectHttp, missing);

    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('OK  Claude project config');
    expect(result.lines.join('\n')).not.toContain('Fix:');
  });

  it('NOT-566: accepts the headerless global HTTP fallback written by setup', () => {
    const result = assessClaudeMcpConfig(missing, fallbackHttp);

    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('OK  Claude user config');
    expect(result.lines.join('\n')).not.toContain('Fix:');
  });

  it('NOT-566: warns on a headerless project HTTP entry that cannot select a deck', () => {
    const result = assessClaudeMcpConfig(fallbackHttp, missing);

    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('headerless HTTP entry that cannot select a deck');
    expect(result.lines.join('\n')).toContain('Fix: agent-deck use <deck>');
  });

  it('NOT-566: keeps a legacy launcher entry healthy with a migration note', () => {
    const project = assessClaudeMcpConfig(launcher, missing);
    expect(project.ok).toBe(true);
    expect(project.lines.join('\n')).toContain('OK  Claude project config');
    expect(project.lines.join('\n')).toContain('Legacy launcher entry');
    expect(project.lines.join('\n')).toContain('agent-deck upgrade');

    const user = assessClaudeMcpConfig(missing, launcher);
    expect(user.ok).toBe(true);
    expect(user.lines.join('\n')).toContain('OK  Claude user config');
    expect(user.lines.join('\n')).toContain('Legacy launcher entry');
  });

  it('rejects a custom entry with the pure-HTTP expectation', () => {
    const result = assessClaudeMcpConfig(custom, missing);

    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toContain('custom entry');
    expect(result.lines.join('\n')).toContain('Expected the pure-HTTP agent-deck entry');
    expect(result.lines).toContain(
      '     Fix: claude mcp remove agent-deck -s project && agent-deck setup --client claude --scope project',
    );
  });

  it('reports how to configure Claude only when both scopes are missing', () => {
    const result = assessClaudeMcpConfig(missing, missing);

    expect(result.ok).toBe(true);
    expect(result.lines).toContain('  Fix: agent-deck setup --client claude');
  });
});
