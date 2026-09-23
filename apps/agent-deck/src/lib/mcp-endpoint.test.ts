import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MCP_PATH, buildMcpEndpointUrl } from './mcp-endpoint';

const here = path.dirname(fileURLToPath(import.meta.url));
const homeSource = fs.readFileSync(path.resolve(here, '../pages/home.tsx'), 'utf8');

describe('NOT-257 Get MCP URL copies the canonical endpoint', () => {
  it('derives the client endpoint from the configured public/base origin', () => {
    expect(buildMcpEndpointUrl('https://deck.example.com')).toBe('https://deck.example.com/mcp');
  });

  it('keeps a non-default port from the current environment origin', () => {
    expect(buildMcpEndpointUrl('http://192.168.1.20:8000')).toBe('http://192.168.1.20:8000/mcp');
  });

  it('never adds a label, surrounding text, or trailing slash', () => {
    expect(buildMcpEndpointUrl('https://deck.example.com/')).toBe('https://deck.example.com/mcp');
    const url = new URL(buildMcpEndpointUrl('https://deck.example.com'));
    expect(url.pathname).toBe(MCP_PATH);
  });

  it('defaults to the live dashboard origin, never a stale baked-in origin', () => {
    expect(buildMcpEndpointUrl()).toBe(`${window.location.origin}${MCP_PATH}`);
  });

  it('copies the helper result verbatim with no hardcoded internal address', () => {
    expect(homeSource).toContain('buildMcpEndpointUrl()');
    expect(homeSource).toContain('navigator.clipboard.writeText(mcpUrl)');
    expect(homeSource).not.toContain('localhost:3001/mcp');
    expect(homeSource).not.toContain('127.0.0.1');
  });

  it('shows the exact clipboard value in the copy-success feedback', () => {
    const copyBlock = homeSource.slice(
      homeSource.indexOf('button-copy-mcp-url'),
      homeSource.indexOf('Get MCP URL') + 'Get MCP URL'.length + 200,
    );
    expect(copyBlock).toContain('description: mcpUrl');
  });
});
