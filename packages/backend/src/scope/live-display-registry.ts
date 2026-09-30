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
