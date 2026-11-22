import { beforeEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../models/database';
import { OAuthManager } from './oauth-manager';
import { CollectionWarningService } from './collection-warning-service';
import { MemorySecretStore } from '../vault/secret-store';
import { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { OAuthTokenVault } from '../vault/oauth-token-vault';

/**
 * NOT-655: the collection warnings for OAuth cards come from the server
 * `authState` (NOT-654) — the same state the details modal reads — so the
 * card face and the modal can never disagree.
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
});
