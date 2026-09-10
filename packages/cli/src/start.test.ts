import { describe, expect, it } from 'vitest';

import { formatStartVersionLine } from './start';

describe('start output', () => {
  it('formats the running package version', () => {
    expect(formatStartVersionLine('1.7.3')).toBe('  Version    1.7.3');
  });
});
