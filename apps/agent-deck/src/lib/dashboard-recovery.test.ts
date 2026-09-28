import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attemptTrustedLauncherOpen,
  copyDashboardOpenCommand,
  DASHBOARD_LAUNCHER_URL,
  DASHBOARD_OPEN_COMMAND,
} from './dashboard-recovery';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.mocked(fetch).mockClear();
});

describe('dashboard-recovery lib (NOT-286)', () => {
  it('exposes the exact terminal command, never a URL', () => {
    expect(DASHBOARD_OPEN_COMMAND).toBe('agent-deck open');
    expect(DASHBOARD_OPEN_COMMAND).not.toMatch(/^https?:/);
  });

  it('attempts a credential-free local launcher handoff without granting authority', () => {
    const hrefBefore = window.location.href;

    attemptTrustedLauncherOpen();

    const iframe = document.body.querySelector('iframe');
    expect(iframe?.getAttribute('src')).toBe(DASHBOARD_LAUNCHER_URL);
    // No session minting from the browser: no fetch, no navigation.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(window.location.href).toBe(hrefBefore);
  });

  it('copies the exact command on success', async () => {
    const writeText = vi.fn(async () => {});

    await expect(copyDashboardOpenCommand(writeText)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('agent-deck open');
  });

  it('reports failure instead of throwing when the clipboard is unavailable', async () => {
    await expect(
      copyDashboardOpenCommand(async () => {
        throw new Error('denied');
      }),
    ).resolves.toBe(false);
  });
});
