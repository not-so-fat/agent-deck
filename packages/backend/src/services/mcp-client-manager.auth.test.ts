import { describe, expect, it, vi } from 'vitest';
import type { Service } from '@agent-deck/shared';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { MCPClientManager } from './mcp-client-manager';
import { ServiceManager } from './service-manager';
import type { DatabaseManager } from '../models/database';
import type { OAuthManager } from './oauth-manager';
import type { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';

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

  it('rebuilds the cached client with a refreshed token through the retry path, ending healthy', async () => {
    // NOT-511: the cached client holds the expired token in its connect-time
    // Authorization header, so the operation on that cached client fails; the
    // ServiceManager retry drops the cache, the rebuilt client re-resolves
    // the token (refresh), and the service ends healthy without any
    // dashboard request.
    const resolveAccessToken = vi.fn(
      async (): Promise<string | null> => 'expired-token',
    );
    resolveAccessToken.mockResolvedValueOnce('expired-token');
    resolveAccessToken.mockResolvedValueOnce('refreshed-token');
    const manager = new MCPClientManager(resolveAccessToken);
    const service = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Linear',
      type: 'mcp',
      url: 'https://linear.example.com/mcp',
      health: 'unknown',
      cardColor: '#92E4DD',
      disabledToolNames: [],
      isConnected: false,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      oauthClientId: 'linear-client',
      oauthHasToken: true,
    } as Service;

    // Avoid the network: the first connection caches a client bound to the
    // expired token and fails on the operation; the rebuilt client connects
    // with the refreshed token and succeeds.
    const seenAuthorizations: (string | undefined)[] = [];
    const connector = manager as unknown as {
      connectRemoteClient: (
        baseUrl: URL,
        headers: Record<string, string>,
        serviceUrl: string,
      ) => Promise<Client>;
    };
    const connectSpy = vi
      .spyOn(connector, 'connectRemoteClient')
      .mockImplementation(async (_baseUrl, headers) => {
        seenAuthorizations.push(headers.Authorization);
        if (seenAuthorizations.length === 1) {
          return {
            listTools: async () => {
              throw new Error('401 Unauthorized: token expired');
            },
            close: async () => undefined,
          } as unknown as Client;
        }
        return {
          listTools: async () => ({
            tools: [
              {
                name: 'list_issues',
                description: 'List issues',
                inputSchema: { type: 'object' },
              },
            ],
          }),
          close: async () => undefined,
        } as unknown as Client;
      });

    const updateServiceStatus = vi.fn().mockResolvedValue(undefined);
    const db = {
      getService: vi.fn().mockResolvedValue(service),
      updateServiceStatus,
    } as unknown as DatabaseManager;
    const serviceManager = new ServiceManager(
      db,
      manager,
      {} as unknown as OAuthManager,
      {} as unknown as OAuthClientSecretVault,
    );

    const result = await serviceManager.discoverServiceTools(service.id);

    expect(result).toEqual([
      {
        name: 'list_issues',
        description: 'List issues',
        inputSchema: { type: 'object' },
        enabled: true,
      },
    ]);
    // The retry dropped the cached client, so the client was rebuilt and the
    // resolver ran a second time, yielding the refreshed token.
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(resolveAccessToken).toHaveBeenCalledTimes(2);
    expect(resolveAccessToken).toHaveBeenNthCalledWith(1, service.id);
    expect(resolveAccessToken).toHaveBeenNthCalledWith(2, service.id);
    expect(seenAuthorizations).toEqual([
      'Bearer expired-token',
      'Bearer refreshed-token',
    ]);
    expect(updateServiceStatus).toHaveBeenCalledWith(service.id, true, 'healthy');
    expect(updateServiceStatus).not.toHaveBeenCalledWith(
      service.id,
      false,
      'unhealthy',
    );
  });
});
