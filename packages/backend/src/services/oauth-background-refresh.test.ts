import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseManager } from '../models/database';
import { MemorySecretStore } from '../vault/secret-store';
import { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { OAuthTokenVault } from '../vault/oauth-token-vault';
import { OAuthManager, OAuthRefreshError } from './oauth-manager';
import { MCPClientManager } from './mcp-client-manager';
import {
  computeOAuthRefreshRetryDelayMs,
  OAUTH_BACKGROUND_REFRESH_INTERVAL_MS,
  startOAuthBackgroundRefresh,
  type OAuthBackgroundRefreshClock,
  type OAuthBackgroundRefreshDeps,
} from './oauth-background-refresh';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_MCP_URL = 'https://gmailmcp.googleapis.com/mcp/v1';

function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * NOT-654: a Google card that holds a refresh token renews its access token
 * on its own — idle, and at startup when the token already expired — while a
 * dead grant surfaces as `needs_reconnect` instead of `healthy`.
 *
 * Time is a fake clock (`vi.useFakeTimers`, which also drives the
 * refresher's default interval + `Date.now` expiry math); the token and MCP
 * endpoints are stubbed `fetch` handlers, so no sockets are opened.
 */
describe('OAuth background refresh (NOT-654)', () => {
  let db: DatabaseManager;
  let tokens: OAuthTokenVault;
  let clientSecrets: OAuthClientSecretVault;
  let oauthManager: OAuthManager;
  let stopFns: Array<() => void>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T12:00:00.000Z'));
    db = new DatabaseManager(':memory:');
    const secretStore = new MemorySecretStore();
    clientSecrets = new OAuthClientSecretVault(secretStore, db);
    tokens = new OAuthTokenVault(secretStore, db);
    oauthManager = new OAuthManager(db, clientSecrets, tokens);
    stopFns = [];
  });

  afterEach(() => {
    for (const stop of stopFns.splice(0)) {
      stop();
    }
    vi.unstubAllGlobals();
    vi.useRealTimers();
    db.close();
  });

  async function createGoogleService(
    overrides: {
      name?: string;
      oauthClientId?: string;
      oauthAuthorizationUrl?: string;
      oauthTokenUrl?: string;
    } = {},
  ) {
    return db.createService({
      name: 'Gmail',
      type: 'mcp',
      url: GOOGLE_MCP_URL,
      oauthClientId: 'google-client',
      oauthAuthorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      oauthTokenUrl: GOOGLE_TOKEN_URL,
      oauthScope: 'https://www.googleapis.com/auth/gmail.readonly',
      ...overrides,
    });
  }

  function startRefresher(
    depOverrides: Partial<OAuthBackgroundRefreshDeps> = {},
    options: {
      clock?: OAuthBackgroundRefreshClock;
      onError?: (error: unknown, serviceId?: string) => void;
    } = {},
  ): { deps: OAuthBackgroundRefreshDeps; stop: () => void } {
    const deps: OAuthBackgroundRefreshDeps = {
      listServices: () => db.getAllServices(),
      getTokenBundle: (service) =>
        tokens.get(
          service.id,
          service.oauthAccessToken,
          service.oauthRefreshToken,
        ),
      refresh: (serviceId, refreshToken) =>
        oauthManager.refreshOAuthToken({ serviceId, refreshToken }),
      isRefreshRejected: (serviceId) =>
        oauthManager.isOAuthRefreshRejected(serviceId),
      invalidateClient: vi.fn(),
      onRefreshRejected: vi.fn(),
      ...depOverrides,
    };
    const stop = startOAuthBackgroundRefresh(deps, {
      onError: () => undefined,
      ...options,
    });
    stopFns.push(stop);
    return { deps, stop };
  }

  function installTokenStub(
    handler: (body: URLSearchParams) => Response | Promise<Response>,
  ) {
    const fetchMock = vi.fn(
      async (_input: unknown, init?: { body?: unknown }) => {
        const body = new URLSearchParams(String(init?.body ?? ''));
        return handler(body);
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('renews an idle Google card before every expiry across 3 hours', async () => {
    const service = await createGoogleService();
    await tokens.set(
      service.id,
      'access-0',
      'refresh-0',
      new Date(Date.now() + 3_600_000).toISOString(),
    );

    const grants: Array<{ calledAt: number; prevExpiry?: string }> = [];
    let grantCount = 0;
    installTokenStub(async (body) => {
      expect(body.get('grant_type')).toBe('refresh_token');
      grantCount += 1;
      const prev = await tokens.get(service.id);
      grants.push({ calledAt: Date.now(), prevExpiry: prev?.expiresAt });
      return jsonResponse({
        access_token: `access-${grantCount}`,
        refresh_token: `refresh-${grantCount}`,
        expires_in: 3600,
        token_type: 'Bearer',
      });
    });

    const { deps } = startRefresher();
    await vi.advanceTimersByTimeAsync(0);
    expect(grantCount).toBe(0); // Fresh token: the startup tick has nothing to do.

    // Three idle hours, no tool calls: the vault expiry must never lapse.
    for (let step = 0; step < 18; step++) {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const bundle = await tokens.get(service.id);
      expect(new Date(bundle!.expiresAt!).getTime()).toBeGreaterThan(
        Date.now(),
      );
    }

    expect(grantCount).toBeGreaterThanOrEqual(3);
    for (const grant of grants) {
      expect(grant.prevExpiry).toBeTruthy();
      const prevMs = Date.parse(grant.prevExpiry!);
      expect(grant.calledAt).toBeLessThan(prevMs);
      expect(prevMs - grant.calledAt).toBeLessThanOrEqual(5 * 60_000);
    }
    expect(deps.invalidateClient).toHaveBeenCalledTimes(grantCount);
  });

  it('renews an already-expired token at startup; the next callTool uses the new token first try', async () => {
    const service = await createGoogleService();
    await tokens.set(
      service.id,
      'expired-access',
      'refresh-0',
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
    );

    let grants = 0;
    const mcpRequests: Array<{ method: string; auth: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }) => {
        const url = String(input);
        if (url === GOOGLE_TOKEN_URL) {
          grants += 1;
          return jsonResponse({
            access_token: 'renewed-access',
            refresh_token: 'refresh-1',
            expires_in: 3600,
            token_type: 'Bearer',
          });
        }
        // MCP endpoint: only the renewed token is accepted.
        const method = init?.method ?? 'GET';
        if (method === 'GET') {
          return new Response('no sse', { status: 405 });
        }
        if (method === 'DELETE') {
          return new Response(null, { status: 200 });
        }
        const msg = JSON.parse(String(init?.body ?? '{}'));
        const auth = new Headers(init?.headers as HeadersInit).get('authorization');
        mcpRequests.push({ method: msg.method, auth });
        if (msg.method === 'initialize') {
          return jsonResponse(
            {
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'mock-google', version: '1.0.0' },
              },
            },
            200,
            { 'mcp-session-id': 'mock-session' },
          );
        }
        if (msg.method === 'notifications/initialized') {
          return new Response(null, { status: 202 });
        }
        if (msg.method === 'tools/call') {
          if (auth !== 'Bearer renewed-access') {
            return jsonResponse({ error: 'invalid_token' }, 401, {
              'www-authenticate': 'Bearer resource_metadata="https://example"',
            });
          }
          return jsonResponse({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: 'called' }] },
          });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    startRefresher();
    await vi.advanceTimersByTimeAsync(0);
    expect(grants).toBe(1); // First tick at startup renewed the 2h-expired token.
    expect((await tokens.get(service.id))?.accessToken).toBe('renewed-access');

    const mcp = new MCPClientManager(
      (id) => oauthManager.getValidAccessToken(id),
      (id) => oauthManager.forceRefreshAccessToken(id),
    );
    try {
      const live = await db.getService(service.id);
      const result = await mcp.callTool(live!, 'gmail_list', {});
      expect(result).toMatchObject({ content: [{ type: 'text', text: 'called' }] });
    } finally {
      await mcp.cleanup();
    }

    expect(grants).toBe(1); // No 401 retry: the first attempt already used the renewed token.
    expect(mcpRequests[0]).toEqual({
      method: 'initialize',
      auth: 'Bearer renewed-access',
    });
    expect(mcpRequests).toContainEqual({
      method: 'tools/call',
      auth: 'Bearer renewed-access',
    });
  });

  it('stops retrying a revoked grant and reports needs_reconnect until a reconnect', async () => {
    const service = await createGoogleService();
    await tokens.set(
      service.id,
      'expired-access',
      'revoked-refresh',
      new Date(Date.now() - 60_000).toISOString(),
    );

    let grants = 0;
    let allowRefresh = false;
    installTokenStub((body) => {
      if (body.get('grant_type') === 'authorization_code') {
        return jsonResponse({
          access_token: 'reconnected-access',
          refresh_token: 'reconnected-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      grants += 1;
      if (allowRefresh) {
        return jsonResponse({
          access_token: `access-new-${grants}`,
          refresh_token: 'reconnected-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      return jsonResponse(
        {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        },
        400,
      );
    });

    const { deps } = startRefresher();
    await vi.advanceTimersByTimeAsync(0);
    expect(grants).toBe(1);
    await expect(oauthManager.isOAuthRefreshRejected(service.id)).resolves.toBe(
      true,
    );
    await expect(oauthManager.getOAuthAuthState(service.id)).resolves.toEqual({
      authState: 'needs_reconnect',
      reason: 'refresh_rejected',
    });
    expect(deps.onRefreshRejected).toHaveBeenCalledTimes(1);
    expect(deps.onRefreshRejected).toHaveBeenCalledWith(service.id);
    expect(deps.invalidateClient).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(grants).toBe(1); // Stopped until reconnected.

    // A human reconnects: the full callback flow clears the rejected state.
    const { state } = await oauthManager.initiateOAuthFlow({
      serviceId: service.id,
      redirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
    });
    await oauthManager.handleOAuthCallback({
      serviceId: service.id,
      code: 'auth-code',
      state,
    });
    await expect(oauthManager.isOAuthRefreshRejected(service.id)).resolves.toBe(
      false,
    );
    allowRefresh = true;

    await vi.advanceTimersByTimeAsync(70 * 60_000);
    expect(grants).toBe(2); // The refresher resumed after the reconnect.
    await expect(oauthManager.getOAuthAuthState(service.id)).resolves.toEqual({
      authState: 'ok',
    });
    expect(deps.onRefreshRejected).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures with capped backoff and recovers without needs_reconnect', async () => {
    const service = await createGoogleService();
    await tokens.set(
      service.id,
      'expired-access',
      'good-refresh',
      new Date(Date.now() - 60_000).toISOString(),
    );
    const startedAt = Date.now();

    const attempts: number[] = [];
    const errors: unknown[] = [];
    let n = 0;
    installTokenStub(() => {
      n += 1;
      attempts.push(Date.now());
      if (n === 1) {
        throw new TypeError('fetch failed');
      }
      if (n === 2) {
        return new Response('overloaded', { status: 503 });
      }
      return jsonResponse({
        access_token: 'recovered-access',
        refresh_token: 'good-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    });

    const { deps } = startRefresher(
      {},
      {
        onError: (error) => {
          errors.push(error);
        },
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    await expect(oauthManager.isOAuthRefreshRejected(service.id)).resolves.toBe(
      false,
    );
    await expect(oauthManager.getOAuthAuthState(service.id)).resolves.toEqual({
      authState: 'ok',
    });
    expect(deps.onRefreshRejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(n).toBe(2); // First retry after the 60s base delay.
    await expect(oauthManager.isOAuthRefreshRejected(service.id)).resolves.toBe(
      false,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(n).toBe(2); // Backoff: the second retry waits 120s.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(n).toBe(3);

    expect(attempts).toEqual([startedAt, startedAt + 60_000, startedAt + 180_000]);
    expect((await tokens.get(service.id))?.accessToken).toBe('recovered-access');
    await expect(oauthManager.getOAuthAuthState(service.id)).resolves.toEqual({
      authState: 'ok',
    });
    expect(deps.invalidateClient).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBeInstanceOf(OAuthRefreshError);
    expect((errors[0] as OAuthRefreshError).kind).toBe('transient');
    expect((errors[1] as OAuthRefreshError).kind).toBe('transient');
  });

  it('caps the retry backoff at 15 minutes', () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7, 20].map(computeOAuthRefreshRetryDelayMs),
    ).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000, 900_000]);
  });

  it('skips Google cards without a refresh token; they report no_refresh_token', async () => {
    const service = await createGoogleService();
    await tokens.set(
      service.id,
      'expired-access',
      undefined,
      new Date(Date.now() - 60_000).toISOString(),
    );
    const fetchMock = installTokenStub(() =>
      jsonResponse({ access_token: 'x', expires_in: 3600 }),
    );
    startRefresher();
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(oauthManager.getOAuthAuthState(service.id)).resolves.toEqual({
      authState: 'needs_reconnect',
      reason: 'no_refresh_token',
    });
  });

  it('leaves non-Google cards alone while on-demand refresh keeps working', async () => {
    const linear = await db.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
      oauthClientId: 'linear-client',
      oauthAuthorizationUrl: 'https://mcp.linear.app/authorize',
      oauthTokenUrl: 'https://mcp.linear.app/token',
    });
    await tokens.set(
      linear.id,
      'expired-access',
      'linear-refresh',
      new Date(Date.now() - 60_000).toISOString(),
    );
    const fetchMock = installTokenStub(() =>
      jsonResponse({ access_token: 'linear-new', expires_in: 3600 }),
    );
    startRefresher();
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(oauthManager.getValidAccessToken(linear.id)).resolves.toBe(
      'linear-new',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('computes authState from the vault, not from a probe', async () => {
    const fresh = await createGoogleService({ name: 'Fresh' });
    await tokens.set(
      fresh.id,
      'a',
      'r',
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    await expect(oauthManager.getOAuthAuthState(fresh.id)).resolves.toEqual({
      authState: 'ok',
    });

    const refreshable = await createGoogleService({ name: 'Refreshable' });
    await tokens.set(
      refreshable.id,
      'a',
      'r',
      new Date(Date.now() - 60_000).toISOString(),
    );
    await expect(
      oauthManager.getOAuthAuthState(refreshable.id),
    ).resolves.toEqual({ authState: 'ok' });

    const empty = await createGoogleService({ name: 'Empty' });
    await expect(oauthManager.getOAuthAuthState(empty.id)).resolves.toEqual({
      authState: 'needs_reconnect',
      reason: 'no_token',
    });

    const noConfig = await db.createService({
      name: 'NoConfig',
      type: 'mcp',
      url: GOOGLE_MCP_URL,
      oauthClientId: 'google-client',
      oauthAuthorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    });
    await tokens.set(
      noConfig.id,
      'a',
      'r',
      new Date(Date.now() - 60_000).toISOString(),
    );
    await expect(oauthManager.getOAuthAuthState(noConfig.id)).resolves.toEqual({
      authState: 'needs_reconnect',
      reason: 'missing_config',
    });

    const plain = await db.createService({
      name: 'Plain',
      type: 'mcp',
      url: 'https://example.com/mcp',
    });
    await expect(oauthManager.getOAuthAuthState(plain.id)).resolves.toEqual({
      authState: 'ok',
    });
  });

  it.each([
    {
      name: 'invalid_grant',
      status: 400,
      body: { error: 'invalid_grant' },
      kind: 'rejected',
      rejected: true,
    },
    {
      name: 'invalid_client',
      status: 401,
      body: { error: 'invalid_client' },
      kind: 'rejected',
      rejected: true,
    },
    {
      name: 'invalid_request 4xx',
      status: 400,
      body: { error: 'invalid_request' },
      kind: 'transient',
      rejected: false,
    },
    {
      name: 'unrecognized 4xx code',
      status: 400,
      body: { error: 'access_denied' },
      kind: 'transient',
      rejected: false,
    },
    {
      name: 'unparseable 4xx body',
      status: 400,
      body: 'bad request',
      kind: 'transient',
      rejected: false,
    },
    {
      name: 'plain-text invalid_grant',
      status: 400,
      body: 'invalid_grant',
      kind: 'rejected',
      rejected: true,
    },
    { name: '5xx', status: 503, body: 'overloaded', kind: 'transient', rejected: false },
    { name: 'rate limited', status: 429, body: 'slow down', kind: 'transient', rejected: false },
  ])(
    'classifies a $name token-endpoint failure as $kind',
    async ({ status, body, kind, rejected }) => {
      const service = await createGoogleService();
      await tokens.set(
        service.id,
        'expired-access',
        'refresh-token',
        new Date(Date.now() - 60_000).toISOString(),
      );
      installTokenStub(() =>
        typeof body === 'string'
          ? new Response(body, { status })
          : jsonResponse(body, status),
      );

      const failure = await oauthManager
        .refreshOAuthToken({ serviceId: service.id, refreshToken: 'refresh-token' })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(OAuthRefreshError);
      expect((failure as OAuthRefreshError).kind).toBe(kind);
      await expect(
        oauthManager.isOAuthRefreshRejected(service.id),
      ).resolves.toBe(rejected);
      // The vault token is untouched by a failed grant.
      expect((await tokens.get(service.id))?.accessToken).toBe('expired-access');
    },
  );

  it('classifies a network failure as transient and keeps the token', async () => {
    const service = await createGoogleService();
    await tokens.set(
      service.id,
      'expired-access',
      'refresh-token',
      new Date(Date.now() - 60_000).toISOString(),
    );
    installTokenStub(() => {
      throw new TypeError('fetch failed');
    });

    const failure = await oauthManager
      .refreshOAuthToken({ serviceId: service.id, refreshToken: 'refresh-token' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(OAuthRefreshError);
    expect((failure as OAuthRefreshError).kind).toBe('transient');
    await expect(oauthManager.isOAuthRefreshRejected(service.id)).resolves.toBe(
      false,
    );
    expect((await tokens.get(service.id))?.accessToken).toBe('expired-access');
  });

  it('classifies a missing token URL as missing_config', async () => {
    const linear = await db.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
      oauthClientId: 'linear-client',
    });
    await tokens.set(linear.id, 'expired-access', 'refresh-token');
    installTokenStub(() => jsonResponse({ access_token: 'x' }));

    const failure = await oauthManager
      .refreshOAuthToken({ serviceId: linear.id, refreshToken: 'refresh-token' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(OAuthRefreshError);
    expect((failure as OAuthRefreshError).kind).toBe('missing_config');
    await expect(oauthManager.isOAuthRefreshRejected(linear.id)).resolves.toBe(
      false,
    );
  });

  it('clears the rejected state when a later grant succeeds', async () => {
    const service = await createGoogleService();
    await tokens.set(
      service.id,
      'expired-access',
      'refresh-token',
      new Date(Date.now() - 60_000).toISOString(),
    );
    let calls = 0;
    installTokenStub(() => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: 'invalid_grant' }, 400)
        : jsonResponse({
            access_token: 'recovered-access',
            refresh_token: 'refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          });
    });

    await expect(
      oauthManager.refreshOAuthToken({
        serviceId: service.id,
        refreshToken: 'refresh-token',
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);
    await expect(oauthManager.isOAuthRefreshRejected(service.id)).resolves.toBe(
      true,
    );

    await oauthManager.refreshOAuthToken({
      serviceId: service.id,
      refreshToken: 'refresh-token',
    });
    await expect(oauthManager.isOAuthRefreshRejected(service.id)).resolves.toBe(
      false,
    );
    await expect(oauthManager.getOAuthAuthState(service.id)).resolves.toEqual({
      authState: 'ok',
    });
  });

  it('keeps the rejected state across manager recreation (restart) until a reconnect clears it', async () => {
    const service = await createGoogleService();
    await tokens.set(
      service.id,
      'expired-access',
      'revoked-refresh',
      new Date(Date.now() - 60_000).toISOString(),
    );

    let grants = 0;
    installTokenStub((body) => {
      if (body.get('grant_type') === 'authorization_code') {
        return jsonResponse({
          access_token: 'reconnected-access',
          refresh_token: 'reconnected-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      grants += 1;
      return jsonResponse({ error: 'invalid_grant' }, 400);
    });

    // The on-demand path persists the rejection in SQLite.
    await expect(
      oauthManager.refreshOAuthToken({
        serviceId: service.id,
        refreshToken: 'revoked-refresh',
      }),
    ).rejects.toBeInstanceOf(OAuthRefreshError);
    expect(grants).toBe(1);
    expect((await db.getService(service.id))?.oauthRefreshRejected).toBe(true);

    // Simulate a daemon restart: a brand-new manager over the same DB/vaults
    // still reports the dead grant — never `ok`.
    const restarted = new OAuthManager(db, clientSecrets, tokens);
    await expect(restarted.isOAuthRefreshRejected(service.id)).resolves.toBe(
      true,
    );
    await expect(restarted.getOAuthAuthState(service.id)).resolves.toEqual({
      authState: 'needs_reconnect',
      reason: 'refresh_rejected',
    });

    // The refresher wired to the restarted manager still skips the dead card.
    const { deps } = startRefresher({
      refresh: (serviceId, refreshToken) =>
        restarted.refreshOAuthToken({ serviceId, refreshToken }),
      isRefreshRejected: (serviceId) =>
        restarted.isOAuthRefreshRejected(serviceId),
    });
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(grants).toBe(1);
    expect(deps.onRefreshRejected).not.toHaveBeenCalled();

    // A reconnect through the restarted manager clears the persisted state…
    const { state } = await restarted.initiateOAuthFlow({
      serviceId: service.id,
      redirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
    });
    await restarted.handleOAuthCallback({
      serviceId: service.id,
      code: 'auth-code',
      state,
    });

    // …durably: yet another manager sees it cleared.
    const afterReconnect = new OAuthManager(db, clientSecrets, tokens);
    await expect(
      afterReconnect.isOAuthRefreshRejected(service.id),
    ).resolves.toBe(false);
    await expect(afterReconnect.getOAuthAuthState(service.id)).resolves.toEqual({
      authState: 'ok',
    });
  });

  it('retries an invalid_request 4xx with backoff instead of declaring the grant dead', async () => {
    const service = await createGoogleService();
    await tokens.set(
      service.id,
      'expired-access',
      'good-refresh',
      new Date(Date.now() - 60_000).toISOString(),
    );
    const startedAt = Date.now();

    const attempts: number[] = [];
    let n = 0;
    installTokenStub(() => {
      n += 1;
      attempts.push(Date.now());
      if (n <= 2) {
        return jsonResponse(
          {
            error: 'invalid_request',
            error_description: 'Missing required parameter.',
          },
          400,
        );
      }
      return jsonResponse({
        access_token: 'recovered-access',
        refresh_token: 'good-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    });

    const { deps } = startRefresher();
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    await expect(oauthManager.isOAuthRefreshRejected(service.id)).resolves.toBe(
      false,
    );
    await expect(oauthManager.getOAuthAuthState(service.id)).resolves.toEqual({
      authState: 'ok',
    });
    expect(deps.onRefreshRejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(n).toBe(2); // Retried after the 60s base delay — not stopped.
    await expect(oauthManager.isOAuthRefreshRejected(service.id)).resolves.toBe(
      false,
    );

    await vi.advanceTimersByTimeAsync(120_000);
    expect(n).toBe(3);
    expect(attempts).toEqual([
      startedAt,
      startedAt + 60_000,
      startedAt + 180_000,
    ]);
    expect((await tokens.get(service.id))?.accessToken).toBe(
      'recovered-access',
    );
    await expect(oauthManager.getOAuthAuthState(service.id)).resolves.toEqual({
      authState: 'ok',
    });
    expect(deps.invalidateClient).toHaveBeenCalledTimes(1);
    expect(deps.onRefreshRejected).not.toHaveBeenCalled();
  });

  it("registers a 60s unref'd interval and clears it on stop", async () => {
    const service = await createGoogleService();
    await tokens.set(
      service.id,
      'expired-access',
      'refresh-token',
      new Date(Date.now() - 60_000).toISOString(),
    );
    let grants = 0;
    installTokenStub(() => {
      grants += 1;
      return jsonResponse({ access_token: 'a1', expires_in: 3600 });
    });

    const handle = { unref: vi.fn() };
    const clock = {
      now: () => Date.now(),
      setInterval: vi.fn((_cb: () => void, _ms: number) => handle),
      clearInterval: vi.fn(),
    };
    const { stop } = startRefresher({}, { clock });
    await vi.advanceTimersByTimeAsync(0);
    expect(grants).toBe(1); // The startup run does not wait for the interval.
    expect(clock.setInterval).toHaveBeenCalledTimes(1);
    expect(clock.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      OAUTH_BACKGROUND_REFRESH_INTERVAL_MS,
    );
    expect(OAUTH_BACKGROUND_REFRESH_INTERVAL_MS).toBe(60_000);
    expect(handle.unref).toHaveBeenCalledTimes(1);

    stop();
    expect(clock.clearInterval).toHaveBeenCalledTimes(1);
    expect(clock.clearInterval).toHaveBeenCalledWith(handle);
  });
});
