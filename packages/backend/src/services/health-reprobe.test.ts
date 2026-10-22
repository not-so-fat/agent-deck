import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Service, ServiceStatusUpdate } from '@agent-deck/shared';
import {
  startHealthReprobe,
  HEALTH_REPROBE_INTERVAL_MS,
  type HealthProbeResult,
  type HealthReprobeClock,
  type HealthReprobeDeps,
} from './health-reprobe';

const UNHEALTHY: HealthProbeResult = {
  success: true,
  health: 'unhealthy',
  isConnected: false,
};
const HEALTHY: HealthProbeResult = {
  success: true,
  health: 'healthy',
  isConnected: true,
};

function makeService(overrides: Partial<Service> & { id: string }): Service {
  return {
    name: overrides.id,
    type: 'mcp',
    url: 'https://example.com/mcp',
    health: 'unhealthy',
    cardColor: '#000000',
    isConnected: false,
    registeredAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

/** Controllable clock: manual time plus a captured interval callback. */
function createFakeClock(startNow = 0): {
  clock: HealthReprobeClock;
  advance: (ms: number) => void;
  fire: () => Promise<void>;
  handle: { unref: ReturnType<typeof vi.fn> };
} {
  let now = startNow;
  let callback: (() => void) | undefined;
  const handle = { unref: vi.fn() };
  const setInterval = vi.fn((cb: () => void) => {
    callback = cb;
    return handle;
  });
  const clearInterval = vi.fn();
  return {
    clock: { now: () => now, setInterval, clearInterval },
    advance: (ms: number) => {
      now += ms;
    },
    fire: async () => {
      if (!callback) {
        throw new Error('interval callback was never registered');
      }
      await callback();
    },
    handle,
  };
}

function setup(
  services: Service[],
  checkHealth: (serviceId: string) => Promise<HealthProbeResult>,
  startNow = 0,
): {
  deps: HealthReprobeDeps;
  fake: ReturnType<typeof createFakeClock>;
  stop: () => void;
} {
  const fake = createFakeClock(startNow);
  const deps: HealthReprobeDeps = {
    listServices: vi.fn(async () => services),
    checkHealth: vi.fn(checkHealth),
    broadcast: vi.fn(),
  };
  const stop = startHealthReprobe(deps, { clock: fake.clock });
  return { deps, fake, stop };
}

describe('health-reprobe (NOT-512)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('probes an unhealthy service and broadcasts when it recovers', async () => {
    let upstreamUp = false;
    const service = makeService({ id: 'svc-1' });
    const { deps, fake, stop } = setup([service], async () =>
      upstreamUp ? HEALTHY : UNHEALTHY,
    );
    try {
      // First tick: still down, no broadcast.
      await fake.fire();
      expect(deps.checkHealth).toHaveBeenCalledTimes(1);
      expect(deps.broadcast).not.toHaveBeenCalled();

      // Upstream recovers; advance past the 1-minute backoff and re-probe.
      upstreamUp = true;
      fake.advance(60_000);
      await fake.fire();

      expect(deps.checkHealth).toHaveBeenCalledTimes(2);
      expect(deps.broadcast).toHaveBeenCalledTimes(1);
      expect(deps.broadcast).toHaveBeenCalledWith({
        serviceId: 'svc-1',
        health: 'healthy',
        isConnected: true,
        lastPing: expect.any(String),
      } satisfies ServiceStatusUpdate);
    } finally {
      stop();
    }
  });

  it('spaces repeated failures 1, 2, 4 minutes, caps at 15, resets on success', async () => {
    const service = makeService({ id: 'svc-1' });
    let healthy = false;
    const probeAt: number[] = [];
    let now = 0;
    const fake = createFakeClock(0);
    const checkHealth = vi.fn(async (): Promise<HealthProbeResult> => {
      probeAt.push(now);
      return healthy ? HEALTHY : UNHEALTHY;
    });
    const deps: HealthReprobeDeps = {
      listServices: vi.fn(async () => [service]),
      checkHealth,
      broadcast: vi.fn(),
    };
    const stop = startHealthReprobe(deps, {
      clock: { ...fake.clock, now: () => now },
    });
    const advance = (ms: number): void => {
      now += ms;
      fake.advance(ms);
    };
    try {
      // t=0: first probe fails -> next at +60s.
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(1);

      // t=30s: too early, no probe.
      advance(30_000);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(1);

      // t=60s: probe (gap 60s), fails -> next at +120s (t=180s).
      advance(30_000);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(2);

      // t=120s: too early.
      advance(60_000);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(2);

      // t=180s: probe (gap 120s), fails -> next at +240s (t=420s).
      advance(60_000);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(3);

      // t=420s: probe (gap 240s), fails -> next at +480s (t=900s).
      advance(240_000);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(4);

      // t=900s: probe (gap 480s), fails -> next at +900s cap (t=1800s).
      advance(480_000);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(5);

      // t=1500s (10 min later): still capped out, no probe.
      advance(600_000);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(5);

      // t=1800s: probe (gap 900s = 15min cap), fails -> still capped.
      advance(300_000);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(6);

      expect(probeAt).toEqual([0, 60_000, 180_000, 420_000, 900_000, 1_800_000]);

      // Success clears backoff: the next failure is spaced 1 minute again.
      healthy = true;
      advance(900_000);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(7);
      expect(deps.broadcast).toHaveBeenCalledTimes(1);

      healthy = false;
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(8);

      advance(59_999);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(8);

      advance(1);
      await fake.fire();
      expect(checkHealth).toHaveBeenCalledTimes(9);
    } finally {
      stop();
    }
  });

  it('never probes OAuth services with no token, nor healthy/unknown/a2a services', async () => {
    const noTokenOAuth = makeService({
      id: 'oauth-none',
      oauthClientId: 'client-1',
      oauthAuthorizationUrl: 'https://example.com/auth',
    });
    const tokenOAuth = makeService({
      id: 'oauth-token',
      oauthClientId: 'client-1',
      oauthHasToken: true,
    });
    const headerAuth = makeService({
      id: 'header-auth',
      oauthTokenUrl: 'https://example.com/token',
      headers: { Authorization: 'Bearer abc' },
    });
    const plain = makeService({ id: 'plain' });
    const local = makeService({ id: 'local', type: 'local-mcp' });
    const healthySvc = makeService({ id: 'healthy', health: 'healthy' });
    const unknownSvc = makeService({ id: 'unknown', health: 'unknown' });
    const a2a = makeService({ id: 'a2a', type: 'a2a' });
    const { deps, fake, stop } = setup(
      [noTokenOAuth, tokenOAuth, headerAuth, plain, local, healthySvc, unknownSvc, a2a],
      async () => HEALTHY,
    );
    try {
      await fake.fire();
      const probed = vi.mocked(deps.checkHealth).mock.calls.map(([id]) => id).sort();
      expect(probed).toEqual(['header-auth', 'local', 'oauth-token', 'plain']);
    } finally {
      stop();
    }
  });

  it('does not start a second probe while one is still running', async () => {
    const service = makeService({ id: 'svc-1' });
    let resolveProbe!: (result: HealthProbeResult) => void;
    const gate = new Promise<HealthProbeResult>((resolve) => {
      resolveProbe = resolve;
    });
    const { deps, fake, stop } = setup([service], () => gate);
    try {
      const first = fake.fire();
      // Let the first tick reach the in-flight probe before firing again.
      await vi.waitFor(() => {
        expect(deps.checkHealth).toHaveBeenCalledTimes(1);
      });
      const second = fake.fire();
      await Promise.resolve();
      await second;
      expect(deps.checkHealth).toHaveBeenCalledTimes(1);

      resolveProbe(HEALTHY);
      await first;
      expect(deps.broadcast).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('registers a 60s unref\'d interval and clears it on stop', async () => {
    const { fake, stop } = setup([], async () => UNHEALTHY);
    try {
      expect(fake.clock.setInterval).toHaveBeenCalledTimes(1);
      expect(fake.clock.setInterval).toHaveBeenCalledWith(
        expect.any(Function),
        HEALTH_REPROBE_INTERVAL_MS,
      );
      expect(HEALTH_REPROBE_INTERVAL_MS).toBe(60_000);
      expect(fake.handle.unref).toHaveBeenCalledTimes(1);

      stop();
      expect(fake.clock.clearInterval).toHaveBeenCalledTimes(1);
      expect(fake.clock.clearInterval).toHaveBeenCalledWith(fake.handle);
    } finally {
      stop();
    }
  });
});
