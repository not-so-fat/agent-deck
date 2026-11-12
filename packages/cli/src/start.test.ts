import { describe, expect, it } from 'vitest';

import { formatClaudeMcpAddCommand, formatStartVersionLine } from './start';

describe('start output', () => {
  it('formats the running package version', () => {
    expect(formatStartVersionLine('1.7.3')).toBe('  Version    1.7.3');
  });

  it('NOT-565: preserves a custom endpoint in the Claude HTTP fallback hint', () => {
    expect(formatClaudeMcpAddCommand('127.0.0.2', 2110)).toBe(
      'claude mcp add --scope user --transport http agent-deck http://127.0.0.2:2110/mcp',
    );
  });
});
