import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DatabaseManager } from '../models/database';
import { FileStoreWriter } from '../store/writer';
import { MemorySecretStore } from '../vault/secret-store';
import { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { OAuthTokenVault } from '../vault/oauth-token-vault';
import {
  GOOGLE_OAUTH_AUTHORIZATION_URL,
  GOOGLE_OAUTH_TOKEN_URL,
  healGoogleOAuthConfigForService,
  healMissingGoogleOAuthConfigs,
  isGoogleMcpServiceUrl,
} from './google-oauth-config';
import { OAuthManager } from './oauth-manager';

/**
 * NOT-653: Google cards that already lost their OAuth client config (Connect
 * wrote it to SQLite only; a restart/reindex wiped it) get it back without a
 * human: the Google URLs are filled in and the client ID is borrowed from a
 * sibling Google card whose secret is in this host's vault.
 */
describe('Google OAuth config self-heal', () => {
  let home: string;
  let db: DatabaseManager;
  let secretStore: MemorySecretStore;
  let clientSecrets: OAuthClientSecretVault;
  let tokens: OAuthTokenVault;
  let manager: OAuthManager;
  let storeWriter: FileStoreWriter;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-google-heal-'));
    db = new DatabaseManager(':memory:');
    secretStore = new MemorySecretStore();
    clientSecrets = new OAuthClientSecretVault(secretStore, db);
    tokens = new OAuthTokenVault(secretStore, db);
    storeWriter = new FileStoreWriter(home);
    manager = new OAuthManager(db, clientSecrets, tokens, storeWriter);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    db.close();
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

  async function seedDonor(secret = 'shared-google-secret') {
    const donor = await db.createService({
      name: 'Gmail (personal)',
      type: 'mcp',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      oauthClientId: 'donor-client-id',
      oauthAuthorizationUrl: GOOGLE_OAUTH_AUTHORIZATION_URL,
      oauthTokenUrl: GOOGLE_OAUTH_TOKEN_URL,
      oauthRedirectUri: 'http://127.0.0.1:8000/api/oauth/callback',
      oauthScope: 'gmail',
    });
    await clientSecrets.set(donor.id, secret);
    return donor;
  }

  async function seedStrippedDocsCard() {
    // A Docs card as the 2.6.1 restart left it: no OAuth config in SQLite,
    // but its client secret and tokens still in the vault.
    const docs = await db.createService({
      name: 'Google (personal) (Docs MCP)',
      type: 'mcp',
      url: 'https://docsmcp.googleapis.com/mcp/v1',
    });
    await clientSecrets.set(docs.id, 'docs-own-secret');
    await tokens.set(docs.id, 'stale-access', 'docs-refresh-token');
    return docs;
  }

  it('detects Google MCP hosts by URL suffix', () => {
    expect(isGoogleMcpServiceUrl('https://docsmcp.googleapis.com/mcp/v1')).toBe(true);
    expect(isGoogleMcpServiceUrl('https://gmailmcp.googleapis.com/mcp')).toBe(true);
    expect(isGoogleMcpServiceUrl('https://mcp.linear.app/mcp')).toBe(false);
    expect(isGoogleMcpServiceUrl('https://mcp.slack.com/mcp')).toBe(false);
    expect(isGoogleMcpServiceUrl('not-a-url')).toBe(false);
    expect(isGoogleMcpServiceUrl(null)).toBe(false);
  });

  it('fills URLs + sibling client ID at startup and persists to SQLite and the store file', async () => {
    await seedDonor('docs-own-secret');
    const docs = await seedStrippedDocsCard();

    const result = await healMissingGoogleOAuthConfigs(db, clientSecrets, { storeWriter });

    expect(result.healed).toBe(1);
    expect(result.ids).toEqual([docs.id]);

    const row = await db.getService(docs.id);
    expect(row?.oauthAuthorizationUrl).toBe(GOOGLE_OAUTH_AUTHORIZATION_URL);
    expect(row?.oauthTokenUrl).toBe(GOOGLE_OAUTH_TOKEN_URL);
    expect(row?.oauthClientId).toBe('donor-client-id');

    const raw = await fs.readFile(path.join(home, 'services', `${docs.id}.json`), 'utf8');
    const stored = JSON.parse(raw) as Record<string, unknown>;
    expect(stored.oauthAuthorizationUrl).toBe(GOOGLE_OAUTH_AUTHORIZATION_URL);
    expect(stored.oauthTokenUrl).toBe(GOOGLE_OAUTH_TOKEN_URL);
    expect(stored.oauthClientId).toBe('donor-client-id');
    expect(stored).not.toHaveProperty('oauthClientSecret');
    expect(stored).not.toHaveProperty('oauthAccessToken');
    expect(stored).not.toHaveProperty('oauthRefreshToken');
    expect(raw).not.toContain('docs-own-secret');
    expect(raw).not.toContain('docs-refresh-token');
  });

  it('refreshes with the derived config and no human step', async () => {
    await seedDonor('docs-own-secret');
    const docs = await seedStrippedDocsCard();

    const fetchMock = stubTokenEndpoint('fresh-access');
    expect(await manager.forceRefreshAccessToken(docs.id)).toBe('fresh-access');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('docs-refresh-token');
    expect(body.get('client_id')).toBe('donor-client-id');

    // The lazy heal persisted too, so the next restart keeps working.
    const row = await db.getService(docs.id);
    expect(row?.oauthClientId).toBe('donor-client-id');
    expect(row?.oauthTokenUrl).toBe(GOOGLE_OAUTH_TOKEN_URL);
  });

  it('prefers a donor whose secret matches the card own stored secret', async () => {
    const other = await db.createService({
      name: 'Gmail (personal)',
      type: 'mcp',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      oauthClientId: 'other-client-id',
      oauthAuthorizationUrl: GOOGLE_OAUTH_AUTHORIZATION_URL,
      oauthTokenUrl: GOOGLE_OAUTH_TOKEN_URL,
    });
    await clientSecrets.set(other.id, 'unrelated-secret');
    const same = await db.createService({
      name: 'Google Calendar (personal)',
      type: 'mcp',
      url: 'https://calendarmcp.googleapis.com/mcp/v1',
      oauthClientId: 'matching-client-id',
      oauthAuthorizationUrl: GOOGLE_OAUTH_AUTHORIZATION_URL,
      oauthTokenUrl: GOOGLE_OAUTH_TOKEN_URL,
    });
    await clientSecrets.set(same.id, 'docs-own-secret');
    const docs = await seedStrippedDocsCard();

    await healGoogleOAuthConfigForService(db, clientSecrets, docs.id);

    expect((await db.getService(docs.id))?.oauthClientId).toBe('matching-client-id');
    // The card keeps its own secret — nothing is copied over it.
    expect(await clientSecrets.get(docs.id)).toBe('docs-own-secret');
  });

  it('copies the donor secret vault-to-vault when the card has none of its own', async () => {
    await seedDonor('donor-secret-value');
    const docs = await db.createService({
      name: 'Google (personal) (Docs MCP)',
      type: 'mcp',
      url: 'https://docsmcp.googleapis.com/mcp/v1',
    });
    await tokens.set(docs.id, 'stale-access', 'docs-refresh-token');
    expect(await clientSecrets.get(docs.id)).toBeNull();

    await healGoogleOAuthConfigForService(db, clientSecrets, docs.id, { storeWriter });

    expect((await db.getService(docs.id))?.oauthClientId).toBe('donor-client-id');
    expect(await clientSecrets.get(docs.id)).toBe('donor-secret-value');

    const fetchMock = stubTokenEndpoint('fresh-access');
    expect(await manager.forceRefreshAccessToken(docs.id)).toBe('fresh-access');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get('client_id')).toBe('donor-client-id');
    expect(body.get('client_secret')).toBe('donor-secret-value');
  });

  it('pairs a borrowed client ID with the donor secret when the target secret mismatches', async () => {
    await seedDonor('donor-secret-value');
    // Target holds its own unrelated secret (seedStrippedDocsCard uses
    // 'docs-own-secret'): no donor matches it.
    const docs = await seedStrippedDocsCard();
    expect(await clientSecrets.get(docs.id)).toBe('docs-own-secret');

    await healGoogleOAuthConfigForService(db, clientSecrets, docs.id, { storeWriter });

    expect((await db.getService(docs.id))?.oauthClientId).toBe('donor-client-id');
    // The borrowed ID must pair with the donor's secret, not the unrelated
    // existing secret, or Google rejects the refresh.
    expect(await clientSecrets.get(docs.id)).toBe('donor-secret-value');

    const fetchMock = stubTokenEndpoint('fresh-access');
    expect(await manager.forceRefreshAccessToken(docs.id)).toBe('fresh-access');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('donor-client-id');
    expect(body.get('client_secret')).toBe('donor-secret-value');
  });

  it('leaves non-Google cards alone: no derived config', async () => {
    const linear = await db.createService({
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
    });
    const slack = await db.createService({
      name: 'Slack',
      type: 'mcp',
      url: 'https://mcp.slack.com/mcp',
      oauthClientId: 'slack-client',
      oauthAuthorizationUrl: 'https://slack.com/oauth/v2/authorize',
      oauthTokenUrl: 'https://slack.com/api/oauth.v2.access',
    });

    const result = await healMissingGoogleOAuthConfigs(db, clientSecrets, { storeWriter });

    expect(result.healed).toBe(0);
    expect(await db.getService(linear.id)).toMatchObject({
      oauthClientId: null,
      oauthAuthorizationUrl: null,
      oauthTokenUrl: null,
    });
    expect(await db.getService(slack.id)).toMatchObject({
      oauthClientId: 'slack-client',
    });
    await expect(fs.access(path.join(home, 'services', `${linear.id}.json`))).rejects.toThrow();
  });

  it('does not touch a Google card that already has its config', async () => {
    const donor = await seedDonor();
    const result = await healGoogleOAuthConfigForService(db, clientSecrets, donor.id, { storeWriter });
    expect(result.healed).toBe(false);
    await expect(fs.access(path.join(home, 'services', `${donor.id}.json`))).rejects.toThrow();
  });

  it('still heals the URLs when no sibling donor exists', async () => {
    const docs = await seedStrippedDocsCard();

    const result = await healGoogleOAuthConfigForService(db, clientSecrets, docs.id);

    expect(result.healed).toBe(true);
    const row = await db.getService(docs.id);
    expect(row?.oauthAuthorizationUrl).toBe(GOOGLE_OAUTH_AUTHORIZATION_URL);
    expect(row?.oauthTokenUrl).toBe(GOOGLE_OAUTH_TOKEN_URL);
    expect(row?.oauthClientId).toBeFalsy();
  });
});
