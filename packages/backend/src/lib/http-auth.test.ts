import { describe, expect, it } from 'vitest';

import { parseBearerToken } from './http-auth';

describe('parseBearerToken', () => {
  it('reads Authorization Bearer', () => {
    expect(parseBearerToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
  });
});
