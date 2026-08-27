import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { DatabaseManager } from '../models/database';
import { OAuthManager } from '../services/oauth-manager';
import { MemorySecretStore } from '../vault/secret-store';
import { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { OAuthTokenVault } from '../vault/oauth-token-vault';
import { registerOAuthRoutes } from './oauth';

describe('GET /api/oauth/:serviceId/status', () => {
  let db: DatabaseManager;
  let oauthManager: OAuthManager;
  let tokens: OAuthTokenVault;
  let app: ReturnType<typeof Fastify>;
  let serviceId: string;

  beforeEach(async () => {
    db = new DatabaseManager(':memory:');
    const secretStore = new MemorySecretStore();
    const clientSecrets = new OAuthClientSecretVault(secretStore, db);
    tokens = new OAuthTokenVault(secretStore, db);
    oauthManager = new OAuthManager(db, clientSecrets, tokens);

    const service = await db.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
      oauthClientId: 'test-client',
      oauthAuthorizationUrl: 'https://mcp.linear.app/authorize',
      oauthTokenUrl: 'https://mcp.linear.app/token',
      oauthRedirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
      oauthScope: 'read write',
    });
    serviceId = service.id;

    app = Fastify();
    app.decorate('db', db);
    app.decorate('oauthManager', oauthManager);
    app.decorate('oauthClientSecretVault', clientSecrets);
    app.decorate('collectionWarningService', { clearCache: () => undefined });
    await app.register(registerOAuthRoutes, { prefix: '/api/oauth' });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    vi.unstubAllGlobals();
  });

  it('refreshes expired access token and returns updated expiresAt', async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(serviceId, 'expired-access', 'refresh-token', pastExpiry);

    const nextExpiresIn = 3600;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-type' ? 'application/json' : null,
        },
        text: async () =>
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'refresh-token',
            expires_in: nextExpiresIn,
            token_type: 'Bearer',
          }),
      }),
    );

    const before = Date.now();
    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth/${serviceId}/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.authenticated).toBe(true);
    expect(body.data.refreshFailed).toBe(false);
    expect(body.data.hasRefreshToken).toBe(true);
    expect(body.data.isExpired).toBe(false);
    expect(body.data.expiresAt).toBeTruthy();
    const expiresAtMs = new Date(body.data.expiresAt as string).getTime();
    expect(expiresAtMs).toBeGreaterThan(before + nextExpiresIn * 1000 - 5_000);
  });

  it('sets refreshFailed when refresh token cannot renew access', async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(serviceId, 'expired-access', 'dead-refresh', pastExpiry);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth/${serviceId}/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.hasToken).toBe(true);
    expect(body.data.hasRefreshToken).toBe(true);
    expect(body.data.refreshFailed).toBe(true);
    expect(body.data.authenticated).toBe(false);
  });
});
