import { describe, expect, it, vi } from 'vitest';
import type { Service } from '@agent-deck/shared';

import { MCPClientManager } from './mcp-client-manager';

describe('MCPClientManager auth headers', () => {
  it('preserves Authorization from service headers when OAuth token is absent', async () => {
    const manager = new MCPClientManager(async () => null);
    const buildHeaders = (manager as unknown as {
      buildRequestHeaders: (service: Service) => Promise<Record<string, string>>;
    }).buildRequestHeaders.bind(manager);

    const headers = await buildHeaders({
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Docmost',
      type: 'mcp',
      url: 'https://docmost.example.com/mcp',
      health: 'unknown',
      cardColor: '#92E4DD',
      disabledToolNames: [],
      isConnected: false,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      headers: { Authorization: 'Bearer docmost-jwt' },
    });

    expect(headers.Authorization).toBe('Bearer docmost-jwt');
  });

  it('resolves the access token again when the client is rebuilt after invalidate', async () => {
    // NOT-511: the retry in ServiceManager drops the cached client and the
    // rebuilt client must re-resolve the token, so an expired cached token is
    // replaced by a refreshed one without any dashboard request.
    const resolveAccessToken = vi.fn(async () => 'expired-token');
    const manager = new MCPClientManager(resolveAccessToken);
    const service = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Linear',
      type: 'mcp',
      url: 'http://127.0.0.1:1/mcp',
      health: 'unknown',
      cardColor: '#92E4DD',
      disabledToolNames: [],
      isConnected: false,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Service;

    await expect(manager.discoverTools(service)).rejects.toThrow();
    manager.invalidateClient(service.id);
    await expect(manager.discoverTools(service)).rejects.toThrow();

    expect(resolveAccessToken).toHaveBeenCalledTimes(2);
    expect(resolveAccessToken).toHaveBeenNthCalledWith(1, service.id);
    expect(resolveAccessToken).toHaveBeenNthCalledWith(2, service.id);
  });
});
