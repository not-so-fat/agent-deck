import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * NOT-56: self-consistency of the frozen V1 wire-contract fixture.
 *
 * This test asserts documentation invariants only — uniform 401 envelope
 * for every credential failure (no oracle), deck-detail leakage absence,
 * and 403 deck-selection reachable only post-auth. It implements no
 * production authentication.
 */

type Example = {
  case: string;
  request: { method: string; path: string; authorization: string | null; deckHeader: string | null };
  response: { http: number; jsonrpc?: string; error?: { code: number; message: string }; id?: null; deck?: string };
  sessionResult?: string;
  note?: string;
};

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    resolve(here, '../../../docs/decisions/fixtures/personal-cloud-auth-contract.examples.json'),
    'utf8',
  ),
) as { authFailures: Example[]; deckSelection: Example[] };

describe('personal-cloud V1 wire-contract fixture (NOT-56)', () => {
  it('covers all four credential cases', () => {
    expect(fixture.authFailures.map((e) => e.case).sort()).toEqual(
      ['expired', 'invalid', 'missing', 'revoked'],
    );
  });

  it('returns one uniform 401 envelope for every credential failure (no oracle)', () => {
    for (const example of fixture.authFailures) {
      expect(example.response.http).toBe(401);
      expect(example.response.jsonrpc).toBe('2.0');
      expect(example.response.error).toEqual({ code: -32001, message: 'GRANT_REQUIRED' });
      expect(example.response.id).toBeNull();
    }
  });

  it('leaks no grant state or deck detail in any failure body', () => {
    // Responses only: requests legitimately carry example secrets.
    const serialized = JSON.stringify(fixture.authFailures.map((e) => e.response));
    for (const leak of ['revoked at', 'unknown deck', 'expiresAt', 'wrongsecret', 'expiredsecret']) {
      expect(serialized.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('never authorizes from the deck header alone', () => {
    const headerOnly = fixture.deckSelection.find((e) => e.case === 'header-without-credential');
    expect(headerOnly?.response.http).toBe(401);
    expect(headerOnly?.response.error?.message).toBe('GRANT_REQUIRED');
  });

  it('selects default vs allowed deck only with a credential, 403 only post-auth', () => {
    const def = fixture.deckSelection.find((e) => e.case === 'credential-no-header-uses-default');
    expect(def?.response.http).toBe(200);
    const allowed = fixture.deckSelection.find((e) => e.case === 'credential-allowed-header');
    expect(allowed?.response.http).toBe(200);
    const denied = fixture.deckSelection.find((e) => e.case === 'credential-disallowed-header');
    expect(denied?.request.authorization).toBeTruthy();
    expect(denied?.response.http).toBe(403);
    expect(denied?.response.error?.message).toBe('RESOURCE_OUT_OF_SCOPE');
  });
});
