import { describe, expect, it, vi } from 'vitest';

import { BackendApiError } from '../lib/backend-api-error';
import { formatMcpToolError, requireMcpAdmin } from './policy';
import type { McpToolHost } from './register';

function mockHost(mode: 'normal' | 'agent-admin'): McpToolHost {
  return {
    refreshRuntimeSession: vi.fn(async () => ({ mode, deckId: 'deck-1' })),
  } as unknown as McpToolHost;
}

describe('requireMcpAdmin', () => {
  const originalSkip = process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;

  beforeEach(() => {
    delete process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
  });

  afterEach(() => {
    if (originalSkip === undefined) {
      delete process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK;
    } else {
      process.env.AGENT_DECK_MCP_SKIP_ADMIN_CHECK = originalSkip;
    }
  });

  it('allows agent-admin after backend refresh', async () => {
    const host = mockHost('agent-admin');
    await expect(requireMcpAdmin(host)).resolves.toBeNull();
    expect(host.refreshRuntimeSession).toHaveBeenCalled();
  });

  it('denies normal mode from backend', async () => {
    const host = mockHost('normal');
    const denied = await requireMcpAdmin(host);
    expect(denied?.isError).toBe(true);
  });
});

describe('formatMcpToolError', () => {
  it('maps BackendApiError to structured policy error', () => {
    const result = formatMcpToolError(
      new BackendApiError('Service is not on the bound deck', 403, 'RESOURCE_OUT_OF_SCOPE'),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error_code: 'RESOURCE_OUT_OF_SCOPE',
    });
  });
});
