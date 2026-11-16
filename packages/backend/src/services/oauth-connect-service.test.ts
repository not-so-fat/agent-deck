import { describe, expect, it, vi } from 'vitest';

import { getOAuthRedirectUri } from '../config/oauth-redirect';

import {
  hasSavedOAuthCredentials,
  resolveOAuthClientCredentials,
  shouldReuseStoredOAuthClient,
  startOAuthConnect,
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

vi.mock('./mcp-discovery-service', () => ({
  MCPDiscoveryService: class {
    async discoverService() {
      return {
        oauth: {
          required: true,
          supportsDynamicRegistration: true,
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          scopesSupported: ['read'],
        },
      };
    }
  },
}));

describe('startOAuthConnect re-registration', () => {
  it('re-registers for this host and clears the previous client secret', async () => {
    const hostRedirect = getOAuthRedirectUri();
    const service = {
      id: 'svc-1',
      name: 'Example',
      url: 'https://mcp.example.com/mcp',
      oauthClientId: 'other-host-client',
      oauthClientSecret: '',
      oauthRedirectUri: 'http://other-host.invalid:1111/api/oauth/callback',
    };
    const updates: Record<string, unknown>[] = [];
    const db = {
      getService: async () => service,
      updateService: async (_id: string, patch: Record<string, unknown>) => {
        updates.push(patch);
      },
    };
    const autoRegisterOAuthApp = vi.fn(async () => ({ success: true, clientId: 'this-host-client' }));
    const oauthManager = {
      autoRegisterOAuthApp,
      initiateOAuthFlow: async () => ({ authorizationUrl: 'https://auth.example.com/authorize?x', state: 's' }),
    };
    const vault = new Map<string, string>([['svc-1', 'stale-secret']]);
    const clientSecrets = {
      get: async (id: string) => vault.get(id) ?? null,
      set: async (id: string, secret: string) => void vault.set(id, secret),
      delete: async (id: string) => void vault.delete(id),
    };

    const result = await startOAuthConnect(
      db as never,
      oauthManager as never,
      clientSecrets as never,
      'svc-1',
    );

    expect(result.success).toBe(true);
    expect(autoRegisterOAuthApp).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)).toMatchObject({
      oauthClientId: 'this-host-client',
      oauthRedirectUri: hostRedirect,
    });
    expect(vault.has('svc-1')).toBe(false);
  });
});
