import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseManager } from '../models/database';
import { migrateSqliteToStore } from '../store/migrate';
import { reindexStoreToSqlite } from '../store/reindex';
import { FileStoreWriter } from '../store/writer';
import { MemorySecretStore } from '../vault/secret-store';
import { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { OAuthTokenVault } from '../vault/oauth-token-vault';
import { startOAuthConnect } from './oauth-connect-service';
import { OAuthManager } from './oauth-manager';

vi.mock('./mcp-discovery-service', () => ({
  MCPDiscoveryService: class {
    async discoverService(url: string) {
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
          authorizationUrl: 'https://mcp.linear.app/authorize',
          tokenUrl: 'https://mcp.linear.app/token',
          scopesSupported: ['read write'],
        },
      };
    }
  },
}));

/**
 * NOT-639: a store reindex rebuilds the `services` table from files, which
 * never carry OAuth token state. The token bundle stays in the vault, so the
 * card must keep its has-token flag and expiry — otherwise an expired access
 * token is never refreshed and every call fails with `invalid_token`.
 */
describe('OAuth token state across a store reindex', () => {
  let home: string;
  let dbPath: string;
  let secretStore: MemorySecretStore;
  const databases: DatabaseManager[] = [];

  function open(): { db: DatabaseManager; tokens: OAuthTokenVault; manager: OAuthManager } {
    const db = new DatabaseManager(dbPath);
    databases.push(db);
    const tokens = new OAuthTokenVault(secretStore, db);
    const manager = new OAuthManager(db, new OAuthClientSecretVault(secretStore, db), tokens);
    return { db, tokens, manager };
  }

  async function seedLinearCard(db: DatabaseManager): Promise<string> {
    const service = await db.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
      oauthClientId: 'linear-client',
      oauthAuthorizationUrl: 'https://mcp.linear.app/authorize',
      oauthTokenUrl: 'https://mcp.linear.app/token',
      oauthRedirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
      oauthScope: 'read write',
    });
    await migrateSqliteToStore(db, { home });
    return service.id;
  }

  function stubTokenEndpoint(accessToken: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () =>
        JSON.stringify({
          access_token: accessToken,
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-oauth-reindex-'));
    dbPath = path.join(home, 'agent_deck.db');
    secretStore = new MemorySecretStore();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const db of databases.splice(0)) {
      db.close();
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  it('keeps oauthHasToken and oauthTokenExpiresAt through a forced reindex', async () => {
    const { db, tokens } = open();
    const serviceId = await seedLinearCard(db);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await tokens.set(serviceId, 'access-1', 'refresh-1', expiresAt);

    const before = await db.getService(serviceId);
    expect(before?.oauthHasToken).toBe(true);
    expect(before?.oauthTokenExpiresAt).toBe(expiresAt);

    const result = await reindexStoreToSqlite(db, { home, force: true });
    expect(result.ok).toBe(true);

    const after = await db.getService(serviceId);
    expect(after?.oauthHasToken).toBe(true);
    expect(after?.oauthTokenExpiresAt).toBe(expiresAt);
  });

  it('restores the flag and expiry from the vault when the database itself was rebuilt', async () => {
    const first = open();
    const serviceId = await seedLinearCard(first.db);
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await first.tokens.set(serviceId, 'access-1', 'refresh-1', expiresAt);
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    await fs.unlink(dbPath);

    const { db, manager } = open();
    expect((await reindexStoreToSqlite(db, { home })).ok).toBe(true);
    expect((await db.getService(serviceId))?.oauthHasToken).toBe(false);

    // Still valid: served from the vault without a refresh, and the row is repaired.
    const fetchMock = stubTokenEndpoint('unused');
    expect(await manager.getValidAccessToken(serviceId)).toBe('access-1');
    expect(fetchMock).not.toHaveBeenCalled();
    const repaired = await db.getService(serviceId);
    expect(repaired?.oauthHasToken).toBe(true);
    expect(repaired?.oauthTokenExpiresAt).toBe(expiresAt);
  });

  it('refreshes an expired access token after a reindex and returns the new token', async () => {
    const { db, tokens, manager } = open();
    const serviceId = await seedLinearCard(db);
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(serviceId, 'expired-access', 'refresh-1', pastExpiry);

    expect((await reindexStoreToSqlite(db, { home, force: true })).ok).toBe(true);

    const fetchMock = stubTokenEndpoint('fresh-access');
    expect(await manager.getValidAccessToken(serviceId)).toBe('fresh-access');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://mcp.linear.app/token');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');

    const bundle = await tokens.get(serviceId);
    expect(bundle?.accessToken).toBe('fresh-access');
    expect(bundle?.refreshToken).toBe('rotated-refresh');
    const row = await db.getService(serviceId);
    expect(row?.oauthHasToken).toBe(true);
    expect(new Date(row!.oauthTokenExpiresAt!).getTime()).toBeGreaterThan(Date.now());
    // The fresh expiry also lives with the tokens, so the next rebuild keeps it.
    expect(bundle?.expiresAt).toBe(row?.oauthTokenExpiresAt);
  });

  it('refreshes after a rebuilt database using the expiry kept in the vault', async () => {
    const first = open();
    const serviceId = await seedLinearCard(first.db);
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await first.tokens.set(serviceId, 'expired-access', 'refresh-1', pastExpiry);
    first.db.close();
    databases.splice(databases.indexOf(first.db), 1);
    await fs.unlink(dbPath);

    const { db, manager } = open();
    expect((await reindexStoreToSqlite(db, { home })).ok).toBe(true);
    expect((await db.getService(serviceId))?.oauthTokenExpiresAt).toBeFalsy();

    const fetchMock = stubTokenEndpoint('fresh-access');
    expect(await manager.getValidAccessToken(serviceId)).toBe('fresh-access');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('forceRefreshAccessToken refreshes regardless of expiry, and returns null without a refresh token', async () => {
    const { db, tokens, manager } = open();
    const serviceId = await seedLinearCard(db);
    await tokens.set(serviceId, 'rejected-access', 'refresh-1');

    const fetchMock = stubTokenEndpoint('fresh-access');
    expect(await manager.forceRefreshAccessToken(serviceId)).toBe('fresh-access');
    expect(fetchMock).toHaveBeenCalledOnce();

    await tokens.set(serviceId, 'no-refresh-access');
    expect(await manager.forceRefreshAccessToken(serviceId)).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

/**
 * NOT-653: a Google card connected through startOAuthConnect keeps its client
 * ID, authorization URL and token URL through a full store reindex, and can
 * then refresh — the refresh grant goes to the Google token endpoint.
 */
describe('Google OAuth client config across a store reindex', () => {
  let home: string;
  let dbPath: string;
  let secretStore: MemorySecretStore;
  const databases: DatabaseManager[] = [];

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-google-oauth-reindex-'));
    dbPath = path.join(home, 'agent_deck.db');
    secretStore = new MemorySecretStore();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const db of databases.splice(0)) {
      db.close();
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  function stubTokenEndpoint(accessToken: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () =>
        JSON.stringify({
          access_token: accessToken,
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('connect → reindex → refresh posts a refresh_token grant to the Google token endpoint', async () => {
    const db = new DatabaseManager(dbPath);
    databases.push(db);
    const clientSecrets = new OAuthClientSecretVault(secretStore, db);
    const tokens = new OAuthTokenVault(secretStore, db);
    const storeWriter = new FileStoreWriter(home);
    const manager = new OAuthManager(db, clientSecrets, tokens, storeWriter);

    const service = await db.createService({
      name: 'Gmail (personal)',
      type: 'mcp',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
    });

    const connected = await startOAuthConnect(
      db,
      manager,
      clientSecrets,
      service.id,
      { clientId: 'google-client', clientSecret: 'google-secret' },
      { storeWriter },
    );
    expect(connected.success).toBe(true);
    // The callback stores tokens in the vault; the client config is on the row + file.
    await tokens.set(service.id, 'expired-access', 'google-refresh');
    await storeWriter.ensureLayout();

    const result = await reindexStoreToSqlite(db, { home, force: true });
    expect(result.ok).toBe(true);

    const after = await db.getService(service.id);
    expect(after?.oauthClientId).toBe('google-client');
    expect(after?.oauthAuthorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(after?.oauthTokenUrl).toBe('https://oauth2.googleapis.com/token');

    const fetchMock = stubTokenEndpoint('fresh-access');
    expect(await manager.forceRefreshAccessToken(service.id)).toBe('fresh-access');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('google-refresh');
    expect(body.get('client_id')).toBe('google-client');
  });
});
