import http from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '@agent-deck/shared';

import { MCPClientManager } from './mcp-client-manager';
import { ServiceManager } from './service-manager';
import { McpOAuthRejectedError } from '../lib/mcp-connection-error';
import type { DatabaseManager } from '../models/database';
import type { OAuthManager } from './oauth-manager';
import type { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';

/**
 * NOT-639: when the remote MCP server answers `401 invalid_token`, the client
 * refreshes the OAuth token once and retries once; a second rejection is an
 * auth error, never a loop.
 */

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** Streamable HTTP MCP server that only accepts bearer tokens in `accepted`. */
function createTokenCheckingServer(accepted: Set<string>) {
  const seen: string[] = [];
  const toolCalls: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const body = await readJsonBody(req);
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    seen.push(`${body.method}:${token}`);

    if (!accepted.has(token)) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer error="invalid_token", error_description="Invalid access token"',
      });
      res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Invalid access token' }));
      return;
    }

    if (body.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mock-session' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-oauth', version: '1.0.0' },
        },
      }));
      return;
    }
    if (body.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (body.method === 'tools/call') {
      toolCalls.push(token);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: `issues for ${token}` }] },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, seen, toolCalls };
}

function oauthService(url: string, overrides: Partial<Service> = {}): Service {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Linear',
    type: 'mcp',
    url,
    health: 'unknown',
    cardColor: '#92E4DD',
    disabledToolNames: [],
    isConnected: false,
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    oauthClientId: 'linear-client',
    oauthTokenUrl: 'https://mcp.linear.app/token',
    oauthHasToken: true,
    ...overrides,
  } as Service;
}

describe('MCPClientManager OAuth refresh on 401', () => {
  const servers: http.Server[] = [];
  const managers: MCPClientManager[] = [];

  async function listen(accepted: Set<string>) {
    const fixture = createTokenCheckingServer(accepted);
    servers.push(fixture.server);
    await new Promise<void>((resolve) => fixture.server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = fixture.server.address() as AddressInfo;
    return { ...fixture, url: `http://127.0.0.1:${port}/mcp` };
  }

  function track(manager: MCPClientManager): MCPClientManager {
    managers.push(manager);
    return manager;
  }

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.cleanup()));
    await Promise.all(servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ));
  });

  it('refreshes once and retries once when the first token is rejected, then succeeds', async () => {
    const fake = await listen(new Set(['fresh-token']));
    const resolve = vi.fn(async () => 'expired-token');
    const refresh = vi.fn(async () => 'fresh-token');
    const manager = track(new MCPClientManager(resolve, refresh));

    const result = await manager.callTool(oauthService(fake.url), 'list_issues', {});

    expect(result).toEqual({ content: [{ type: 'text', text: 'issues for fresh-token' }] });
    expect(refresh).toHaveBeenCalledOnce();
    expect(fake.seen[0]).toBe('initialize:expired-token');
    expect(fake.seen.filter((entry) => entry.endsWith(':expired-token'))).toHaveLength(1);
    expect(fake.toolCalls).toEqual(['fresh-token']);
  });

  it('refreshes when a cached client\'s token expires between calls', async () => {
    const accepted = new Set(['token-a']);
    const fake = await listen(accepted);
    const refresh = vi.fn(async () => 'token-b');
    const manager = track(new MCPClientManager(async () => 'token-a', refresh));
    const service = oauthService(fake.url);

    await manager.callTool(service, 'list_issues', {});
    // The access token expires on the server; the cached client still carries it.
    accepted.delete('token-a');
    accepted.add('token-b');

    const result = await manager.callTool(service, 'list_issues', {});
    expect(result).toEqual({ content: [{ type: 'text', text: 'issues for token-b' }] });
    expect(refresh).toHaveBeenCalledOnce();
    expect(fake.toolCalls).toEqual(['token-a', 'token-b']);
  });

  it('returns a second rejection as an auth error without looping', async () => {
    const fake = await listen(new Set());
    const refresh = vi.fn(async () => 'also-rejected');
    const manager = track(new MCPClientManager(async () => 'expired-token', refresh));

    const error = await manager
      .callTool(oauthService(fake.url), 'list_issues', {})
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(McpOAuthRejectedError);
    expect((error as McpOAuthRejectedError).needsReconnect).toBe(false);
    expect((error as Error).message).toMatch(/Unauthorized/);
    expect(refresh).toHaveBeenCalledOnce();
    expect(fake.seen.filter((entry) => entry.startsWith('initialize:'))).toEqual([
      'initialize:expired-token',
      'initialize:also-rejected',
    ]);
  });

  it('reports the card as needing reconnect when the refresh fails', async () => {
    const fake = await listen(new Set());
    const refresh = vi.fn(async () => null);
    const manager = track(new MCPClientManager(async () => 'expired-token', refresh));

    const error = await manager
      .callTool(oauthService(fake.url), 'list_issues', {})
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(McpOAuthRejectedError);
    expect((error as McpOAuthRejectedError).needsReconnect).toBe(true);
    expect((error as Error).message).toMatch(/reconnect the service/);
    expect(refresh).toHaveBeenCalledOnce();
    expect(fake.seen).toEqual(['initialize:expired-token']);
  });

  it('does not attempt an OAuth refresh for a service without OAuth configuration', async () => {
    const fake = await listen(new Set());
    const refresh = vi.fn(async () => 'fresh-token');
    const manager = track(new MCPClientManager(async () => null, refresh));
    const service = oauthService(fake.url, {
      oauthClientId: undefined,
      oauthTokenUrl: undefined,
      oauthHasToken: false,
      headers: { Authorization: 'Bearer bad-api-key' },
    });

    await expect(manager.callTool(service, 'list_issues', {})).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('call_service_tool: one refresh, one retry, and a second rejection is MCP_AUTH_ERROR with no further attempts', async () => {
    const fake = await listen(new Set());
    const refresh = vi.fn(async () => 'also-rejected');
    const manager = track(new MCPClientManager(async () => 'expired-token', refresh));
    const service = oauthService(fake.url);
    const db = {
      getService: vi.fn().mockResolvedValue(service),
      updateServiceStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseManager;
    const serviceManager = new ServiceManager(
      db,
      manager,
      {} as unknown as OAuthManager,
      {} as unknown as OAuthClientSecretVault,
    );

    const result = await serviceManager.callServiceTool({
      serviceId: service.id,
      toolName: 'list_issues',
      arguments: {},
    });

    expect(result.success).toBe(false);
    expect(result).toMatchObject({ error_code: 'MCP_AUTH_ERROR' });
    expect(refresh).toHaveBeenCalledOnce();
    // Exactly two connection attempts: the original and the single retry.
    expect(fake.seen.filter((entry) => entry.startsWith('initialize:'))).toHaveLength(2);
  });

  it('call_service_tool succeeds with the refreshed token after the first is rejected', async () => {
    const fake = await listen(new Set(['fresh-token']));
    const refresh = vi.fn(async () => 'fresh-token');
    const manager = track(new MCPClientManager(async () => 'expired-token', refresh));
    const service = oauthService(fake.url);
    const db = {
      getService: vi.fn().mockResolvedValue(service),
      updateServiceStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseManager;
    const serviceManager = new ServiceManager(
      db,
      manager,
      {} as unknown as OAuthManager,
      {} as unknown as OAuthClientSecretVault,
    );

    const result = await serviceManager.callServiceTool({
      serviceId: service.id,
      toolName: 'list_issues',
      arguments: {},
    });

    expect(result.success).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    expect(fake.toolCalls).toEqual(['fresh-token']);
  });
});
