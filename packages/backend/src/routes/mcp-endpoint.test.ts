import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveMcpEndpoint } from '../mcp-endpoint';
import mcpRoutes from '../routes/mcp';
import { resolveRoutePolicy } from '../trusted-session/route-policy-registry';

describe('NOT-257 canonical MCP client connection endpoint', () => {
  const servers: Array<Awaited<ReturnType<typeof Fastify>>> = [];
  let savedHost: string | undefined;
  let savedPort: string | undefined;

  beforeEach(() => {
    savedHost = process.env.AGENT_DECK_HOST;
    savedPort = process.env.AGENT_DECK_MCP_PORT;
  });

  afterEach(async () => {
    if (savedHost === undefined) {
      delete process.env.AGENT_DECK_HOST;
    } else {
      process.env.AGENT_DECK_HOST = savedHost;
    }
    if (savedPort === undefined) {
      delete process.env.AGENT_DECK_MCP_PORT;
    } else {
      process.env.AGENT_DECK_MCP_PORT = savedPort;
    }
    while (servers.length) {
      await servers.pop()?.close();
    }
  });

  async function buildApp() {
    const fastify = Fastify();
    await fastify.register(mcpRoutes, { prefix: '/api/mcp' });
    await fastify.ready();
    servers.push(fastify);
    return fastify;
  }

  it('derives the endpoint from AGENT_DECK_HOST and AGENT_DECK_MCP_PORT', () => {
    process.env.AGENT_DECK_HOST = '192.168.1.20';
    process.env.AGENT_DECK_MCP_PORT = '1110';
    expect(resolveMcpEndpoint()).toEqual({
      host: '192.168.1.20',
      mcpPort: 1110,
      url: 'http://192.168.1.20:1110/mcp',
    });
  });

  it('falls back to loopback and the default MCP port, never the dashboard port', () => {
    delete process.env.AGENT_DECK_HOST;
    delete process.env.AGENT_DECK_MCP_PORT;
    const endpoint = resolveMcpEndpoint();
    expect(endpoint.url).toBe('http://127.0.0.1:1110/mcp');
    expect(endpoint.url).not.toContain(':1111');
    expect(endpoint.url).not.toContain(':3000');
  });

  it('GET /api/mcp/endpoint returns the exact canonical URL', async () => {
    process.env.AGENT_DECK_HOST = 'deck.example.com';
    process.env.AGENT_DECK_MCP_PORT = '3001';
    const fastify = await buildApp();
    const response = await fastify.inject({ method: 'GET', url: '/api/mcp/endpoint' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: { url: 'http://deck.example.com:3001/mcp' },
    });
  });

  it('is public so the dashboard copy button can read it', () => {
    expect(resolveRoutePolicy('GET', '/api/mcp/endpoint')).toBe('allowPublic');
  });
});
