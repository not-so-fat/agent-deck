import { describe, expect, it, vi } from 'vitest';

import { requireMcpAdmin } from './policy';
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
