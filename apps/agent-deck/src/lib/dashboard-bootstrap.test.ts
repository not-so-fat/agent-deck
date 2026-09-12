import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootstrapDashboardSession } from './dashboard-bootstrap';

describe('bootstrapDashboardSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('removes a consumed bootstrap credential while preserving other URL state', async () => {
    window.history.replaceState({}, '', '/admin/approve?challenge=one&bootstrap=nonce#review');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await bootstrapDashboardSession();

    expect(window.location.pathname).toBe('/admin/approve');
    expect(window.location.search).toBe('?challenge=one');
    expect(window.location.hash).toBe('#review');
  });

  it('removes an expired bootstrap credential after a failed exchange', async () => {
    window.history.replaceState({}, '', '/?bootstrap=expired');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 410 }));

    await bootstrapDashboardSession();

    expect(window.location.search).toBe('');
  });
});
