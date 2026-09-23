import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import Home from '../pages/home';
import { Toaster } from '../components/ui/toaster';
import {
  MCP_PATH,
  MCP_ENDPOINT_API_PATH,
  buildMcpEndpointUrl,
  copyMcpEndpointToClipboard,
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

/**
 * Route every dashboard data call to a benign payload so the real Home page
 * renders; the canonical MCP endpoint stands in for the backend's configured
 * AGENT_DECK_HOST / AGENT_DECK_MCP_PORT.
 */
function stubDashboardFetch(configuredUrl: string) {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url === MCP_ENDPOINT_API_PATH) {
      return new Response(JSON.stringify({ success: true, data: { url: configuredUrl } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/collection/warnings') {
      return new Response(
        JSON.stringify({
          success: true,
          data: { total: 0, byKind: {}, services: {}, credentials: {}, playbooks: {} },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ success: true, data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderHome() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Same convention as the app client: the first query key is the API
        // path, fetched and parsed as JSON.
        queryFn: async ({ queryKey }) => {
          const response = await fetch(queryKey[0] as string);
          if (!response.ok) {
            throw new Error(`Request failed: ${response.status}`);
          }
          return response.json();
        },
      },
      mutations: { retry: false },
    },
  });
  const { hook } = memoryLocation({ path: '/' });
  render(
    <Router hook={hook}>
      <QueryClientProvider client={queryClient}>
        <Home />
        <Toaster />
      </QueryClientProvider>
    </Router>,
  );
}

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

  it('copies the exact endpoint URL and shows it in the success feedback', async () => {
    const showToast = vi.fn();
    stubFetchEndpoint('http://deck.example.com:3001/mcp');

    await copyMcpEndpointToClipboard(showToast);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('http://deck.example.com:3001/mcp');
    expect(showToast).toHaveBeenCalledWith({
      title: 'MCP URL copied!',
      description: 'http://deck.example.com:3001/mcp',
    });
  });

  it('clicking Get MCP URL on the dashboard copies the configured endpoint with matching feedback', async () => {
    // Stands in for the backend's configured AGENT_DECK_HOST / AGENT_DECK_MCP_PORT.
    const configuredUrl = 'http://deck.example.com:3001/mcp';
    stubDashboardFetch(configuredUrl);

    renderHome();
    fireEvent.click(await screen.findByTestId('button-copy-mcp-url'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(configuredUrl);
    // The displayed copy-success feedback agrees with the clipboard value.
    await waitFor(() => expect(screen.getByText(configuredUrl)).toBeInTheDocument());
    expect(screen.getByText('MCP URL copied!')).toBeInTheDocument();
  });
});
