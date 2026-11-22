import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getOAuthRedirectUri } from '../config/oauth-redirect';
import { DatabaseManager } from '../models/database';
import { FileStoreWriter } from '../store/writer';
import { oauthClientSecretAccount, OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { OAuthTokenVault } from '../vault/oauth-token-vault';
import { MemorySecretStore } from '../vault/secret-store';
import { OAuthManager } from './oauth-manager';

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
    async discoverService(url: string) {
      // NOT-655: discovery that fails or under-reports OAuth.
      if (String(url).includes('discovery-false')) {
        return { oauth: { required: false } };
      }
      if (String(url).includes('googleapis.com')) {
        return {
          oauth: {
            required: true,
            provider: 'google',
            supportsDynamicRegistration: false,
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopesSupported: ['https://www.googleapis.com/auth/gmail.readonly'],
          },
        };
      }
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

  it('never pairs a newly entered Client ID with the previous client\'s secret', async () => {
    const h = harness({ oauthClientId: 'card-client', oauthRedirectUri: getOAuthRedirectUri() });
    await h.store.set(oauthClientSecretAccount('svc-1'), 'card-client-secret');
    const result = await startOAuthConnect(
      {
        getService: async () => h.service,
        updateService: async (_id: string, patch: Record<string, unknown>) => {
          h.updates.push(patch);
          Object.assign(h.service, patch);
        },
      } as never,
      { autoRegisterOAuthApp: vi.fn(), initiateOAuthFlow: async () => ({ authorizationUrl: 'x', state: 's' }) } as never,
      h.clientSecrets,
      'svc-1',
      { clientId: 'new-manual-client' },
    );
    // Either the flow asks for the new client's secret, or it proceeds without the old one.
    if (result.success) {
      expect(await h.store.get(oauthClientSecretAccount('svc-1'))).not.toBe('card-client-secret');
    } else {
      expect(result.needsCredentials).toBe(true);
    }
  });

  it('a manual client clears this host\'s registered client record', async () => {
    const h = harness({ oauthClientId: 'other-host-client', oauthRedirectUri: 'http://other-host.invalid:1111/api/oauth/callback' });
    await h.connect();
    expect(await h.clientSecrets.getHostClient('svc-1')).not.toBeNull();
    await startOAuthConnect(
      {
        getService: async () => h.service,
        updateService: async (_id: string, patch: Record<string, unknown>) => {
          Object.assign(h.service, patch);
        },
      } as never,
      { autoRegisterOAuthApp: vi.fn(), initiateOAuthFlow: async () => ({ authorizationUrl: 'x', state: 's' }) } as never,
      h.clientSecrets,
      'svc-1',
      { clientId: 'manual-client', clientSecret: 'manual-secret' },
    );
    expect(await h.clientSecrets.getHostClient('svc-1')).toBeNull();
    expect(h.service.oauthClientId).toBe('manual-client');
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

/**
 * NOT-653: Connect used to write the OAuth client config to SQLite only, so a
 * restart/reindex (services table rebuilt from store files) wiped it and the
 * card could never refresh. The config must reach the card's store file.
 */
describe('startOAuthConnect store persistence', () => {
  const homes: string[] = [];
  const databases: DatabaseManager[] = [];

  afterEach(async () => {
    for (const db of databases.splice(0)) {
      db.close();
    }
    await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
  });

  it('writes a Google card OAuth config to its store file without any secret values', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-oauth-connect-store-'));
    homes.push(home);
    const db = new DatabaseManager(':memory:');
    databases.push(db);
    const service = await db.createService({
      name: 'Gmail (personal)',
      type: 'mcp',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
    });

    const secretStore = new MemorySecretStore();
    const clientSecrets = new OAuthClientSecretVault(secretStore, db);
    const tokens = new OAuthTokenVault(secretStore, db);
    const oauthManager = new OAuthManager(db, clientSecrets, tokens);
    const storeWriter = new FileStoreWriter(home);

    const result = await startOAuthConnect(
      db,
      oauthManager,
      clientSecrets,
      service.id,
      { clientId: 'google-client-id', clientSecret: 'google-client-secret-value' },
      { storeWriter },
    );
    expect(result.success).toBe(true);

    const raw = await fs.readFile(path.join(home, 'services', `${service.id}.json`), 'utf8');
    const stored = JSON.parse(raw) as Record<string, unknown>;
    expect(stored.oauthClientId).toBe('google-client-id');
    expect(stored.oauthAuthorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(stored.oauthTokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(stored.oauthRedirectUri).toBe(getOAuthRedirectUri());
    expect(stored.oauthScope).toBe('https://www.googleapis.com/auth/gmail.readonly');

    // No secret material in the git-synced store file — keys or values.
    expect(stored).not.toHaveProperty('oauthClientSecret');
    expect(stored).not.toHaveProperty('oauthAccessToken');
    expect(stored).not.toHaveProperty('oauthRefreshToken');
    expect(raw).not.toContain('google-client-secret-value');

    // The secret itself went to the vault, not the row.
    expect(await clientSecrets.get(service.id)).toBe('google-client-secret-value');
    expect((await db.getService(service.id))?.oauthClientSecret).toBe('');
  });
});

describe('startOAuthConnect when discovery reports OAuth not required (NOT-655)', () => {
  const databases: DatabaseManager[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close();
    }
  });

  function setup() {
    const db = new DatabaseManager(':memory:');
    databases.push(db);
    const secretStore = new MemorySecretStore();
    const clientSecrets = new OAuthClientSecretVault(secretStore, db);
    const tokens = new OAuthTokenVault(secretStore, db);
    const oauthManager = new OAuthManager(db, clientSecrets, tokens);
    return { db, clientSecrets, oauthManager };
  }

  it('reconnects a Google card with its saved client, endpoints and scope', async () => {
    const { db, clientSecrets, oauthManager } = setup();
    const service = await db.createService({
      name: 'Gmail (personal)',
      type: 'mcp',
      url: 'https://discovery-false.googleapis.com/mcp/v1',
      oauthClientId: 'google-client-id',
      oauthAuthorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      oauthTokenUrl: 'https://oauth2.googleapis.com/token',
      oauthScope: 'https://mail.google.com/ https://www.googleapis.com/auth/gmail.readonly',
    });
    await clientSecrets.set(service.id, 'google-client-secret-value');

    const result = await startOAuthConnect(db, oauthManager, clientSecrets, service.id, {});

    expect(result.success).toBe(true);
    if (!result.success) return;
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('google-client-id');
    expect(url.searchParams.get('scope')).toBe(
      'https://mail.google.com/ https://www.googleapis.com/auth/gmail.readonly',
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    const updated = await db.getService(service.id);
    expect(updated?.oauthTokenUrl).toBe('https://oauth2.googleapis.com/token');
  });

  it('falls back to Google fixed endpoints when the Google card has none saved', async () => {
    const { db, clientSecrets, oauthManager } = setup();
    const service = await db.createService({
      name: 'Google (personal)',
      type: 'mcp',
      url: 'https://discovery-false.googleapis.com/mcp/v1',
      oauthClientId: 'google-client-id',
      oauthScope: 'https://www.googleapis.com/auth/documents.readonly',
    });
    await clientSecrets.set(service.id, 'google-client-secret-value');

    const result = await startOAuthConnect(db, oauthManager, clientSecrets, service.id, {});

    expect(result.success).toBe(true);
    const updated = await db.getService(service.id);
    expect(updated?.oauthAuthorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(updated?.oauthTokenUrl).toBe('https://oauth2.googleapis.com/token');
  });

  it('still refuses a non-Google card whose discovery says OAuth is not required', async () => {
    const { db, clientSecrets, oauthManager } = setup();
    const service = await db.createService({
      name: 'Plain MCP',
      type: 'mcp',
      url: 'https://discovery-false.example.com/mcp',
      oauthClientId: 'some-client',
    });

    await expect(
      startOAuthConnect(db, oauthManager, clientSecrets, service.id, {}),
    ).rejects.toThrow('Service does not require OAuth authentication');
  });
});
