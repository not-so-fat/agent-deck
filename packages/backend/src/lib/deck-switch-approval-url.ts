import { resolveDashboardOrigin } from './paths';

/**
 * NOT-632: the browser approval page for one pending deck-switch request,
 * relative to the dashboard origin. Same path the menubar inbox opens.
 */
export function deckSwitchApprovalPath(requestId: string, runtimeSessionId: string): string {
  return `/deck-switch/approve?request=${encodeURIComponent(requestId)}&session=${encodeURIComponent(runtimeSessionId)}`;
}

/** Wildcard bind addresses are not browsable; point at loopback instead. */
const WILDCARD_HOSTS = new Set(['0.0.0.0', '[::]', '::']);

function normalizeOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (WILDCARD_HOSTS.has(url.hostname)) {
    url.hostname = '127.0.0.1';
  }
  // Keep a path prefix (reverse proxy mount), drop query/fragment and the
  // trailing slash so the approval path appends cleanly.
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * Absolute base for approval links: `AGENT_DECK_PUBLIC_URL` when it is a
 * valid http(s) URL (a headless host reached from another device), else the
 * local dashboard origin.
 */
export function resolveApprovalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const publicUrl = env.AGENT_DECK_PUBLIC_URL?.trim();
  if (publicUrl) {
    const normalized = normalizeOrigin(publicUrl);
    if (normalized) {
      return normalized;
    }
  }
  return normalizeOrigin(resolveDashboardOrigin()) ?? 'http://127.0.0.1:8000';
}

/** Absolute browser approval link for one pending deck-switch request. */
export function deckSwitchApprovalUrl(
  requestId: string,
  runtimeSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveApprovalBaseUrl(env)}${deckSwitchApprovalPath(requestId, runtimeSessionId)}`;
}
