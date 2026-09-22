import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAdminSecret } from './admin-secret';
import {
  buildDeckSwitchApprovalPath,
  formatDashboardStatusLine,
  openDashboardInBrowser,
  openDeckSwitchApproval,
  openUrlInSystemBrowser,
  readDeckSwitchApproval,
  resolveSystemBrowserOpener,
  shouldOpenDashboardByDefault,
} from './dashboard-open';

vi.mock('./admin-secret', () => ({ readAdminSecret: vi.fn() }));

beforeEach(() => {
  vi.mocked(readAdminSecret).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type FakeChild = EventEmitter & { unref: () => void };

function fakeSpawn(emit: (child: FakeChild) => void, onCall?: (...args: unknown[]) => void) {
  return ((...args: unknown[]) => {
    onCall?.(...args);
    const child = new EventEmitter() as FakeChild;
    child.unref = () => {};
    process.nextTick(() => emit(child));
    return child;
  }) as unknown as typeof spawn;
}

function spawnEnoent(opener = 'xdg-open') {
  return fakeSpawn((child) => {
    child.emit('error', Object.assign(new Error(`spawn ${opener} ENOENT`), { code: 'ENOENT' }));
  });
}

function spawnSuccess() {
  return fakeSpawn((child) => {
    child.emit('spawn');
  });
}

function stubNonceFetch(nonce = 'nonce_123') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { nonce } }),
    })),
  );
}

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

describe('openUrlInSystemBrowser (NOT-237)', () => {
  it('keeps one opener command per platform', () => {
    expect(resolveSystemBrowserOpener('darwin')).toBe('open');
    expect(resolveSystemBrowserOpener('win32')).toBe('start');
    expect(resolveSystemBrowserOpener('linux')).toBe('xdg-open');
  });

  it('reports a spawn failure instead of resolving void', async () => {
    const result = await openUrlInSystemBrowser('http://127.0.0.1:1111/', spawnEnoent());

    expect(result).toEqual({
      ok: false,
      opener: resolveSystemBrowserOpener(),
      error: expect.stringContaining('ENOENT'),
    });
  });

  it('reports a synchronous spawn throw as a failure', async () => {
    const throwing = (() => {
      throw new Error('spawn start EACCES');
    }) as unknown as typeof spawn;

    const result = await openUrlInSystemBrowser('http://127.0.0.1:1111/', throwing);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('EACCES') });
  });

  it('resolves success when the opener spawns', async () => {
    await expect(openUrlInSystemBrowser('http://127.0.0.1:1111/', spawnSuccess())).resolves.toEqual({
      ok: true,
    });
  });
});

describe('openDashboardInBrowser browser failures (NOT-237)', () => {
  const approvalPath = '/deck-switch/approve?request=req_1';

  function bootstrapReady() {
    vi.mocked(readAdminSecret).mockResolvedValue('admin-secret-for-tests');
    stubNonceFetch();
  }

  it('returns an actionable failure when the opener fails to spawn', async () => {
    bootstrapReady();
    const opener = resolveSystemBrowserOpener();
    const calls: unknown[][] = [];
    const result = await openDashboardInBrowser(
      'http://127.0.0.1:1111',
      approvalPath,
      fakeSpawn(
        (child) => {
          child.emit(
            'error',
            Object.assign(new Error(`spawn ${opener} ENOENT`), { code: 'ENOENT' }),
          );
        },
        (...args) => {
          calls.push(args);
        },
      ),
    );

    expect(result.code).toBe(1);
    expect(result.url).toBeUndefined();
    expect(result.message).toContain(opener);
    expect(result.message).toContain('ENOENT');
    expect(result.message).toContain('http://127.0.0.1:1111/');
    expect(result.message).toContain('menubar Pending approvals');
    expect(result.message).toContain(`agent-deck open --path "${approvalPath}"`);
    expect(result.message).not.toContain('Opened dashboard in your browser.');
    // The opener binary is unchanged — still the platform command with the URL.
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(opener);
    expect(calls[0][1]).toEqual([expect.stringContaining('http://127.0.0.1:1111/')]);
  });

  it('still returns the minted URL on a clean spawn', async () => {
    bootstrapReady();

    const result = await openDashboardInBrowser('http://127.0.0.1:1111', '/', spawnSuccess());

    expect(result.code).toBe(0);
    expect(result.url).toContain('http://127.0.0.1:1111/');
    expect(result.url).toContain('bootstrap=nonce_123');
    expect(result.message).toBeUndefined();
  });

  it('surfaces a spawn failure as a throw for the auto-open call sites', async () => {
    bootstrapReady();
    const pending = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            requestId: 'req_1',
            status: 'pending',
            presentation: { kind: 'deck_switch_request', status: 'pending' },
          }),
        },
      ],
    };

    const opener = resolveSystemBrowserOpener();
    await expect(
      openDeckSwitchApproval(
        'http://127.0.0.1:1111',
        pending,
        (backendUrl, path) => openDashboardInBrowser(backendUrl, path, spawnEnoent(opener)),
        {},
      ),
    ).rejects.toThrow('ENOENT');
  });
});
