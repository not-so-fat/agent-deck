import { describe, expect, it } from 'vitest';
import type { Service } from '@agent-deck/shared';
import {
  FORBIDDEN_EXPORT_SERVICE_KEYS,
  sanitizeServiceForExport,
  serviceNeedsOauthReconnect,
} from './sanitize-for-export';

function baseService(overrides: Partial<Service> = {}): Service {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Linear',
    type: 'mcp',
    url: 'https://mcp.linear.app/mcp',
    health: 'healthy',
    description: 'Linear MCP',
    cardColor: '#92E4DD',
    isConnected: true,
    lastPing: '2026-07-03T00:00:00.000Z',
    registeredAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z',
    disabledToolNames: ['secret_tool'],
    headers: {
      Authorization: 'Bearer token',
      'X-Custom': 'ok',
    },
    credentialId: 'cred_linear',
    oauthClientId: 'client',
    oauthClientSecret: 'secret',
    oauthAuthorizationUrl: 'https://example.com/oauth/authorize',
    oauthTokenUrl: 'https://example.com/oauth/token',
    oauthRedirectUri: 'https://example.com/callback',
    oauthScope: 'read',
    oauthAccessToken: 'access',
    oauthRefreshToken: 'refresh',
    oauthTokenExpiresAt: '2026-07-04T00:00:00.000Z',
    oauthHasToken: true,
    oauthState: 'state',
    localCommand: 'npx',
    localArgs: ['-y', 'server'],
    localWorkingDir: '/tmp',
    localEnv: { API_KEY: 'abc' },
    ...overrides,
  };
}

describe('sanitizeServiceForExport', () => {
  it('strips secrets and runtime fields', () => {
    const exported = sanitizeServiceForExport(baseService());
    for (const key of FORBIDDEN_EXPORT_SERVICE_KEYS) {
      expect(exported).not.toHaveProperty(key);
    }
    expect(exported).not.toHaveProperty('credentialId');
    expect(exported.headers).toEqual({ 'X-Custom': 'ok' });
    expect(exported.headers).not.toHaveProperty('Authorization');
  });

  it('strips X-API-Key and similar secret headers', () => {
    const exported = sanitizeServiceForExport(
      baseService({
        headers: {
          Authorization: 'Bearer token',
          'X-API-Key': 'secret',
          'X-Custom': 'ok',
        },
      }),
    );
    expect(exported.headers).toEqual({ 'X-Custom': 'ok' });
  });

  it('keeps public config', () => {
    const exported = sanitizeServiceForExport(baseService());
    expect(exported).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Linear',
      type: 'mcp',
      url: 'https://mcp.linear.app/mcp',
      description: 'Linear MCP',
      cardColor: '#92E4DD',
      disabledToolNames: ['secret_tool'],
      oauthClientId: 'client',
      oauthAuthorizationUrl: 'https://example.com/oauth/authorize',
      oauthTokenUrl: 'https://example.com/oauth/token',
      localCommand: 'npx',
      localArgs: ['-y', 'server'],
      localWorkingDir: '/tmp',
    });
  });

  it('flags services that need OAuth reconnect', () => {
    expect(serviceNeedsOauthReconnect(sanitizeServiceForExport(baseService()))).toBe(
      true,
    );
    expect(
      serviceNeedsOauthReconnect(
        sanitizeServiceForExport(
          baseService({
            oauthClientId: undefined,
            oauthAuthorizationUrl: undefined,
            oauthTokenUrl: undefined,
          }),
        ),
      ),
    ).toBe(false);
  });
});
