import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { DatabaseManager } from '../models/database';
import { OAuthManager } from '../services/oauth-manager';
import { MCPClientManager } from '../services/mcp-client-manager';
import { ServiceManager } from '../services/service-manager';
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
  let broadcast: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    db = new DatabaseManager(':memory:');
    const secretStore = new MemorySecretStore();
    const clientSecrets = new OAuthClientSecretVault(secretStore, db);
    tokens = new OAuthTokenVault(secretStore, db);
    oauthManager = new OAuthManager(db, clientSecrets, tokens);
    const mcpClient = new MCPClientManager(
      (id) => oauthManager.getValidAccessToken(id),
      (id) => oauthManager.forceRefreshAccessToken(id),
    );
    const serviceManager = new ServiceManager(
      db,
      mcpClient,
      oauthManager,
      clientSecrets,
    );
    broadcast = vi.fn();
    serviceManager.setStatusBroadcaster(broadcast);

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
    app.decorate('serviceManager', serviceManager);
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
    // Non-Google cards are untouched in NOT-654: no health reconciliation.
    expect(broadcast).not.toHaveBeenCalled();
  });

  async function createGoogleService() {
    return db.createService({
      name: 'Gmail',
      type: 'mcp',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      oauthClientId: 'google-client',
      oauthAuthorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      oauthTokenUrl: 'https://oauth2.googleapis.com/token',
      oauthRedirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
      oauthScope: 'https://www.googleapis.com/auth/gmail.readonly',
    });
  }

  it('NOT-654: reports needs_reconnect/refresh_rejected for a revoked grant', async () => {
    const google = await createGoogleService();
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(google.id, 'expired-access', 'revoked-refresh', pastExpiry);
    await db.updateServiceStatus(google.id, true, 'healthy');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          }),
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth/${google.id}/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.authState).toBe('needs_reconnect');
    expect(body.data.reason).toBe('refresh_rejected');
    expect(body.data.refreshFailed).toBe(true);
    expect(body.data.authenticated).toBe(false);
    // Repair round 3: the read itself discovered the revoked grant, so it
    // reconciles the stale `healthy` row into `unhealthy` + broadcasts.
    const row = await db.getService(google.id);
    expect(row?.health).toBe('unhealthy');
    expect(row?.isConnected).toBe(false);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      serviceId: google.id,
      health: 'unhealthy',
      isConnected: false,
      lastPing: expect.any(String),
    });

    // A second read does not rebroadcast.
    const again = await app.inject({
      method: 'GET',
      url: `/api/oauth/${google.id}/status`,
    });
    expect(again.statusCode).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('NOT-654: reports needs_reconnect/no_refresh_token for an expired token without one', async () => {
    const google = await createGoogleService();
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(google.id, 'expired-access', undefined, pastExpiry);
    await db.updateServiceStatus(google.id, true, 'healthy');

    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth/${google.id}/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.authState).toBe('needs_reconnect');
    expect(body.data.reason).toBe('no_refresh_token');
    expect(body.data.authenticated).toBe(false);
    const row = await db.getService(google.id);
    expect(row?.health).toBe('unhealthy');
    expect(row?.isConnected).toBe(false);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('NOT-654: reports ok for a fresh token, with no reason', async () => {
    const google = await createGoogleService();
    const futureExpiry = new Date(Date.now() + 3_600_000).toISOString();
    await tokens.set(google.id, 'fresh-access', 'fresh-refresh', futureExpiry);

    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth/${google.id}/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.authState).toBe('ok');
    expect(body.data.reason).toBeUndefined();
    expect(body.data.authenticated).toBe(true);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('NOT-654: reports ok for a non-Google card with a fresh token', async () => {
    const futureExpiry = new Date(Date.now() + 3_600_000).toISOString();
    await tokens.set(serviceId, 'fresh-access', 'fresh-refresh', futureExpiry);

    const res = await app.inject({
      method: 'GET',
      url: `/api/oauth/${serviceId}/status`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.authState).toBe('ok');
    expect(body.data.authenticated).toBe(true);
    expect(body.data.hasRefreshToken).toBe(true);
    expect(body.data.refreshFailed).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });
});
