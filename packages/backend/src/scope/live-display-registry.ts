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

/** In-memory registry of live MCP session binds (status line reads reality only). */
export class LiveDisplayRegistry {
  private bySessionId = new Map<string, LiveDisplayEntry>();

  upsert(input: LiveDisplayUpsert): LiveDisplayEntry {
    const existing = this.bySessionId.get(input.mcpSessionId);
    const badge =
      existing?.badge ??
      assignBadge(new Set([...this.bySessionId.values()].map((entry) => entry.badge)));
    const entry: LiveDisplayEntry = {
      ...input,
      clientName: input.clientName ?? existing?.clientName,
      badge,
      lastActivityAt: input.updatedAt,
    };
    this.bySessionId.set(input.mcpSessionId, entry);
    return entry;
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

  /** Nearest workspace bind walking up from workspaceRoot (monorepo walk-up). */
  findForWorkspace(workspaceRoot: string): LiveDisplayEntry | null {
    let current = normalizeWorkspaceRoot(workspaceRoot);
    while (true) {
      let best: LiveDisplayEntry | null = null;
      for (const entry of this.bySessionId.values()) {
        // Header/auto-bound sessions have no folder — they never match a workspace,
        // so they only appear in the dashboard list, never the per-folder statusline.
        if (!entry.workspaceRoot || normalizeWorkspaceRoot(entry.workspaceRoot) !== current) {
          continue;
        }
        if (!best || entry.updatedAt > best.updatedAt) {
          best = entry;
        }
      }
      if (best) {
        return best;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return null;
  }
}
