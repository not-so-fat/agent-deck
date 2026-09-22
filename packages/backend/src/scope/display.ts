import {
  DeckDisplay,
  DeckDisplaySource,
  type DeckCardCounts,
  countDeckCards,
  formatDisplayLine,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { readUseManifest } from '../playbooks/stub-sync';
import { LiveDisplayRegistry } from './live-display-registry';

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
  const workspaceDefault = readUseManifest(input.workspaceRoot);
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

/** Resolve bound-deck display from live MCP session registry only (no sidecar/manifest guessing). */
export async function resolveDeckDisplay(
  input: ResolveDeckDisplayInput,
  db: DatabaseManager,
  registry: LiveDisplayRegistry,
): Promise<DeckDisplay> {
  const normalizedRoot = input.workspaceRoot.trim();
  const live = registry.findForWorkspace(normalizedRoot);
  const mcpOnline = live ? true : await isMcpServerUp();
  if (live) {
    const deck = await db.getDeck(live.deckId);
    return buildDisplay({ workspaceRoot: normalizedRoot }, live.source, deck, {
      mcpOnline,
      updatedAt: live.updatedAt,
      liveDeckName: live.deckName,
      liveDeckId: live.deckId,
      liveCardCounts: live.cardCounts,
      liveBadge: live.badge,
    });
  }

  return buildDisplay({ workspaceRoot: normalizedRoot }, 'unbound', null, { mcpOnline });
}
