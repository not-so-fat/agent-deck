import { spawn } from 'node:child_process';

import { readAdminSecret } from './admin-secret';

export type MintDashboardUrlResult =
  | { ok: true; url: string; bootstrapped: true }
  | { ok: true; url: string; bootstrapped: false; reason: string }
  | { ok: false; error: string };

/** Build dashboard URL with a one-shot bootstrap nonce when admin secret is available. */
export async function mintDashboardBootstrapUrl(
  backendUrl: string,
  pathAndQuery = '/',
): Promise<MintDashboardUrlResult> {
  const base = backendUrl.replace(/\/$/, '');
  const pathPart = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  const target = new URL(pathPart, `${base}/`);

  try {
    const secret = await readAdminSecret();
    if (!secret) {
      return {
        ok: true,
        url: target.toString(),
        bootstrapped: false,
        reason: 'admin secret missing — run agent-deck open after start',
      };
    }

    const nonceRes = await fetch(`${base}/api/dashboard-auth/bootstrap/nonce`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!nonceRes.ok) {
      return {
        ok: true,
        url: target.toString(),
        bootstrapped: false,
        reason: `bootstrap nonce HTTP ${nonceRes.status}`,
      };
    }

    const body = (await nonceRes.json()) as { data?: { nonce?: string } };
    const nonce = body.data?.nonce?.trim();
    if (!nonce) {
      return {
        ok: true,
        url: target.toString(),
        bootstrapped: false,
        reason: 'bootstrap nonce empty',
      };
    }

    target.searchParams.set('bootstrap', nonce);
    return { ok: true, url: target.toString(), bootstrapped: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function shouldOpenDashboardByDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AGENT_DECK_NO_OPEN?.trim().toLowerCase();
  return !(raw === '1' || raw === 'true' || raw === 'yes');
}

export function openUrlInSystemBrowser(url: string): void {
  const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(open, [url], { stdio: 'ignore', shell: process.platform === 'win32' }).unref();
}

/** Mint bootstrap URL and open the system browser. Returns 0 on success. */
export async function openDashboardInBrowser(
  backendUrl: string,
  pathAndQuery = '/',
): Promise<{ code: number; url?: string; message?: string }> {
  const minted = await mintDashboardBootstrapUrl(backendUrl, pathAndQuery);
  if (!minted.ok) {
    return { code: 1, message: minted.error };
  }
  if (!minted.bootstrapped) {
    console.warn(`[agent-deck] Opening without bootstrap cookie (${minted.reason})`);
    console.warn('[agent-deck] Bare dashboard URLs show "No valid workspace grant" until bootstrapped.');
  }
  openUrlInSystemBrowser(minted.url);
  return { code: 0, url: minted.url };
}

export function formatDashboardStatusLine(minted: MintDashboardUrlResult): string {
  if (!minted.ok) {
    return `Dashboard  (mint failed: ${minted.error} — try: agent-deck open)`;
  }
  if (minted.bootstrapped) {
    return `Dashboard  ${minted.url}`;
  }
  return `Dashboard  ${minted.url}  (no bootstrap — run: agent-deck open)`;
}
