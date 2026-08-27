import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseManager } from '../models/database';
import { OAuthManager } from './oauth-manager';
import { MemorySecretStore } from '../vault/secret-store';
import { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { OAuthTokenVault } from '../vault/oauth-token-vault';

describe('OAuthManager PKCE', () => {
  let db: DatabaseManager;
  let oauthManager: OAuthManager;
  let clientSecrets: OAuthClientSecretVault;
  let tokens: OAuthTokenVault;

  beforeEach(async () => {
    db = new DatabaseManager(':memory:');
    const secretStore = new MemorySecretStore();
    clientSecrets = new OAuthClientSecretVault(secretStore, db);
    tokens = new OAuthTokenVault(secretStore, db);
    oauthManager = new OAuthManager(db, clientSecrets, tokens);

    await db.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
      oauthClientId: 'test-client',
      oauthAuthorizationUrl: 'https://mcp.linear.app/authorize',
      oauthTokenUrl: 'https://mcp.linear.app/token',
      oauthRedirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
      oauthScope: 'read write',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('includes S256 PKCE params in authorization URL', async () => {
    const services = await db.getAllServices();
    const serviceId = services[0]!.id;

    const { authorizationUrl, state } = await oauthManager.initiateOAuthFlow({
      serviceId,
      redirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
    });

    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe(state);
    expect(oauthManager.getOAuthState(state)).toBe(serviceId);
  });

  it('sends code_verifier during token exchange', async () => {
    const services = await db.getAllServices();
    const serviceId = services[0]!.id;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () =>
        JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { state } = await oauthManager.initiateOAuthFlow({
      serviceId,
      redirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
    });

    await oauthManager.handleOAuthCallback({
      serviceId,
      code: 'auth-code',
      state,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get('code_verifier')).toBeTruthy();
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code');
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');

    vi.unstubAllGlobals();
  });

  it('exchanges GitHub form-urlencoded token responses', async () => {
    await db.createService({
      name: 'GitHub',
      type: 'mcp',
      url: 'https://api.githubcopilot.com/mcp/',
      oauthClientId: 'github-client',
      oauthAuthorizationUrl: 'https://github.com/login/oauth/authorize',
      oauthTokenUrl: 'https://github.com/login/oauth/access_token',
      oauthRedirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
      oauthScope: 'read write',
    });

    const services = await db.getAllServices();
    const github = services.find((s) => s.name === 'GitHub')!;
    await clientSecrets.set(github.id, 'github-secret');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? 'application/x-www-form-urlencoded' : null,
      },
      text: async () => 'access_token=gho_test&scope=repo&token_type=bearer',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { state } = await oauthManager.initiateOAuthFlow({
      serviceId: github.id,
      redirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
    });

    const token = await oauthManager.handleOAuthCallback({
      serviceId: github.id,
      code: 'auth-code',
      state,
    });

    expect(token.accessToken).toBe('gho_test');
    expect(await oauthManager.getValidAccessToken(github.id)).toBe('gho_test');

    vi.unstubAllGlobals();
  });

  it('treats token without expiry as not expired', async () => {
    const services = await db.getAllServices();
    const serviceId = services[0]!.id;

    await tokens.set(serviceId, 'long-lived-token');

    expect(await oauthManager.isTokenExpired(serviceId)).toBe(false);
    expect(await oauthManager.getValidAccessToken(serviceId)).toBe('long-lived-token');
  });

  it('deduplicates concurrent refresh requests for one service', async () => {
    const services = await db.getAllServices();
    const serviceId = services[0]!.id;
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(serviceId, 'expired-access', 'refresh-token', pastExpiry);

    let refreshCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      refreshCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        ok: true,
        headers: {
          get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
        },
        text: async () =>
          JSON.stringify({
            access_token: `access-${refreshCount}`,
            refresh_token: 'refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      oauthManager.getValidAccessToken(serviceId),
      oauthManager.getValidAccessToken(serviceId),
    ]);

    expect(first).toBe('access-1');
    expect(second).toBe('access-1');
    expect(refreshCount).toBe(1);

    vi.unstubAllGlobals();
  });

  it('keeps prior refresh token when provider omits rotation', async () => {
    const services = await db.getAllServices();
    const serviceId = services[0]!.id;
    await tokens.set(serviceId, 'access-token', 'keep-this-refresh');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () =>
        JSON.stringify({
          access_token: 'new-access',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await oauthManager.refreshOAuthToken({
      serviceId,
      refreshToken: 'keep-this-refresh',
    });

    const bundle = await tokens.get(serviceId);
    expect(bundle?.accessToken).toBe('new-access');
    expect(bundle?.refreshToken).toBe('keep-this-refresh');

    vi.unstubAllGlobals();
  });
});
