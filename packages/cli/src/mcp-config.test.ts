import { describe, expect, it } from 'vitest';

import { buildAgentDeckEntry, mergeMcpServerConfig } from './mcp-config';
import { compareSemver } from './upgrade';

describe('mergeMcpServerConfig', () => {
  it('adds agent-deck without removing other servers', () => {
    const merged = mergeMcpServerConfig(
      {
        mcpServers: {
          memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        },
      },
      { command: 'agent-deck', args: ['mcp-launch'] },
    );

    expect(merged.mcpServers).toEqual({
      memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      'agent-deck': { command: 'agent-deck', args: ['mcp-launch'] },
    });
  });
});

describe('buildAgentDeckEntry', () => {
  it('uses stdio launcher for claude', () => {
    expect(buildAgentDeckEntry('claude', { host: '127.0.0.1', mcpPort: 3001 })).toEqual({
      type: 'stdio',
      command: 'agent-deck',
      args: ['mcp-launch'],
    });
  });

  it('uses agent-deck launcher for claude-desktop', () => {
    expect(buildAgentDeckEntry('claude-desktop', { host: '127.0.0.1', mcpPort: 3001 })).toEqual({
      command: 'agent-deck',
      args: ['mcp-launch'],
    });
  });

  it('uses agent-deck launcher for cursor with endpoint env', () => {
    expect(buildAgentDeckEntry('cursor', { host: '127.0.0.1', mcpPort: 3001 })).toEqual({
      command: 'agent-deck',
      args: ['mcp-launch'],
      env: {
        AGENT_DECK_MCP_PORT: '3001',
        AGENT_DECK_HOST: '127.0.0.1',
      },
    });
  });
});

describe('compareSemver', () => {
  it('detects newer patch versions', () => {
    expect(compareSemver('1.1.1', '1.1.0')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0', '1.1.1')).toBeLessThan(0);
    expect(compareSemver('1.1.0', '1.1.0')).toBe(0);
  });
});
