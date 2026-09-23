import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import McpUrlCopyButton from '../components/mcp-url-copy-button';
import { Toaster } from '../components/ui/toaster';
import { createTestWrapper } from '../test/setup';
import {
  MCP_PATH,
  MCP_ENDPOINT_API_PATH,
  buildMcpEndpointUrl,
  fetchMcpEndpointUrl,
} from './mcp-endpoint';

const stubFetchEndpoint = (url: string) => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: { url } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
};

describe('NOT-257 Get MCP URL copies the canonical endpoint', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  it('builds the client endpoint from host and MCP port, never the dashboard port', () => {
    expect(buildMcpEndpointUrl('192.168.1.20', 1110)).toBe('http://192.168.1.20:1110/mcp');
    const url = new URL(buildMcpEndpointUrl('deck.example.com', 3001));
    expect(url.pathname).toBe(MCP_PATH);
    expect(buildMcpEndpointUrl('192.168.1.20', 1110)).not.toContain(':1111');
  });

  it('fetches the canonical endpoint from the backend connection configuration', async () => {
    stubFetchEndpoint('http://deck.example.com:3001/mcp');
    await expect(fetchMcpEndpointUrl()).resolves.toBe('http://deck.example.com:3001/mcp');
    expect(fetch).toHaveBeenCalledWith(MCP_ENDPOINT_API_PATH, { credentials: 'include' });
  });

  it('click copies the exact endpoint URL and shows it in the success feedback', async () => {
    // Stands in for the backend's configured AGENT_DECK_HOST / AGENT_DECK_MCP_PORT.
    const configuredUrl = 'http://deck.example.com:3001/mcp';
    stubFetchEndpoint(configuredUrl);

    render(<McpUrlCopyButton />, { wrapper: createTestWrapper() });
    render(<Toaster />);

    fireEvent.click(screen.getByTestId('button-copy-mcp-url'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(configuredUrl);
    // The displayed copy-success feedback agrees with the clipboard value.
    await waitFor(() => expect(screen.getByText(configuredUrl)).toBeInTheDocument());
    expect(screen.getByText('MCP URL copied!')).toBeInTheDocument();
  });
});
