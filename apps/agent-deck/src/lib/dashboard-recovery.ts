/**
 * NOT-286: bare-origin recovery helpers.
 *
 * A browser that lands on the loopback origin with no dashboard cookie holds
 * no authority, and nothing here mints any: the only secure handoff is a
 * trusted local launcher (the `agent-deck` CLI on this machine, e.g. via the
 * menubar entry) or the human running `agent-deck open` in a terminal.
 */

export const DASHBOARD_OPEN_COMMAND = 'agent-deck open';

/**
 * Trusted local launcher handoff. Navigating here sends no credentials and
 * mints no session — if the OS has a handler for the scheme it wakes the
 * local launcher, which mints its own bootstrap through the admin secret.
 * No handler is registered by the installer today, so callers must always
 * show the `agent-deck open` fallback alongside this attempt.
 */
export const DASHBOARD_LAUNCHER_URL = 'agent-deck://open';

/** Fire-and-forget handoff attempt via a hidden iframe (no top-level navigation). */
export function attemptTrustedLauncherOpen(doc: Document = document): void {
  const iframe = doc.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.style.display = 'none';
  iframe.src = DASHBOARD_LAUNCHER_URL;
  doc.body.appendChild(iframe);
  window.setTimeout(() => {
    iframe.remove();
  }, 5000);
}

export async function copyDashboardOpenCommand(
  writeText: (text: string) => Promise<void> = (text) => navigator.clipboard.writeText(text),
): Promise<boolean> {
  try {
    await writeText(DASHBOARD_OPEN_COMMAND);
    return true;
  } catch {
    return false;
  }
}
