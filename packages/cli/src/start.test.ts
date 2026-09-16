import { describe, expect, it } from 'vitest';

import { formatClaudeMcpAddCommand, formatStartVersionLine } from './start';

describe('start output', () => {
  it('formats the running package version', () => {
    expect(formatStartVersionLine('1.7.3')).toBe('  Version    1.7.3');
  });

  it('preserves a custom endpoint in the Claude launcher hint', () => {
    expect(formatClaudeMcpAddCommand('127.0.0.2', 2110)).toBe(
      'claude mcp add --scope user agent-deck -e AGENT_DECK_MCP_PORT=2110 -e AGENT_DECK_HOST=127.0.0.2 -- agent-deck mcp-launch',
    );
  });
});
