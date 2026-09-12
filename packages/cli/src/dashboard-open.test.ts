import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readAdminSecret } from './admin-secret';
import {
  formatDashboardStatusLine,
  openDashboardInBrowser,
  shouldOpenDashboardByDefault,
} from './dashboard-open';

vi.mock('./admin-secret', () => ({ readAdminSecret: vi.fn() }));

beforeEach(() => {
  vi.mocked(readAdminSecret).mockReset();
});

describe('shouldOpenDashboardByDefault', () => {
  it('defaults to true', () => {
    expect(shouldOpenDashboardByDefault({})).toBe(true);
  });

  it('respects AGENT_DECK_NO_OPEN', () => {
    expect(shouldOpenDashboardByDefault({ AGENT_DECK_NO_OPEN: '1' })).toBe(false);
    expect(shouldOpenDashboardByDefault({ AGENT_DECK_NO_OPEN: 'true' })).toBe(false);
    expect(shouldOpenDashboardByDefault({ AGENT_DECK_NO_OPEN: 'yes' })).toBe(false);
    expect(shouldOpenDashboardByDefault({ AGENT_DECK_NO_OPEN: '0' })).toBe(true);
  });
});

describe('formatDashboardStatusLine', () => {
  it('prints a durable recovery command without a disposable URL', () => {
    const line = formatDashboardStatusLine();
    expect(line).toBe('Dashboard  open or reopen with: agent-deck open');
    expect(line).not.toContain('bootstrap=');
  });
});

describe('openDashboardInBrowser', () => {
  it('does not open a bare dashboard URL when bootstrap minting is unavailable', async () => {
    vi.mocked(readAdminSecret).mockResolvedValueOnce(null);

    const result = await openDashboardInBrowser('http://127.0.0.1:1111');

    expect(result).toMatchObject({
      code: 1,
      message: expect.stringContaining('Could not create a secure dashboard session'),
    });
    expect(result.url).toBeUndefined();
  });
});
