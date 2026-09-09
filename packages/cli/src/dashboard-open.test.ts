import { describe, expect, it } from 'vitest';
import { formatDashboardStatusLine, shouldOpenDashboardByDefault } from './dashboard-open';

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
  it('prints bootstrapped URL', () => {
    expect(
      formatDashboardStatusLine({
        ok: true,
        url: 'http://127.0.0.1:1111/?bootstrap=abc',
        bootstrapped: true,
      }),
    ).toBe('Dashboard  http://127.0.0.1:1111/?bootstrap=abc');
  });

  it('hints open when not bootstrapped', () => {
    expect(
      formatDashboardStatusLine({
        ok: true,
        url: 'http://127.0.0.1:1111/',
        bootstrapped: false,
        reason: 'admin secret missing',
      }),
    ).toContain('agent-deck open');
  });
});
