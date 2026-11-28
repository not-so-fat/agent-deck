import { describe, expect, it } from 'vitest';

import { buildCredentialRunRedactor, CREDENTIAL_RUN_REDACTED } from './redact';

describe('credential-run redaction', () => {
  it('redacts overlapping secrets longest-first', () => {
    const redact = buildCredentialRunRedactor(['abc', 'abcdef']);
    expect(redact('see abcdef here')).toBe(`see ${CREDENTIAL_RUN_REDACTED} here`);
  });

  it('redacts base64 and URL-encoded forms', () => {
    const secret = 'p@ss word/1';
    const redact = buildCredentialRunRedactor([secret]);
    const b64 = Buffer.from(secret, 'utf8').toString('base64');
    const url = encodeURIComponent(secret);
    expect(redact(`a ${b64} b`)).toBe(`a ${CREDENTIAL_RUN_REDACTED} b`);
    expect(redact(`a ${url} b`)).toBe(`a ${CREDENTIAL_RUN_REDACTED} b`);
    expect(redact(`a ${secret} b`)).toBe(`a ${CREDENTIAL_RUN_REDACTED} b`);
  });

  it('ignores empty secrets and leaves other text alone', () => {
    const redact = buildCredentialRunRedactor(['', 'real-secret']);
    expect(redact('nothing to hide')).toBe('nothing to hide');
    expect(redact('has real-secret inside')).toBe(`has ${CREDENTIAL_RUN_REDACTED} inside`);
  });
});
