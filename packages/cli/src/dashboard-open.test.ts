import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readAdminSecret } from './admin-secret';
import {
  buildDeckSwitchApprovalPath,
  formatDashboardStatusLine,
  openDashboardInBrowser,
  openDeckSwitchApproval,
  readDeckSwitchApproval,
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

describe('deck-switch approval target (NOT-212)', () => {
  function pendingResult(data: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }

  const pending = {
    requestId: 'req_abc',
    status: 'pending',
    presentation: { kind: 'deck_switch_request', status: 'pending' },
  };

  it('builds a secret-free approval path for the request', () => {
    expect(buildDeckSwitchApprovalPath('req_abc')).toBe('/deck-switch/approve?request=req_abc');
    expect(buildDeckSwitchApprovalPath('req_abc', 'ses_1')).toBe(
      '/deck-switch/approve?request=req_abc&session=ses_1',
    );
    expect(readDeckSwitchApproval(pendingResult(pending))).toEqual({
      approvalPath: '/deck-switch/approve?request=req_abc',
      requestId: 'req_abc',
    });
  });

  it('ignores non-pending, error, and foreign results', () => {
    expect(readDeckSwitchApproval({ isError: true, content: [] })).toBeUndefined();
    expect(
      readDeckSwitchApproval(pendingResult({ ...pending, status: 'already_on_deck' })),
    ).toBeUndefined();
    expect(
      readDeckSwitchApproval(pendingResult({ ...pending, requestId: '  ' })),
    ).toBeUndefined();
    expect(
      readDeckSwitchApproval(
        pendingResult({ requestId: 'req_x', status: 'pending', presentation: { kind: 'other' } }),
      ),
    ).toBeUndefined();
    expect(readDeckSwitchApproval({ content: [{ type: 'text', text: 'not json' }] })).toBeUndefined();
  });

  it('opens the approval page through the trusted bootstrap opener', async () => {
    const opener = vi.fn(async () => ({ code: 0, url: 'http://127.0.0.1/opened' }));
    await openDeckSwitchApproval('http://127.0.0.1:1111', pendingResult(pending), opener, {});
    expect(opener).toHaveBeenCalledWith(
      'http://127.0.0.1:1111',
      '/deck-switch/approve?request=req_abc',
    );
  });

  it('reports bootstrap failures without opening a bare URL', async () => {
    await expect(
      openDeckSwitchApproval(
        'http://127.0.0.1:1111',
        pendingResult(pending),
        async () => ({ code: 1, message: 'bootstrap nonce HTTP 403' }),
        {},
      ),
    ).rejects.toThrow('bootstrap nonce HTTP 403');
  });

  it('does not open a browser when AGENT_DECK_NO_OPEN is set', async () => {
    const opener = vi.fn(async () => ({ code: 0 }));
    await openDeckSwitchApproval('http://127.0.0.1:1111', pendingResult(pending), opener, {
      AGENT_DECK_NO_OPEN: 'yes',
    });
    expect(opener).not.toHaveBeenCalled();
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
