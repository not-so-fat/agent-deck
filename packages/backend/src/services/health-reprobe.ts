import type { Service, ServiceStatusUpdate } from '@agent-deck/shared';

/**
 * NOT-512: background self-heal for MCP services stuck `unhealthy`.
 *
 * `ServiceManager.shouldBackgroundProbe` only covers `unknown` services (and
 * only when the dashboard loads `GET /api/services`), so an `unhealthy`
 * service never recovered unless the owner opened its card. This module
 * re-probes `unhealthy` `mcp`/`local-mcp` services on a 60s interval with
 * per-service exponential backoff (1/2/4 min, capped at 15 min) kept in
 * memory. On success the backoff is cleared and a status update is
 * broadcast; no dashboard visit is needed.
 */

/** Cadence of the background re-probe sweep (wired up in server/index). */
export const HEALTH_REPROBE_INTERVAL_MS = 60_000;
/** Delay after the first failed probe; doubles per consecutive failure. */
export const HEALTH_REPROBE_BASE_DELAY_MS = 60_000;
/** Upper bound between probes of a single service. */
export const HEALTH_REPROBE_MAX_DELAY_MS = 15 * 60_000;

export type HealthProbeResult =
  | { success: boolean; health: string; isConnected: boolean }
  | { success: false; error: string };

export interface HealthReprobeDeps {
  listServices: () => Promise<Service[]>;
  checkHealth: (serviceId: string) => Promise<HealthProbeResult>;
  broadcast: (update: ServiceStatusUpdate) => void;
}

/**
 * Injectable clock. Tests substitute a fake `{ now, setInterval,
 * clearInterval }` triple to control time and drive ticks deterministically.
 */
export interface HealthReprobeClock {
  now: () => number;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

export const systemHealthReprobeClock: HealthReprobeClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface HealthReprobeOptions {
  clock?: HealthReprobeClock;
  intervalMs?: number;
  onError?: (error: unknown, serviceId?: string) => void;
}

/** Backoff delay after `failures` consecutive failed probes (1-based). */
export function computeReprobeDelayMs(failures: number): number {
  if (failures < 1) {
    return HEALTH_REPROBE_BASE_DELAY_MS;
  }
  return Math.min(
    HEALTH_REPROBE_BASE_DELAY_MS * 2 ** (failures - 1),
    HEALTH_REPROBE_MAX_DELAY_MS,
  );
}

/**
 * Whether this module may probe the service. Mirrors the OAuth part of
 * `ServiceManager.shouldBackgroundProbe`: a service that needs OAuth and has
 * no token at all is skipped because only the owner can fix that. Only
 * `unhealthy` `mcp`/`local-mcp` services are candidates — `healthy` and
 * `unknown` services are left alone (`unknown` keeps its dashboard path).
 */
function isReprobeCandidate(service: Service): boolean {
  if (service.type !== 'mcp' && service.type !== 'local-mcp') {
    return false;
  }
  if (service.health !== 'unhealthy') {
    return false;
  }
  if (service.type === 'local-mcp') {
    return true;
  }
  const hasOAuthConfig = Boolean(
    service.oauthClientId ||
      service.oauthAuthorizationUrl ||
      service.oauthTokenUrl,
  );
  const hasAuth = Boolean(
    service.oauthHasToken ||
      service.oauthAccessToken ||
      service.headers?.Authorization,
  );
  if (hasOAuthConfig && !hasAuth) {
    return false;
  }
  return true;
}

/**
 * Start the background re-probe loop. Returns a stop function that clears
 * the timer. The timer is unref'd so it never holds the backend process open.
 */
export function startHealthReprobe(
  deps: HealthReprobeDeps,
  options: HealthReprobeOptions = {},
): () => void {
  const clock = options.clock ?? systemHealthReprobeClock;
  const intervalMs = options.intervalMs ?? HEALTH_REPROBE_INTERVAL_MS;
  const onError =
    options.onError ??
    ((error: unknown, serviceId?: string) => {
      console.warn(
        `Health re-probe failed${serviceId ? ` for service ${serviceId}` : ''}:`,
        error,
      );
    });

  const consecutiveFailures = new Map<string, number>();
  const nextAttemptAt = new Map<string, number>();
  const inFlight = new Set<string>();

  const scheduleNextAttempt = (serviceId: string, now: number): void => {
    const failures = (consecutiveFailures.get(serviceId) ?? 0) + 1;
    consecutiveFailures.set(serviceId, failures);
    nextAttemptAt.set(serviceId, now + computeReprobeDelayMs(failures));
  };

  const probe = async (service: Service): Promise<void> => {
    try {
      const result = await deps.checkHealth(service.id);
      if (result.success && 'health' in result && result.health === 'healthy') {
        consecutiveFailures.delete(service.id);
        nextAttemptAt.delete(service.id);
        deps.broadcast({
          serviceId: service.id,
          health: 'healthy',
          isConnected: result.isConnected,
          lastPing: new Date(clock.now()).toISOString(),
        });
      } else {
        scheduleNextAttempt(service.id, clock.now());
      }
    } catch (error) {
      onError(error, service.id);
      scheduleNextAttempt(service.id, clock.now());
    } finally {
      inFlight.delete(service.id);
    }
  };

  const tick = async (): Promise<void> => {
    let services: Service[];
    try {
      services = await deps.listServices();
    } catch (error) {
      onError(error);
      return;
    }
    const now = clock.now();
    const due: Service[] = [];
    for (const service of services) {
      if (!isReprobeCandidate(service)) {
        continue;
      }
      if (inFlight.has(service.id)) {
        continue;
      }
      const attemptAt = nextAttemptAt.get(service.id);
      if (attemptAt !== undefined && now < attemptAt) {
        continue;
      }
      inFlight.add(service.id);
      due.push(service);
    }
    await Promise.all(due.map((service) => probe(service)));
  };

  const onTick = (): Promise<void> => tick().catch((error) => onError(error));
  const handle = clock.setInterval(onTick, intervalMs);
  (handle as { unref?: () => void } | null | undefined)?.unref?.();

  return () => {
    clock.clearInterval(handle);
  };
}
