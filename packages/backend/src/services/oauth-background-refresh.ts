import type { Service } from '@agent-deck/shared';

import { isGoogleMcpServiceUrl } from './google-oauth-config';
import { OAuthRefreshError } from './oauth-manager';

/**
 * NOT-654: background self-renewal for Google OAuth cards.
 *
 * On-demand refresh (`OAuthManager.getValidAccessToken`, the 401-retry path)
 * never touches an idle card, and Google answers `tools/list` with 200 even
 * for a dead token — so an idle card's token silently expired while the card
 * kept showing `healthy`. This module sweeps every Google OAuth card
 * (URL host ending in `.googleapis.com`) whose vault bundle holds a refresh
 * token and renews the access token when it is within the 5-minute buffer of
 * expiry, or already expired. It runs once at startup so a token that
 * expired while the daemon was down is renewed immediately.
 *
 * Refresh failures are classified by `OAuthManager`: a rejected grant
 * (`invalid_grant`/`invalid_client`/other 4xx) marks the card
 * `needs_reconnect` and the refresher leaves it alone until a human
 * reconnects; a transient failure (network, 429/408, 5xx) or missing config
 * is retried with capped backoff. Non-Google cards are never touched.
 */

/** Cadence of the background refresh sweep (wired up in server/index). */
export const OAUTH_BACKGROUND_REFRESH_INTERVAL_MS = 60_000;
/** Renew when the token expires within this buffer (parity with `isOAuthAccessTokenExpired`). */
export const OAUTH_BACKGROUND_REFRESH_BUFFER_MS = 5 * 60 * 1000;
/** Delay after the first transient refresh failure; doubles per failure. */
export const OAUTH_BACKGROUND_REFRESH_BASE_DELAY_MS = 60_000;
/** Upper bound between refresh attempts of a single service. */
export const OAUTH_BACKGROUND_REFRESH_MAX_DELAY_MS = 15 * 60_000;

/** The vault fields the refresher needs; `OAuthTokenBundle` satisfies this. */
export interface OAuthRefreshTokenBundle {
  refreshToken?: string;
  expiresAt?: string | null;
}

export interface OAuthBackgroundRefreshDeps {
  listServices: () => Promise<Service[]>;
  getTokenBundle: (service: Service) => Promise<OAuthRefreshTokenBundle | null>;
  /** Renew the access token; must be `OAuthManager.refreshOAuthToken` (single-flight). */
  refresh: (serviceId: string, refreshToken: string) => Promise<unknown>;
  /** Sticky rejected-grant state; while true the card is skipped. */
  isRefreshRejected: (serviceId: string) => boolean;
  /** Drop the cached MCP client (its `Authorization` header is stale). */
  invalidateClient: (serviceId: string) => void;
  /** Called once when a grant is definitively rejected (mark unhealthy + broadcast). */
  onRefreshRejected?: (serviceId: string) => void | Promise<void>;
}

/**
 * Injectable clock. Tests substitute a fake `{ now, setInterval,
 * clearInterval }` triple to control time and drive ticks deterministically.
 */
export interface OAuthBackgroundRefreshClock {
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export const systemOAuthBackgroundRefreshClock: OAuthBackgroundRefreshClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface OAuthBackgroundRefreshOptions {
  clock?: OAuthBackgroundRefreshClock;
  intervalMs?: number;
  onError?: (error: unknown, serviceId?: string) => void;
}

/** Backoff delay after `failures` consecutive transient failures (1-based). */
export function computeOAuthRefreshRetryDelayMs(failures: number): number {
  if (failures < 1) {
    return OAUTH_BACKGROUND_REFRESH_BASE_DELAY_MS;
  }
  return Math.min(
    OAUTH_BACKGROUND_REFRESH_BASE_DELAY_MS * 2 ** (failures - 1),
    OAUTH_BACKGROUND_REFRESH_MAX_DELAY_MS,
  );
}

/** Due when an expiry is recorded and lands within the buffer (or in the past). */
function isRefreshDue(
  expiresAt: string | null | undefined,
  now: number,
): boolean {
  if (!expiresAt) {
    return false;
  }
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) {
    return false;
  }
  return ms <= now + OAUTH_BACKGROUND_REFRESH_BUFFER_MS;
}

function refreshFailureKind(
  error: unknown,
): 'rejected' | 'transient' | 'missing_config' {
  if (error instanceof OAuthRefreshError) {
    return error.kind;
  }
  return 'transient';
}

/**
 * Start the background refresh loop. Runs once immediately (so a token that
 * expired while the daemon was down is renewed at startup), then on the
 * interval. Returns a stop function that clears the timer. The timer is
 * unref'd so it never holds the backend process open.
 */
export function startOAuthBackgroundRefresh(
  deps: OAuthBackgroundRefreshDeps,
  options: OAuthBackgroundRefreshOptions = {},
): () => void {
  const clock = options.clock ?? systemOAuthBackgroundRefreshClock;
  const intervalMs = options.intervalMs ?? OAUTH_BACKGROUND_REFRESH_INTERVAL_MS;
  const onError =
    options.onError ??
    ((error: unknown, serviceId?: string) => {
      console.warn(
        `OAuth background refresh failed${serviceId ? ` for service ${serviceId}` : ''}:`,
        error,
      );
    });

  const consecutiveFailures = new Map<string, number>();
  const nextAttemptAt = new Map<string, number>();
  const inFlight = new Set<string>();

  const scheduleRetry = (serviceId: string, now: number): void => {
    const failures = (consecutiveFailures.get(serviceId) ?? 0) + 1;
    consecutiveFailures.set(serviceId, failures);
    nextAttemptAt.set(
      serviceId,
      now + computeOAuthRefreshRetryDelayMs(failures),
    );
  };

  const attempt = async (
    service: Service,
    refreshToken: string,
    startedAt: number,
  ): Promise<void> => {
    try {
      await deps.refresh(service.id, refreshToken);
      consecutiveFailures.delete(service.id);
      nextAttemptAt.delete(service.id);
      deps.invalidateClient(service.id);
    } catch (error) {
      const kind = refreshFailureKind(error);
      if (kind === 'rejected') {
        // Definitive: the grant will never succeed. `OAuthManager` recorded
        // the sticky state (this card is now `needs_reconnect`); stop
        // retrying it and let the daemon surface that state.
        consecutiveFailures.delete(service.id);
        nextAttemptAt.delete(service.id);
        try {
          await deps.onRefreshRejected?.(service.id);
        } catch (notifyError) {
          onError(notifyError, service.id);
        }
      } else {
        // Transient or missing config (a later NOT-653 heal may fix the
        // latter): keep the token and retry with capped backoff.
        scheduleRetry(service.id, startedAt);
        onError(error, service.id);
      }
    } finally {
      inFlight.delete(service.id);
    }
  };

  const tick = async (): Promise<void> => {
    const now = clock.now();
    let services: Service[];
    try {
      services = await deps.listServices();
    } catch (error) {
      onError(error);
      return;
    }
    const due: Array<{ service: Service; refreshToken: string }> = [];
    for (const service of services) {
      if (!isGoogleMcpServiceUrl(service.url)) {
        continue;
      }
      if (inFlight.has(service.id)) {
        continue;
      }
      if (deps.isRefreshRejected(service.id)) {
        continue;
      }
      const attemptAt = nextAttemptAt.get(service.id);
      if (attemptAt !== undefined && now < attemptAt) {
        continue;
      }
      let bundle: OAuthRefreshTokenBundle | null;
      try {
        bundle = await deps.getTokenBundle(service);
      } catch (error) {
        onError(error, service.id);
        continue;
      }
      if (!bundle?.refreshToken) {
        continue;
      }
      const expiresAt =
        service.oauthTokenExpiresAt || bundle.expiresAt || null;
      if (!isRefreshDue(expiresAt, now)) {
        continue;
      }
      inFlight.add(service.id);
      due.push({ service, refreshToken: bundle.refreshToken });
    }
    await Promise.all(
      due.map(({ service, refreshToken }) =>
        attempt(service, refreshToken, now),
      ),
    );
  };

  const onTick = (): Promise<void> => tick().catch((error) => onError(error));
  // Run once at startup: renew tokens that expired while the daemon was down.
  void onTick();
  const handle = clock.setInterval(onTick, intervalMs);
  (handle as { unref?: () => void } | null | undefined)?.unref?.();

  return () => {
    clock.clearInterval(handle);
  };
}
