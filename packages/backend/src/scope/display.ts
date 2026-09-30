import path from 'node:path';
import {
  DeckDisplay,
  DeckDisplaySource,
  type DeckCardCounts,
  countDeckCards,
  formatAmbiguousSessionDisplayLine,
  formatDisplayLine,
  normalizeWorkspaceRoot,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { readUseManifest } from '../playbooks/stub-sync';
import { LiveDisplayEntry, LiveDisplayRegistry } from './live-display-registry';

const EMPTY_COUNTS = { mcp: 0, credentials: 0, playbooks: 0 };
const DEFAULT_MCP_PORT = 1110;

export type ResolveDeckDisplayInput = {
  workspaceRoot: string;
};

async function isMcpServerUp(): Promise<boolean> {
  const host = process.env.AGENT_DECK_HOST?.trim() || '127.0.0.1';
  const parsed = Number.parseInt(process.env.AGENT_DECK_MCP_PORT ?? '', 10);
  const port = Number.isFinite(parsed) ? parsed : DEFAULT_MCP_PORT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { service?: string };
    return body.service === 'agent-deck-mcp-server';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function buildDisplay(
  input: ResolveDeckDisplayInput,
  source: DeckDisplaySource,
  deck: {
    id: string;
    name: string;
    services?: Array<{ type?: string }>;
    credentials?: unknown[];
    playbooks?: unknown[];
  } | null,
  options?: {
    agentDeckOnline?: boolean;
    mcpOnline?: boolean;
    updatedAt?: string;
    liveDeckName?: string | null;
    liveDeckId?: string | null;
    liveCardCounts?: typeof EMPTY_COUNTS;
    liveBadge?: string;
  },
): DeckDisplay {
  const agentDeckOnline = options?.agentDeckOnline ?? true;
  const mcpOnline = options?.mcpOnline ?? true;
  const cardCounts = deck ? countDeckCards(deck) : options?.liveCardCounts ?? EMPTY_COUNTS;
  const deckName = deck?.name ?? options?.liveDeckName ?? null;
  const deckId = deck?.id ?? null;
  const updatedAt = options?.updatedAt;
  // NOT-233: same composition as get_session_binding.display_summary — the
  // override marker follows the id comparison against the saved workspace
  // default (use.json), never the display names. The flag stays explicit so
  // a stale default name after a deck rename cannot imply an override.
  const workspaceDefault = readNearestUseManifest(input.workspaceRoot);
  const activeDeckId = deck?.id ?? options?.liveDeckId ?? null;
  const sessionOverride = Boolean(
    workspaceDefault && activeDeckId && workspaceDefault.deckId !== activeDeckId,
  );

  return {
    workspaceRoot: input.workspaceRoot,
    deckId,
    deckName,
    source,
    cardCounts,
    agentDeckOnline,
    mcpOnline,
    updatedAt,
    displayLine: formatDisplayLine(deckName, cardCounts, {
      offline: !agentDeckOnline,
      mcpOffline: agentDeckOnline && !mcpOnline,
      updatedAt,
      badge: options?.liveBadge,
      workspaceDefaultName: workspaceDefault?.deckName ?? null,
      sessionOverride,
    }),
  };
}

/**
 * NOT-233: refresh the statusline data source after a deck-switch approval
 * commits. The commit rebinds the runtime session in the database, but the
 * live-display entry the statusline reads still names the previous deck —
 * refresh it to the newly-active deck so the next statusline render names it.
 * Only an already-live session is touched (no presence is created), and the
 * entry's folder, badge, client, and source are preserved; the bumped
 * timestamp keeps the switched session most-recent for its workspace.
 * Returns true when an entry was refreshed.
 */
export function refreshLiveDisplayAfterDeckSwitch(
  registry: LiveDisplayRegistry,
  input: {
    mcpSessionId?: string;
    deckId: string;
    deckName: string;
    cardCounts: DeckCardCounts;
    workspaceRoot?: string;
    updatedAt: string;
  },
): boolean {
  const mcpSessionId = input.mcpSessionId?.trim();
  if (!mcpSessionId) {
    return false;
  }
  const existing = registry.get(mcpSessionId);
  if (!existing) {
    return false;
  }
  registry.upsert({
    mcpSessionId,
    workspaceRoot: existing.workspaceRoot ?? input.workspaceRoot,
    deckId: input.deckId,
    deckName: input.deckName,
    source: existing.source,
    clientName: existing.clientName,
    cardCounts: input.cardCounts,
    updatedAt: input.updatedAt,
  });
  return true;
}

/**
 * NOT-296: nearest saved workspace default (`use.json` walk-up). Hosts such
 * as Cursor report only the cwd (e.g. `/repo/pkg`) while the assignment file
 * lives at the repository root (`/repo`), so the exact-level read alone
 * would miss it and either fall back to a stale `deck_workspaces` row or
 * miscompute the id-based override flag. The nearest manifest found walking
 * toward the filesystem root wins; absent everywhere yields null.
 */
function readNearestUseManifest(workspaceRoot: string): { deckId: string; deckName: string } | null {
  let current = normalizeWorkspaceRoot(workspaceRoot);
  while (true) {
    const manifest = readUseManifest(current);
    if (manifest) {
      return manifest;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * NOT-296: effective-deck identity of one live entry for agreement checks.
 * Two entries agree only on the same deck id and the same id-based override
 * meaning against the saved workspace default — any doubt stays neutral
 * instead of guessing. The bind source (`launch` vs `session_override` vs
 * `env`) is deliberately excluded: a launched session and a
 * `bind_workspace` session on the same deck with the same override meaning
 * are one effective deck, not an ambiguity.
 */
function liveEntryIdentity(
  entry: LiveDisplayEntry,
  workspaceDefaultDeckId: string | null,
): { deckId: string; sessionOverride: boolean } {
  return {
    deckId: entry.deckId,
    sessionOverride: Boolean(
      workspaceDefaultDeckId && workspaceDefaultDeckId !== entry.deckId,
    ),
  };
}

async function resolveMultiSessionDisplay(
  input: ResolveDeckDisplayInput,
  db: DatabaseManager,
  entries: LiveDisplayEntry[],
): Promise<DeckDisplay> {
  const workspaceDefault = readNearestUseManifest(input.workspaceRoot);
  const first = liveEntryIdentity(entries[0], workspaceDefault?.deckId ?? null);
  const agree = entries.every((entry) => {
    const identity = liveEntryIdentity(entry, workspaceDefault?.deckId ?? null);
    return (
      identity.deckId === first.deckId && identity.sessionOverride === first.sessionOverride
    );
  });

  if (!agree) {
    return {
      workspaceRoot: input.workspaceRoot,
      deckId: null,
      deckName: null,
      source: 'unbound',
      cardCounts: { ...EMPTY_COUNTS },
      agentDeckOnline: true,
      mcpOnline: true,
      displayLine: formatAmbiguousSessionDisplayLine(),
    };
  }

  // Agreement: name the common deck with a session count. Counts come from
  // the database (deterministic and fresh); the deterministic-order first
  // entry is only a fallback when the deck row is gone. The reported source
  // is the deterministic-order first entry's — it never reaches the
  // displayLine, which carries only the common deck, the session count, and
  // the shared override meaning. No badge or updatedAt is shown — either
  // would single out one session.
  const deck = await db.getDeck(first.deckId);
  const cardCounts = deck ? countDeckCards(deck) : { ...entries[0].cardCounts };
  const deckName = deck?.name ?? entries[0].deckName;
  return {
    workspaceRoot: input.workspaceRoot,
    deckId: deck?.id ?? first.deckId,
    deckName,
    source: entries[0].source,
    cardCounts,
    agentDeckOnline: true,
    mcpOnline: true,
    displayLine: formatDisplayLine(deckName, cardCounts, {
      sessionCount: entries.length,
      workspaceDefaultName: workspaceDefault?.deckName ?? null,
      sessionOverride: first.sessionOverride,
    }),
  };
}

type SavedWorkspaceDeck = {
  id: string;
  name: string;
  services?: Array<{ type?: string }>;
  credentials?: unknown[];
  playbooks?: unknown[];
};

/**
 * NOT-296: saved assignment for a workspace with no live session. The
 * `use.json` assignment file is the source of truth: the nearest manifest
 * found walking toward the filesystem root wins (hosts such as Cursor
 * report only the cwd, e.g. `/repo/pkg`, while the file lives at `/repo`),
 * and it is trusted absolutely — when its deck row is gone the result is
 * unbound, never an unrelated `deck_workspaces` row. The database
 * stub-sync registry (`deck_workspaces`, which only records folders that
 * received stub syncs and is never touched by workspace-default switches)
 * is consulted only when no manifest exists at any level.
 */
async function resolveSavedWorkspaceDeck(
  workspaceRoot: string,
  db: DatabaseManager,
): Promise<SavedWorkspaceDeck | null> {
  const manifest = readNearestUseManifest(workspaceRoot);
  if (manifest) {
    // Trusted absolutely: a manifest pointing at a deleted deck resolves to
    // unbound (null) rather than falling through to an unrelated row.
    return (await db.getDeck(manifest.deckId)) ?? null;
  }

  const seen = new Set<string>();
  const candidates = [workspaceRoot.trim(), normalizeWorkspaceRoot(workspaceRoot)];
  let current: string | undefined;
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    const deckId = await db.getLatestDeckIdForWorkspace(candidate);
    if (deckId) {
      const deck = await db.getDeck(deckId);
      if (deck) {
        return deck;
      }
    }
  }
  current = normalizeWorkspaceRoot(workspaceRoot);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    const deckId = await db.getLatestDeckIdForWorkspace(current);
    if (deckId) {
      const deck = await db.getDeck(deckId);
      if (deck) {
        return deck;
      }
    }
  }
  return null;
}

/** Resolve bound-deck display from live MCP sessions, falling back to an explicitly labeled workspace default. */
export async function resolveDeckDisplay(
  input: ResolveDeckDisplayInput,
  db: DatabaseManager,
  registry: LiveDisplayRegistry,
): Promise<DeckDisplay> {
  const normalizedRoot = input.workspaceRoot.trim();
  const match = registry.resolveWorkspaceSessions(normalizedRoot);
  if (match.kind === 'single') {
    const live = match.entries[0];
    const deck = await db.getDeck(live.deckId);
    return buildDisplay({ workspaceRoot: normalizedRoot }, live.source, deck, {
      mcpOnline: true,
      updatedAt: live.updatedAt,
      liveDeckName: live.deckName,
      liveDeckId: live.deckId,
      liveCardCounts: live.cardCounts,
      liveBadge: live.badge,
    });
  }
  if (match.kind === 'multiple') {
    return resolveMultiSessionDisplay({ workspaceRoot: normalizedRoot }, db, match.entries);
  }

  const mcpOnline = await isMcpServerUp();
  const saved = await resolveSavedWorkspaceDeck(normalizedRoot, db);
  if (saved) {
    const cardCounts = countDeckCards(saved);
    return {
      workspaceRoot: normalizedRoot,
      deckId: saved.id,
      deckName: saved.name,
      source: 'unbound',
      cardCounts,
      agentDeckOnline: true,
      mcpOnline,
      displayLine: formatDisplayLine(saved.name, cardCounts, {
        mcpOffline: !mcpOnline,
        workspaceDefault: true,
      }),
    };
  }

  return buildDisplay({ workspaceRoot: normalizedRoot }, 'unbound', null, { mcpOnline });
}
