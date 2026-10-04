export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

type WindowEntry = {
  startedAt: number;
  count: number;
};

/** In-memory fixed-window limiter for a single hosted replica. */
export class RequestLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string, limit: number): RateLimitResult {
    const entry = this.currentEntry(key);
    if (!entry || entry.count < limit) {
      return { allowed: true };
    }
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.startedAt + this.windowMs - this.now()) / 1000)),
    };
  }

  consume(key: string, limit: number): RateLimitResult {
    const checked = this.check(key, limit);
    if (!checked.allowed) {
      return checked;
    }
    const current = this.currentEntry(key);
    if (current) {
      current.count += 1;
    } else {
      this.entries.set(key, { startedAt: this.now(), count: 1 });
    }
    return { allowed: true };
  }

  private currentEntry(key: string): WindowEntry | undefined {
    const entry = this.entries.get(key);
    if (entry && this.now() - entry.startedAt >= this.windowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }
}
