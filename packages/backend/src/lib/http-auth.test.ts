import { describe, expect, it } from 'vitest';

import {
  normalizeWorkspaceGrantSecret,
  parseBearerToken,
  parseWorkspaceGrantBearer,
} from './http-auth';

describe('parseWorkspaceGrantBearer', () => {
  it('returns raw secrets unchanged', () => {
    expect(parseWorkspaceGrantBearer('plainSecretValue')).toEqual({
      secret: 'plainSecretValue',
      claimedGrantId: null,
    });
  });

  it('parses wgr_ grantId:secret compound bearers', () => {
    expect(
      parseWorkspaceGrantBearer('wgr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:secret-only-value'),
    ).toEqual({
      secret: 'secret-only-value',
      claimedGrantId: 'wgr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('does not treat unrelated colon-bearing tokens as compound grants', () => {
    expect(parseWorkspaceGrantBearer('not-a-grant:secret')).toEqual({
      secret: 'not-a-grant:secret',
      claimedGrantId: null,
    });
  });
});

describe('normalizeWorkspaceGrantSecret', () => {
  it('strips compound bearers to the secret', () => {
    expect(normalizeWorkspaceGrantSecret('wgr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:secret-only-value')).toBe(
      'secret-only-value',
    );
  });
});

describe('parseBearerToken', () => {
  it('reads Authorization Bearer', () => {
    expect(parseBearerToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
  });
});
