import { describe, it, expect } from 'vitest';

import { buildAgentDeckEntry, buildMcpUrl } from './mcp-config';

describe('MCP client config', () => {
  it('uses stdio launcher for Claude Code', () => {
    expect(buildAgentDeckEntry('claude', { host: '127.0.0.1', mcpPort: 3001 })).toEqual({
      type: 'stdio',
      command: 'agent-deck',
      args: ['mcp-launch'],
    });
  });

  it('uses command launcher for Cursor', () => {
    expect(buildAgentDeckEntry('cursor', { host: '127.0.0.1', mcpPort: 3001 })).toEqual({
      command: 'agent-deck',
      args: ['mcp-launch'],
      env: {
        AGENT_DECK_MCP_PORT: '3001',
        AGENT_DECK_HOST: '127.0.0.1',
      },
    });
  });

  it('buildMcpUrl never uses https for local default host', () => {
    const url = buildMcpUrl({ host: '127.0.0.1', mcpPort: 3001 });
    expect(url).toBe('http://127.0.0.1:3001/mcp');
    expect(url.startsWith('https://')).toBe(false);
  });
});
