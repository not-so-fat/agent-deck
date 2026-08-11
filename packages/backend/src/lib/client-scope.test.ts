import { describe, it, expect } from 'vitest';
import { applyDeckCredentialScope, sanitizeServiceForAgent } from './client-scope';
import { Deck, Service } from '@agent-deck/shared';

const baseDeck = (overrides: Partial<Deck>): Deck => ({
  id: 'deck-1',
  name: 'Test',
  isActive: false,
  services: [],
  credentials: [{ id: 'cred_a' } as Deck['credentials'][number]],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('applyDeckCredentialScope', () => {
  it('keeps credentials for dashboard clients', () => {
    const deck = baseDeck({ isActive: false });
    expect(applyDeckCredentialScope(deck, 'dashboard').credentials).toHaveLength(1);
  });

  it('keeps credentials only for the bound deck id for agent clients', () => {
    const bound = baseDeck({ id: 'deck-bound', isActive: false });
    const other = baseDeck({ id: 'deck-other', isActive: true });

    expect(applyDeckCredentialScope(bound, 'agent', 'deck-bound').credentials).toHaveLength(1);
    expect(applyDeckCredentialScope(other, 'agent', 'deck-bound').credentials).toHaveLength(0);
  });
});

describe('sanitizeServiceForAgent', () => {
  it('strips OAuth tokens, secrets, and Authorization headers', () => {
    const service: Service = {
      id: 'svc-1',
      name: 'Slack',
      type: 'mcp',
      url: 'https://example.com/mcp',
      health: 'healthy',
      cardColor: '#000',
      isConnected: true,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      oauthClientSecret: 'secret',
      oauthAccessToken: 'gho_token',
      oauthRefreshToken: 'refresh',
      oauthState: 'state',
      headers: { Authorization: 'Bearer token', 'X-Custom': 'ok' },
      localEnv: { API_KEY: 'abc' },
    };

    const sanitized = sanitizeServiceForAgent(service);
    expect(sanitized.oauthClientSecret).toBeUndefined();
    expect(sanitized.oauthAccessToken).toBeUndefined();
    expect(sanitized.oauthRefreshToken).toBeUndefined();
    expect(sanitized.oauthState).toBeUndefined();
    expect(sanitized.localEnv).toBeUndefined();
    expect(sanitized.headers).toEqual({ 'X-Custom': 'ok' });
  });

  it('strips common API-key style headers', () => {
    const service: Service = {
      id: 'svc-2',
      name: 'API',
      type: 'mcp',
      url: 'https://example.com/mcp',
      health: 'healthy',
      cardColor: '#000',
      isConnected: true,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      headers: { 'X-Api-Key': 'secret', 'X-Trace': 'ok' },
    };

    const sanitized = sanitizeServiceForAgent(service);
    expect(sanitized.headers).toEqual({ 'X-Trace': 'ok' });
  });

  it('strips every header the vault treats as secret (same classifier)', () => {
    // These are secret to splitSecretHeaders/the git store; the agent strip must
    // classify them identically or the read-merge would leak them to agents.
    const service: Service = {
      id: 'svc-3',
      name: 'API',
      type: 'mcp',
      url: 'https://example.com/mcp',
      health: 'healthy',
      cardColor: '#000',
      isConnected: true,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      headers: {
        Cookie: 'session=xyz',
        'Proxy-Authorization': 'Basic abc',
        'X-Secret-Key': 'k',
        'My-Access-Token': 'heuristic-match',
        'X-Tenant': 'acme',
      },
    };

    expect(sanitizeServiceForAgent(service).headers).toEqual({ 'X-Tenant': 'acme' });
  });
});
