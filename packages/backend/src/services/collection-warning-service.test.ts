import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseManager } from '../models/database';
import { OAuthManager } from './oauth-manager';
import { CollectionWarningService } from './collection-warning-service';
import { MemorySecretStore } from '../vault/secret-store';
import { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { OAuthTokenVault } from '../vault/oauth-token-vault';

/**
 * NOT-655: the collection warnings for Google OAuth cards come from the
 * server `authState` (NOT-654) — the same state the details modal reads — so
 * the card face and the modal can never disagree. Non-Google cards keep the
 * pre-NOT-655 legacy behavior untouched.
 */
describe('CollectionWarningService', () => {
  let db: DatabaseManager;
  let oauthManager: OAuthManager;
  let tokens: OAuthTokenVault;
  let warnings: CollectionWarningService;

  beforeEach(() => {
    db = new DatabaseManager(':memory:');
    const secretStore = new MemorySecretStore();
    const clientSecrets = new OAuthClientSecretVault(secretStore, db);
    tokens = new OAuthTokenVault(secretStore, db);
    oauthManager = new OAuthManager(db, clientSecrets, tokens);
    warnings = new CollectionWarningService(oauthManager);
    // Never hit the network: the probe only runs for config-less cards, and
    // each test below pins its answer explicitly.
    stubDiscovery(warnings, false);
  });

  function stubDiscovery(
    service: CollectionWarningService,
    required: boolean,
  ): void {
    (service as unknown as { discoveryService: unknown }).discoveryService =
      {
        discoverService: async () => ({ oauth: { required } }),
      };
  }

  async function createGoogleService(name = 'Gmail') {
    return db.createService({
      name,
      type: 'mcp',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      oauthClientId: 'google-client',
      oauthAuthorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      oauthTokenUrl: 'https://oauth2.googleapis.com/token',
      oauthRedirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
      oauthScope: 'https://www.googleapis.com/auth/gmail.readonly',
    });
  }

  async function createLinearService() {
    return db.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
      oauthClientId: 'linear-client',
      oauthAuthorizationUrl: 'https://linear.app/oauth/authorize',
      oauthTokenUrl: 'https://api.linear.app/oauth/token',
      oauthRedirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
      oauthScope: 'read write',
    });
  }

  async function createSlackService() {
    return db.createService({
      name: 'Slack',
      type: 'mcp',
      url: 'https://slack-mcp.example.com/mcp',
      oauthClientId: 'slack-client',
      oauthAuthorizationUrl: 'https://slack.com/oauth/v2/authorize',
      oauthTokenUrl: 'https://slack.com/api/oauth.v2.access',
      oauthRedirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
      oauthScope: 'channels:read chat:write',
    });
  }

  it('emits oauth_expired for a Google card whose authState is needs_reconnect', async () => {
    const google = await createGoogleService();
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(google.id, 'expired-access', undefined, pastExpiry);

    const payload = await warnings.summarize([google], [], []);

    expect(payload.services[google.id]?.map((w) => w.kind)).toEqual([
      'oauth_expired',
    ]);
    expect(payload.byKind.oauth_expired).toBe(1);
    expect(payload.total).toBe(1);
  });

  it('emits no warning for an expired-but-refreshable token (authState ok)', async () => {
    const google = await createGoogleService();
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(google.id, 'expired-access', 'live-refresh', pastExpiry);
    // Production passes fresh rows (the vault flips oauth_has_token on the
    // row when tokens land), so re-read before summarizing.
    const fresh = (await db.getAllServices()).find((s) => s.id === google.id)!;

    const payload = await warnings.summarize([fresh], [], []);

    expect(payload.services[google.id]).toBeUndefined();
    expect(payload.byKind.oauth_expired).toBe(0);
    expect(payload.total).toBe(0);
  });

  it('emits no warning for a fresh token', async () => {
    const google = await createGoogleService();
    const futureExpiry = new Date(Date.now() + 3_600_000).toISOString();
    await tokens.set(google.id, 'fresh-access', 'fresh-refresh', futureExpiry);
    const fresh = (await db.getAllServices()).find((s) => s.id === google.id)!;

    const payload = await warnings.summarize([fresh], [], []);

    expect(payload.services[google.id]).toBeUndefined();
    expect(payload.total).toBe(0);
  });

  it('keeps oauth_required for a config-less card the probe says needs OAuth', async () => {
    stubDiscovery(warnings, true);
    const bare = await db.createService({
      name: 'GitHub',
      type: 'mcp',
      url: 'https://api.githubcopilot.com/mcp/',
    });

    const payload = await warnings.summarize([bare], [], []);

    expect(payload.services[bare.id]?.map((w) => w.kind)).toEqual([
      'oauth_required',
    ]);
    expect(payload.byKind.oauth_required).toBe(1);
  });

  it('emits no warning for a non-OAuth card', async () => {
    const plain = await db.createService({
      name: 'Plain',
      type: 'mcp',
      url: 'https://mcp.example.com/mcp',
    });

    const payload = await warnings.summarize([plain], [], []);

    expect(payload.services[plain.id]).toBeUndefined();
    expect(payload.total).toBe(0);
  });

  it('round 2: keeps oauth_required (not expired) for a first-time Linear card', async () => {
    const authSpy = vi.spyOn(oauthManager, 'getOAuthAuthState');
    const linear = await createLinearService();

    const payload = await warnings.summarize([linear], [], []);

    expect(payload.services[linear.id]?.map((w) => w.kind)).toEqual([
      'oauth_required',
    ]);
    expect(payload.byKind.oauth_required).toBe(1);
    expect(payload.byKind.oauth_expired).toBe(0);
    // Non-Google cards never consult the server auth state.
    expect(authSpy).not.toHaveBeenCalled();
  });

  it('round 2: keeps oauth_required (not expired) for a first-time Slack card', async () => {
    const slack = await createSlackService();

    const payload = await warnings.summarize([slack], [], []);

    expect(payload.services[slack.id]?.map((w) => w.kind)).toEqual([
      'oauth_required',
    ]);
    expect(payload.byKind.oauth_required).toBe(1);
    expect(payload.byKind.oauth_expired).toBe(0);
  });

  it('round 2: non-Google legacy still honors the vault refresh-token bit', async () => {
    // Expired access token WITH a refresh token: no warning (renews silently).
    const refreshable = await createLinearService();
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(refreshable.id, 'expired-access', 'live-refresh', pastExpiry);
    const freshRefreshable = (await db.getAllServices()).find(
      (s) => s.id === refreshable.id,
    )!;

    const okPayload = await warnings.summarize([freshRefreshable], [], []);
    expect(okPayload.services[refreshable.id]).toBeUndefined();

    // Expired access token WITHOUT a refresh token: legacy oauth_expired.
    const dead = await createSlackService();
    await tokens.set(dead.id, 'expired-access', undefined, pastExpiry);
    const freshDead = (await db.getAllServices()).find(
      (s) => s.id === dead.id,
    )!;

    const deadPayload = await warnings.summarize([freshDead], [], []);
    expect(deadPayload.services[dead.id]?.map((w) => w.kind)).toEqual([
      'oauth_expired',
    ]);
  });

  it('round 3: a failed auth-state read keeps the stored-field warning (expired, no refresh token)', async () => {
    const google = await createGoogleService();
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(google.id, 'expired-access', undefined, pastExpiry);
    const fresh = (await db.getAllServices()).find((s) => s.id === google.id)!;
    vi.spyOn(oauthManager, 'getOAuthAuthState').mockRejectedValueOnce(
      new Error('vault unavailable'),
    );

    const payload = await warnings.summarize([fresh], [], []);

    // A transient read failure falls back to the previous stored-field +
    // vault computation — the existing warning does not blink out.
    expect(payload.services[google.id]?.map((w) => w.kind)).toEqual([
      'oauth_expired',
    ]);
    expect(payload.byKind.oauth_expired).toBe(1);
    expect(payload.total).toBe(1);
  });

  it('round 3: a failed auth-state read still honors the vault refresh-token bit', async () => {
    const google = await createGoogleService();
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    await tokens.set(google.id, 'expired-access', 'live-refresh', pastExpiry);
    const fresh = (await db.getAllServices()).find((s) => s.id === google.id)!;
    vi.spyOn(oauthManager, 'getOAuthAuthState').mockRejectedValueOnce(
      new Error('vault unavailable'),
    );

    const payload = await warnings.summarize([fresh], [], []);

    // Expired access token WITH a refresh token: the fallback sees the vault
    // bit and stays silent, exactly like the pre-NOT-655 computation.
    expect(payload.services[google.id]).toBeUndefined();
    expect(payload.byKind.oauth_expired).toBe(0);
    expect(payload.total).toBe(0);
  });
});
