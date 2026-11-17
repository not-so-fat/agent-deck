import { describe, expect, it, vi } from 'vitest';

import { getOAuthRedirectUri } from '../config/oauth-redirect';
import { oauthClientSecretAccount, OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { MemorySecretStore } from '../vault/secret-store';

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

describe('startOAuthConnect host-local client', () => {
  const otherHostRedirect = 'http://other-host.invalid:1111/api/oauth/callback';

  function harness(card: { oauthClientId?: string; oauthRedirectUri?: string }) {
    const service: Record<string, unknown> = {
      id: 'svc-1',
      name: 'Example',
      url: 'https://mcp.example.com/mcp',
      oauthClientSecret: '',
      ...card,
    };
    const updates: Record<string, unknown>[] = [];
    const db = {
      getService: async () => service,
      updateService: async (_id: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        Object.assign(service, patch);
      },
    };
    const autoRegisterOAuthApp = vi.fn(async () => ({ success: true, clientId: 'this-host-client' }));
    const oauthManager = {
      autoRegisterOAuthApp,
      initiateOAuthFlow: async () => ({ authorizationUrl: 'https://auth.example.com/authorize?x', state: 's' }),
    };
    const store = new MemorySecretStore();
    const clientSecrets = new OAuthClientSecretVault(store, db as never);
    const connect = () =>
      startOAuthConnect(db as never, oauthManager as never, clientSecrets, 'svc-1');
    return { service, updates, autoRegisterOAuthApp, store, clientSecrets, connect };
  }

  it('re-registers for this host, keeps the client next to its tokens, and leaves the shared card alone', async () => {
    const h = harness({ oauthClientId: 'other-host-client', oauthRedirectUri: otherHostRedirect });
    await h.store.set(oauthClientSecretAccount('svc-1'), 'stale-secret');

    const result = await h.connect();

    expect(result.success).toBe(true);
    expect(h.autoRegisterOAuthApp).toHaveBeenCalledTimes(1);
    expect(await h.clientSecrets.getHostClient('svc-1')).toEqual({
      clientId: 'this-host-client',
      redirectUri: getOAuthRedirectUri(),
    });
    for (const patch of h.updates) {
      expect(patch).not.toHaveProperty('oauthClientId');
      expect(patch).not.toHaveProperty('oauthRedirectUri');
    }
    expect(h.service.oauthClientId).toBe('other-host-client');
    expect(await h.store.get(oauthClientSecretAccount('svc-1'))).toBeNull();
  });

  it('survives a reindex: the card still names the other host, yet this host resolves and reuses its own client', async () => {
    const h = harness({ oauthClientId: 'other-host-client', oauthRedirectUri: otherHostRedirect });
    await h.connect();

    // Restart: SQLite is rebuilt from the shared card; the secret store keeps this host's record.
    h.service.oauthClientId = 'other-host-client';
    h.service.oauthRedirectUri = otherHostRedirect;
    const resolved = await h.clientSecrets.resolveClient(
      h.service as { id: string },
      getOAuthRedirectUri(),
    );
    expect(resolved).toMatchObject({ clientId: 'this-host-client', hostRegistered: true });

    await h.connect();
    expect(h.autoRegisterOAuthApp).toHaveBeenCalledTimes(1);
    expect(await h.clientSecrets.getHostClient('svc-1')).toMatchObject({ clientId: 'this-host-client' });
    expect(h.service.oauthClientId).toBe('other-host-client');
  });

  it('writes the card on a host with no other host client, as before', async () => {
    const h = harness({});
    await h.connect();
    expect(h.updates.at(-1)).toMatchObject({
      oauthClientId: 'this-host-client',
      oauthRedirectUri: getOAuthRedirectUri(),
    });
    expect(await h.clientSecrets.getHostClient('svc-1')).toMatchObject({ clientId: 'this-host-client' });
  });

  it('ignores a host record registered for another redirect URI', async () => {
    const h = harness({ oauthClientId: 'card-client', oauthRedirectUri: getOAuthRedirectUri() });
    await h.clientSecrets.setHostClient('svc-1', { clientId: 'old-client', redirectUri: otherHostRedirect });
    const resolved = await h.clientSecrets.resolveClient(
      h.service as { id: string },
      getOAuthRedirectUri(),
    );
    expect(resolved).toMatchObject({ clientId: 'card-client', hostRegistered: false });
  });
});
