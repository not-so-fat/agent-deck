import { describe, expect, it } from 'vitest';
import type { Service } from '@agent-deck/shared';
import {
  parseServiceJson,
  serializeService,
  storeServiceFromDb,
} from './service-codec';

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
    localEnv: { API_KEY: 'abc' },
    ...overrides,
  };
}

describe('service-codec', () => {
  it('round-trips sanitized service JSON', () => {
    const input = storeServiceFromDb(baseService());
    const raw = serializeService(input);
    expect(raw.endsWith('\n')).toBe(true);
    expect(parseServiceJson(raw)).toEqual(input);
    expect(raw).not.toContain('localEnv');
    expect(raw).not.toContain('Authorization');
  });

  it('strips Authorization header on parse', () => {
    const raw = JSON.stringify(
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Linear',
        type: 'mcp',
        url: 'https://mcp.linear.app/mcp',
        disabledToolNames: [],
        headers: {
          Authorization: 'Bearer secret',
          'X-Custom': 'ok',
        },
      },
      null,
      2,
    );
    const parsed = parseServiceJson(raw);
    expect(parsed.headers).toEqual({ 'X-Custom': 'ok' });
    expect(parsed.headers).not.toHaveProperty('Authorization');
  });

  it('storeServiceFromDb strips secrets and keeps local credentialId', () => {
    const store = storeServiceFromDb(baseService());
    expect(store).not.toHaveProperty('localEnv');
    expect(store.credentialId).toBe('cred_linear');
    expect(store.headers).toEqual({ 'X-Custom': 'ok' });
  });

  it('strips X-API-Key style headers on parse', () => {
    const raw = JSON.stringify(
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Linear',
        type: 'mcp',
        url: 'https://mcp.linear.app/mcp',
        disabledToolNames: [],
        headers: {
          'X-API-Key': 'secret',
          'X-Custom': 'ok',
        },
      },
      null,
      2,
    );
    const parsed = parseServiceJson(raw);
    expect(parsed.headers).toEqual({ 'X-Custom': 'ok' });
  });
});
