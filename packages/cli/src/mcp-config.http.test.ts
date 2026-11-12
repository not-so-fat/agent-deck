import { describe, it, expect } from 'vitest';

import { buildAgentDeckEntry, buildMcpUrl } from './mcp-config';

describe('MCP client config', () => {
  it('NOT-565: uses the headerless HTTP fallback for Claude Code', () => {
    expect(buildAgentDeckEntry('claude', { host: '127.0.0.1', mcpPort: 3001 })).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:3001/mcp',
    });
  });

  it('NOT-567: uses the headerless HTTP fallback for Cursor', () => {
    expect(buildAgentDeckEntry('cursor', { host: '127.0.0.1', mcpPort: 3001 })).toEqual({
      url: 'http://127.0.0.1:3001/mcp',
    });
  });

  it('NOT-567: writes the workspace header for Cursor project folders', () => {
    expect(
      buildAgentDeckEntry(
        'cursor',
        { host: '127.0.0.1', mcpPort: 3001 },
        { workspaceRoot: '/tmp/ws' },
      ),
    ).toEqual({
      url: 'http://127.0.0.1:3001/mcp',
      headers: { 'x-agent-deck-workspace': '/tmp/ws' },
    });
  });

  it('buildMcpUrl never uses https for local default host', () => {
    const url = buildMcpUrl({ host: '127.0.0.1', mcpPort: 3001 });
    expect(url).toBe('http://127.0.0.1:3001/mcp');
    expect(url.startsWith('https://')).toBe(false);
  });
});
