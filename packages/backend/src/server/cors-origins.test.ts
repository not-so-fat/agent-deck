import { describe, expect, it } from 'vitest';
import { resolveAllowedOrigins } from './cors-origins';

describe('resolveAllowedOrigins', () => {
  it('derives loopback origins from PORT plus the existing defaults', () => {
    const result = resolveAllowedOrigins({ PORT: '2111' } as NodeJS.ProcessEnv);
    expect([...result].sort()).toEqual(
      [
        'http://127.0.0.1:2111',
        'http://localhost:2111',
        'http://127.0.0.1:1111',
        'http://localhost:1111',
        'http://127.0.0.1:3000',
        'http://localhost:3000',
      ].sort(),
    );
  });

  it('falls back to port 8000 when PORT is unset', () => {
    const result = resolveAllowedOrigins({} as NodeJS.ProcessEnv);
    expect(result).toHaveLength(6);
    expect(result).toContain('http://127.0.0.1:8000');
    expect(result).toContain('http://localhost:8000');
    expect(result).toContain('http://127.0.0.1:1111');
    expect(result).toContain('http://localhost:1111');
    expect(result).toContain('http://127.0.0.1:3000');
    expect(result).toContain('http://localhost:3000');
  });

  it('falls back to port 8000 when PORT is invalid', () => {
    const result = resolveAllowedOrigins({ PORT: 'abc' } as NodeJS.ProcessEnv);
    expect(result).toHaveLength(6);
    expect(result).toContain('http://127.0.0.1:8000');
    expect(result).toContain('http://localhost:8000');
  });

  it('dedupes when PORT matches an existing default', () => {
    const result = resolveAllowedOrigins({ PORT: '1111' } as NodeJS.ProcessEnv);
    expect(result).toHaveLength(4);
    expect([...result].sort()).toEqual(
      [
        'http://127.0.0.1:1111',
        'http://localhost:1111',
        'http://127.0.0.1:3000',
        'http://localhost:3000',
      ].sort(),
    );
  });

  it('treats AGENT_DECK_DASHBOARD_ORIGIN as additive', () => {
    const result = resolveAllowedOrigins({
      PORT: '2111',
      AGENT_DECK_DASHBOARD_ORIGIN: 'http://a.example:9000, https://b.example ,',
    } as NodeJS.ProcessEnv);
    expect(result).toContain('http://a.example:9000');
    expect(result).toContain('https://b.example');
    // Base set still present.
    expect(result).toContain('http://127.0.0.1:2111');
    expect(result).toContain('http://localhost:2111');
    expect(result).toContain('http://127.0.0.1:1111');
    expect(result).toContain('http://localhost:3000');
    expect(result).toHaveLength(8);
  });

  it.each(['*', 'null', 'http://x.example/path', 'javascript:alert(1)'])(
    'ignores unsafe extra origin %s',
    (extra) => {
      const result = resolveAllowedOrigins({
        PORT: '2111',
        AGENT_DECK_DASHBOARD_ORIGIN: extra,
      } as NodeJS.ProcessEnv);
      expect(result).toHaveLength(6);
      expect(result).not.toContain('*');
      expect(result).not.toContain(extra);
    },
  );

  it('never contains a wildcard', () => {
    const result = resolveAllowedOrigins({
      PORT: '2111',
      AGENT_DECK_DASHBOARD_ORIGIN: '*, http://127.0.0.1:2111',
    } as NodeJS.ProcessEnv);
    expect(result).not.toContain('*');
  });
});
