import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeMcpInitialize } from './debug-mcp';

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
