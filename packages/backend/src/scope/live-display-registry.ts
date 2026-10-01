import path from 'node:path';
import {
  DeckCardCounts,
  DeckDisplaySource,
  normalizeWorkspaceRoot,
} from '@agent-deck/shared';
import { assignBadge } from './badge';

export type LiveDisplayEntry = {
  mcpSessionId: string;
  /** Absent for header/auto-bound sessions (deck without a known folder). */
  workspaceRoot?: string;
  deckId: string;
  deckName: string;
  source: Exclude<DeckDisplaySource, 'unbound'>;
  cardCounts: DeckCardCounts;
  updatedAt: string;
  badge: string;
  clientName?: string;
  lastActivityAt: string;
};

export type LiveDisplayUpsert = Omit<LiveDisplayEntry, 'badge' | 'lastActivityAt'>;

/**
 * NOT-309: staleness bound for live-display entries. A session that dies
 * without a clean MCP disconnect (killed terminal, SIGKILL, crashed host)
 * never fires `transport.onclose`, so its entry would otherwise linger
 * forever and keep the workspace status line on `multiple session decks`.
 * Entries older than this bound are ignored by `resolveWorkspaceSessions`
 * and removed by the sweep. `0` disables expiry.
 */
export const DEFAULT_LIVE_DISPLAY_STALE_MS = 30 * 60 * 1_000;
export const LIVE_DISPLAY_STALE_ENV_VAR = 'LIVE_DISPLAY_STALE_MS';
/** Cadence of the registry-owned periodic sweep (wired up in server/index). */
export const LIVE_DISPLAY_SWEEP_INTERVAL_MS = 60_000;

/**
 * NOT-309: parse the staleness bound. Missing/blank/invalid/negative values
 * fall back to the default; `0` disables expiry.
 */
export function resolveLiveDisplayStaleMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_LIVE_DISPLAY_STALE_MS;
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return DEFAULT_LIVE_DISPLAY_STALE_MS;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_LIVE_DISPLAY_STALE_MS;
  }
  return Math.floor(parsed);
}

export type LiveDisplayRegistryOptions = {
  /** Clock for staleness checks (tests inject a fake clock). Defaults to Date.now. */
  nowMs?: () => number;
  /** Staleness bound in ms. Defaults to LIVE_DISPLAY_STALE_MS env parsing. */
  staleMs?: number;
};

/**
 * NOT-296: explicit ambiguity-aware workspace match. `single` keeps the one
 * live session's exact display; `multiple` carries every match in
 * deterministic order so the caller can agree on a common deck or stay
 * neutral instead of guessing latest-wins.
 */
export type WorkspaceSessionMatch =
  | { kind: 'none'; entries: [] }
  | { kind: 'single'; entries: [LiveDisplayEntry] }
  | { kind: 'multiple'; entries: LiveDisplayEntry[] };

/** In-memory registry of live MCP session binds (status line reads reality only). */
export class LiveDisplayRegistry {
  private bySessionId = new Map<string, LiveDisplayEntry>();
  private readonly nowMs: () => number;
  private readonly staleMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: LiveDisplayRegistryOptions = {}) {
    this.nowMs = options.nowMs ?? Date.now;
    this.staleMs =
      options.staleMs ?? resolveLiveDisplayStaleMs(process.env[LIVE_DISPLAY_STALE_ENV_VAR]);
  }

  /** Effective staleness bound in ms (`0` disables expiry). */
  getStaleMs(): number {
    return this.staleMs;
  }

  /**
   * NOT-309: staleness probe. An unparseable `lastActivityAt` counts as stale
   * (no writer ever emits one, so there is no liveness to prove).
   */
  isStale(entry: Pick<LiveDisplayEntry, 'lastActivityAt'>, now: number = this.nowMs()): boolean {
    if (this.staleMs === 0) {
      return false;
    }
    const activity = Date.parse(entry.lastActivityAt);
    if (!Number.isFinite(activity)) {
      return true;
    }
    return now - activity > this.staleMs;
  }

  /**
   * NOT-309: drop every entry older than the bound. Returns the removed count.
   * Runs periodically via `startStaleSweep` and lazily on every read, so a
   * killed session stops counting within the bound even if the timer never
   * fires in a test or short-lived process.
   */
  sweepStale(now: number = this.nowMs()): number {
    if (this.staleMs === 0) {
      return 0;
    }
    let removed = 0;
    for (const [sessionId, entry] of this.bySessionId) {
      if (this.isStale(entry, now)) {
        this.bySessionId.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * NOT-309: registry-owned periodic sweep. Returns a stop function; the
   * timer is unref'd so it never holds the backend process open.
   */
  startStaleSweep(intervalMs: number = LIVE_DISPLAY_SWEEP_INTERVAL_MS): () => void {
    this.stopStaleSweep();
    const timer = setInterval(() => {
      this.sweepStale();
    }, intervalMs);
    timer.unref?.();
    this.sweepTimer = timer;
    return () => this.stopStaleSweep();
  }

  stopStaleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  upsert(input: LiveDisplayUpsert): LiveDisplayEntry {
    const existing = this.bySessionId.get(input.mcpSessionId);
    const badge =
      existing?.badge ??
      assignBadge(new Set([...this.bySessionId.values()].map((entry) => entry.badge)));
    // Preserve folder when a later upsert omits it (e.g. init race after bind_workspace).
    const workspaceRoot = input.workspaceRoot?.trim() || existing?.workspaceRoot;
    const entry: LiveDisplayEntry = {
      ...input,
      workspaceRoot,
      clientName: input.clientName ?? existing?.clientName,
      badge,
      lastActivityAt: input.updatedAt,
    };
    this.bySessionId.set(input.mcpSessionId, entry);
    return entry;
  }

  get(mcpSessionId: string): LiveDisplayEntry | undefined {
    this.sweepStale();
    return this.bySessionId.get(mcpSessionId);
  }

  remove(mcpSessionId: string): void {
    this.bySessionId.delete(mcpSessionId);
  }

  touch(mcpSessionId: string, at: string): void {
    const entry = this.bySessionId.get(mcpSessionId);
    if (entry && at > entry.lastActivityAt) {
      entry.lastActivityAt = at;
    }
  }

  list(): LiveDisplayEntry[] {
    // NOT-309: GET /api/scope/bindings reads through here, so expired entries
    // are omitted from that route (never marked `stale: true`).
    this.sweepStale();
    return [...this.bySessionId.values()].sort((a, b) =>
      a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0,
    );
  }

  /**
   * NOT-296: ambiguity-aware workspace lookup. Returns every live session
   * bound at the nearest workspace level (monorepo walk-up) in deterministic
   * `mcpSessionId` order — never a latest-updated-wins guess, so two
   * concurrent sessions in one repository cannot both display whichever deck
   * was updated last.
   */
  resolveWorkspaceSessions(workspaceRoot: string): WorkspaceSessionMatch {
    // NOT-309: killed sessions stop counting within the bound.
    this.sweepStale();
    let current = normalizeWorkspaceRoot(workspaceRoot);
    while (true) {
      const matches: LiveDisplayEntry[] = [];
      for (const entry of this.bySessionId.values()) {
        // Header/auto-bound sessions have no folder — they never match a workspace,
        // so they only appear in the dashboard list, never the per-folder statusline.
        if (!entry.workspaceRoot || normalizeWorkspaceRoot(entry.workspaceRoot) !== current) {
          continue;
        }
        matches.push(entry);
      }
      if (matches.length > 0) {
        matches.sort((a, b) => (a.mcpSessionId < b.mcpSessionId ? -1 : a.mcpSessionId > b.mcpSessionId ? 1 : 0));
        if (matches.length === 1) {
          return { kind: 'single', entries: [matches[0]] };
        }
        return { kind: 'multiple', entries: matches };
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return { kind: 'none', entries: [] };
  }
}
