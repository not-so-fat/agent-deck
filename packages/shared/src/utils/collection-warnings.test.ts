import { describe, expect, it } from 'vitest';
import {
  getCredentialWarnings,
  getPlaybookWarnings,
  getServiceWarnings,
  OAUTH_EXPIRED_MESSAGE,
  summarizeCollectionWarnings,
} from './collection-warnings';

const baseService = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Notion',
  type: 'mcp' as const,
  url: 'https://mcp.example.com',
  health: 'unknown' as const,
  cardColor: '#92E4DD',
  isConnected: false,
  registeredAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('collection-warnings', () => {
  it('flags oauth required when live discovery says OAuth is required', () => {
    const warnings = getServiceWarnings(
      {
        ...baseService,
        name: 'GitHub',
        url: 'https://api.githubcopilot.com/mcp/',
      },
      { oauthRequired: true },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('oauth_required');
  });

  it('detects oauth via authorization URL without client id', () => {
    const warnings = getServiceWarnings({
      ...baseService,
      oauthAuthorizationUrl: 'https://github.com/login/oauth/authorize',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('oauth_required');
  });

  it('flags oauth required and expired MCP services', () => {
    const required = getServiceWarnings({
      ...baseService,
      oauthClientId: 'client',
    });

    expect(required).toHaveLength(1);
    expect(required[0].kind).toBe('oauth_required');

    const tokenOnly = getServiceWarnings({
      ...baseService,
      id: '33333333-3333-3333-3333-333333333333',
      oauthClientId: 'client',
      oauthAccessToken: 'token',
    });
    expect(tokenOnly).toHaveLength(0);

    const expired = getServiceWarnings({
      ...baseService,
      id: '22222222-2222-2222-2222-222222222222',
      oauthClientId: 'client',
      oauthAccessToken: 'token',
      oauthTokenExpiresAt: '2020-01-01T00:00:00.000Z',
    });

    expect(expired.some((warning) => warning.kind === 'oauth_expired')).toBe(true);
  });

  it('does not flag oauth expired when refresh token can renew access', () => {
    const refreshable = getServiceWarnings(
      {
        ...baseService,
        id: '44444444-4444-4444-4444-444444444444',
        oauthClientId: 'client',
        oauthAccessToken: 'token',
        oauthTokenExpiresAt: '2020-01-01T00:00:00.000Z',
      },
      { hasRefreshToken: true },
    );

    expect(refreshable.some((warning) => warning.kind === 'oauth_expired')).toBe(false);
  });

  it('NOT-655: emits oauth_expired exactly when authState is needs_reconnect', () => {
    const googleCard = {
      ...baseService,
      id: '55555555-5555-5555-5555-555555555555',
      name: 'Gmail',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      oauthClientId: 'google-client',
      oauthAccessToken: 'token',
      oauthTokenExpiresAt: '2020-01-01T00:00:00.000Z',
    };

    const expired = getServiceWarnings(googleCard, {
      authState: 'needs_reconnect',
    });
    expect(expired).toHaveLength(1);
    expect(expired[0].kind).toBe('oauth_expired');
    expect(expired[0].message).toBe(OAUTH_EXPIRED_MESSAGE);
    expect(expired[0].severity).toBe('error');

    // Fresh-looking stored fields do not override the server truth.
    const staleHealthy = getServiceWarnings(
      { ...googleCard, oauthTokenExpiresAt: '2030-01-01T00:00:00.000Z' },
      { authState: 'needs_reconnect' },
    );
    expect(
      staleHealthy.some((warning) => warning.kind === 'oauth_expired'),
    ).toBe(true);
  });

  it('NOT-655: expired-but-refreshable token with authState ok gets no warning', () => {
    const warnings = getServiceWarnings(
      {
        ...baseService,
        id: '66666666-6666-6666-6666-666666666666',
        name: 'Gmail',
        url: 'https://gmailmcp.googleapis.com/mcp/v1',
        oauthClientId: 'google-client',
        oauthAccessToken: 'token',
        oauthTokenExpiresAt: '2020-01-01T00:00:00.000Z',
      },
      { authState: 'ok' },
    );

    expect(warnings).toHaveLength(0);
  });

  it('NOT-655: authState ok still warns oauth_required for a probed card with no token', () => {
    const warnings = getServiceWarnings(
      {
        ...baseService,
        id: '77777777-7777-7777-7777-777777777777',
        name: 'GitHub',
        url: 'https://api.githubcopilot.com/mcp/',
      },
      { authState: 'ok', oauthRequired: true },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe('oauth_required');
  });

  it('NOT-655: unhealthy needs_reconnect card reports unhealthy without the OAuth-OK hint', () => {
    const warnings = getServiceWarnings(
      {
        ...baseService,
        id: '88888888-8888-8888-8888-888888888888',
        health: 'unhealthy' as const,
        oauthClientId: 'client',
        oauthAccessToken: 'token',
        oauthTokenExpiresAt: '2030-01-01T00:00:00.000Z',
      },
      { authState: 'needs_reconnect' },
    );

    expect(warnings.map((warning) => warning.kind)).toEqual([
      'service_unhealthy',
      'oauth_expired',
    ]);
    expect(warnings[0].message).toBe('Service reported unhealthy');
  });

  it('flags missing credential secrets and playbook dependencies', () => {
    expect(
      getCredentialWarnings({
        id: 'cred_openai',
        label: 'OpenAI',
        scheme: 'bearer',
        envName: 'OPENAI_API_KEY',
        keychainAccount: 'cred_openai',
        tags: [],
        hasSecret: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toHaveLength(1);

    expect(
      getPlaybookWarnings(
        {
          id: 'pb_hiring_inbox',
          title: 'Hiring inbox',
          body: 'Steps',
          triggers: [],
          dependsOnCredentialIds: ['cred_missing'],
          dependsOnServiceIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        { credentialIds: new Set(['cred_openai']), serviceIds: new Set() },
      ),
    ).toHaveLength(1);
  });

  it('summarizes warnings across card types', () => {
    const summary = summarizeCollectionWarnings(
      [{ ...baseService, oauthClientId: 'client' }],
      [
        {
          id: 'cred_openai',
          label: 'OpenAI',
          scheme: 'bearer',
          envName: 'OPENAI_API_KEY',
          keychainAccount: 'cred_openai',
          tags: [],
          hasSecret: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      [
        {
          id: 'pb_hiring_inbox',
          title: 'Hiring inbox',
          body: 'Steps',
          triggers: [],
          dependsOnCredentialIds: ['cred_missing'],
          dependsOnServiceIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    );

    expect(summary.total).toBe(3);
    expect(summary.byKind.oauth_required).toBe(1);
    expect(summary.byKind.credential_missing_secret).toBe(1);
    expect(summary.byKind.playbook_missing_deps).toBe(1);
  });
});
