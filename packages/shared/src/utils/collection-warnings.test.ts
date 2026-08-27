import { describe, expect, it } from 'vitest';
import {
  getCredentialWarnings,
  getPlaybookWarnings,
  getServiceWarnings,
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
