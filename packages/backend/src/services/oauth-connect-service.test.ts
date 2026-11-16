import { describe, expect, it } from 'vitest';

import {
  hasSavedOAuthCredentials,
  resolveOAuthClientCredentials,
  shouldReuseStoredOAuthClient,
} from './oauth-connect-service';

describe('shouldReuseStoredOAuthClient', () => {
  const macRedirect = 'http://127.0.0.1:1111/api/oauth/callback';
  const hostRedirect = 'https://host.example.ts.net/api/oauth/callback';
  const base = {
    enteredClientId: '',
    storedClientId: 'mac-registered-client',
    storedRedirectUri: macRedirect,
    currentRedirectUri: hostRedirect,
    supportsDynamicRegistration: true,
  };

  it('re-registers when a dynamically registered client was bound to another redirect URI', () => {
    expect(shouldReuseStoredOAuthClient(base)).toBe(false);
  });

  it('reuses the client when the redirect URI matches', () => {
    expect(shouldReuseStoredOAuthClient({ ...base, currentRedirectUri: macRedirect })).toBe(true);
  });

  it('reuses the client when no redirect URI is stored', () => {
    expect(shouldReuseStoredOAuthClient({ ...base, storedRedirectUri: null })).toBe(true);
  });

  it('reuses the client when the user entered one', () => {
    expect(shouldReuseStoredOAuthClient({ ...base, enteredClientId: 'manual-id' })).toBe(true);
  });

  it('reuses the client when the provider has no dynamic registration', () => {
    expect(shouldReuseStoredOAuthClient({ ...base, supportsDynamicRegistration: false })).toBe(true);
  });
});

describe('resolveOAuthClientCredentials', () => {
  it('reuses stored secret when reconnect field is left blank', () => {
    const resolved = resolveOAuthClientCredentials(
      { clientId: 'saved-id', clientSecret: '' },
      { oauthClientId: 'saved-id', oauthClientSecret: 'stored-secret' },
    );

    expect(resolved.clientId).toBe('saved-id');
    expect(resolved.clientSecret).toBe('stored-secret');
    expect(resolved.missingRequiredSecret).toBe(false);
  });

  it('prefers a newly entered secret over the stored value', () => {
    const resolved = resolveOAuthClientCredentials(
      { clientId: 'saved-id', clientSecret: 'new-secret' },
      { oauthClientId: 'saved-id', oauthClientSecret: 'stored-secret' },
    );

    expect(resolved.clientSecret).toBe('new-secret');
  });

  it('flags missing secret when manual connect has no stored secret', () => {
    const resolved = resolveOAuthClientCredentials(
      { clientId: 'slack-id', clientSecret: '' },
      { oauthClientId: null, oauthClientSecret: null },
    );

    expect(resolved.missingRequiredSecret).toBe(true);
  });
});

describe('hasSavedOAuthCredentials', () => {
  it('is true only when both id and secret are stored', () => {
    expect(
      hasSavedOAuthCredentials({
        oauthClientId: 'id',
        oauthClientSecret: 'secret',
      }),
    ).toBe(true);
    expect(
      hasSavedOAuthCredentials({
        oauthClientId: 'id',
        oauthClientSecret: '',
      }),
    ).toBe(false);
  });
});
