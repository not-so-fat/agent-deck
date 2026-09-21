import { spawn } from 'node:child_process';

import { readAdminSecret } from './admin-secret';

const NONCE_TIMEOUT_MS = 10_000;

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
      // A port that accepts the connection but never answers must not hang callers.
      signal: AbortSignal.timeout(NONCE_TIMEOUT_MS),
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
    return {
      code: 1,
      message: `Could not create a secure dashboard session (${minted.reason})`,
    };
  }
  openUrlInSystemBrowser(minted.url);
  return { code: 0, url: minted.url };
}

export function formatDashboardStatusLine(): string {
  return 'Dashboard  open or reopen with: agent-deck open';
}

export type DeckSwitchApprovalTarget = {
  approvalPath: string;
  requestId: string;
  runtimeSessionId?: string;
};

/** Approval page path for one deck-switch request. Secrets never go in the URL. */
export function buildDeckSwitchApprovalPath(requestId: string, runtimeSessionId?: string): string {
  const path = `/deck-switch/approve?request=${encodeURIComponent(requestId)}`;
  return runtimeSessionId ? `${path}&session=${encodeURIComponent(runtimeSessionId)}` : path;
}

type SwitchDeckToolResult = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
};

/**
 * NOT-212: read the pending presentation hint returned by `switch_deck`.
 * Only a `deck_switch_request` presentation with status `pending` and a
 * request id is an auto-open target — `already_on_deck`, errors, and foreign
 * shapes mean there is nothing for the human to approve.
 */
export function readDeckSwitchApproval(result: unknown): DeckSwitchApprovalTarget | undefined {
  const toolResult = result as SwitchDeckToolResult | undefined;
  if (!toolResult || toolResult.isError || !Array.isArray(toolResult.content)) {
    return undefined;
  }

  for (const item of toolResult.content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') {
      continue;
    }
    try {
      const data = JSON.parse(item.text) as Record<string, unknown>;
      const presentation = data.presentation as Record<string, unknown> | undefined;
      if (presentation?.kind !== 'deck_switch_request') {
        continue;
      }
      if (data.status !== 'pending' || presentation.status === 'already_on_deck') {
        continue;
      }
      const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
      if (!requestId) {
        continue;
      }
      const runtimeSessionId =
        typeof data.runtimeSessionId === 'string' && data.runtimeSessionId.trim()
          ? data.runtimeSessionId.trim()
          : undefined;
      return {
        approvalPath: buildDeckSwitchApprovalPath(requestId, runtimeSessionId),
        requestId,
        ...(runtimeSessionId ? { runtimeSessionId } : {}),
      };
    } catch {
      // Other text content is not a switch_deck response.
    }
  }
  return undefined;
}

/**
 * Mint an authenticated dashboard URL and open the switch approval page.
 * Reuses the trusted bootstrap mechanism — the URL carries only the opaque
 * request id, never an auth secret.
 */
export async function openDeckSwitchApproval(
  backendUrl: string,
  result: unknown,
  opener = openDashboardInBrowser,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // AGENT_DECK_NO_OPEN is an explicit opt-out; the request stays pending and
  // the menubar inbox remains the recovery path.
  if (!shouldOpenDashboardByDefault(env)) {
    return;
  }
  const approval = readDeckSwitchApproval(result);
  if (!approval) {
    throw new Error('switch_deck response did not contain a pending approval request');
  }
  const opened = await opener(backendUrl, approval.approvalPath);
  if (opened.code !== 0) {
    throw new Error(opened.message ?? 'failed to open deck-switch approval');
  }
}
