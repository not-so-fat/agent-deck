import { describe, expect, it } from 'vitest';
import {
  formatHeadersForEditor,
  hasCustomHeaders,
  maskHeaderValue,
  maskedHeadersEntries,
  parseHeadersJson,
} from './service-headers';

describe('hasCustomHeaders', () => {
  it('is false for null, undefined, and empty object', () => {
    expect(hasCustomHeaders(null)).toBe(false);
    expect(hasCustomHeaders(undefined)).toBe(false);
    expect(hasCustomHeaders({})).toBe(false);
  });

  it('is true when at least one header exists', () => {
    expect(hasCustomHeaders({ Authorization: 'Bearer x' })).toBe(true);
  });
});

describe('parseHeadersJson', () => {
  it('accepts empty object and blank editor shell', () => {
    expect(parseHeadersJson('{}')).toEqual({ ok: true, headers: {} });
    expect(parseHeadersJson('{\n  \n}')).toEqual({ ok: true, headers: {} });
  });

  it('accepts a string-valued object', () => {
    expect(parseHeadersJson('{"Authorization":"Bearer tok"}')).toEqual({
      ok: true,
      headers: { Authorization: 'Bearer tok' },
    });
  });

  it('rejects invalid JSON without returning headers', () => {
    const result = parseHeadersJson('{bad');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid JSON/);
    }
  });

  it('rejects arrays and non-string values', () => {
    expect(parseHeadersJson('[]').ok).toBe(false);
    const nonString = parseHeadersJson('{"X-Api-Key":123}');
    expect(nonString.ok).toBe(false);
    if (!nonString.ok) {
      expect(nonString.error).toMatch(/string value/);
    }
  });
});

describe('maskHeaderValue / maskedHeadersEntries', () => {
  it('masks Bearer tokens preserving the prefix', () => {
    expect(maskHeaderValue('Bearer secret-token')).toBe('Bearer ••••');
  });

  it('masks any other non-empty value', () => {
    expect(maskHeaderValue('abc123')).toBe('••••');
    expect(maskHeaderValue('plain')).toBe('••••');
  });

  it('lists masked entries for view mode', () => {
    expect(
      maskedHeadersEntries({
        Authorization: 'Bearer secret',
        'X-Custom': 'anything',
      }),
    ).toEqual([
      { name: 'Authorization', masked: 'Bearer ••••' },
      { name: 'X-Custom', masked: '••••' },
    ]);
  });
});

describe('formatHeadersForEditor', () => {
  it('prefills pretty JSON when headers exist', () => {
    expect(formatHeadersForEditor({ Authorization: 'Bearer x' })).toContain('Authorization');
  });

  it('uses empty shell when no headers', () => {
    expect(formatHeadersForEditor(null)).toBe('{\n  \n}');
  });
});
