import {
  createAgentRunService,
  type AgentRunService,
  type AgentRunServiceDeps,
} from '../agent-run';
import { resolveDeckRef } from '../lib/deck-resolve';
import type { DatabaseManager } from '../models/database';
import { readUseManifest } from '../playbooks/stub-sync';

/**
 * NOT-480: the NOT-479 run service wired to the backend host. Decks resolve
 * through the backend database; the folder assignment is the `cwd`'s own v3
 * `.agent-deck/use.json`, read-only (the API never rewrites it, and a legacy
 * or missing assignment fails closed as unassigned).
 */
export function createBackendAgentRunService(
  db: DatabaseManager,
  homeDir: string,
  overrides: Partial<AgentRunServiceDeps> = {},
): AgentRunService {
  return createAgentRunService({
    homeDir,
    async resolveDeck(ref) {
      const deck = await resolveDeckRef(db, ref);
      return deck ? { id: deck.id, name: deck.name } : null;
    },
    async resolveDeckBinding(cwd) {
      const manifest = readUseManifest(cwd);
      return manifest ? { deckId: manifest.deckId, deckName: manifest.deckName } : {};
    },
    // NOT-539: pinned runs started from an MCP session (same lookup as the CLI's).
    async resolvePlaybookPin(input) {
      const version = await db.getPlaybookVersion(input.versionId);
      const onDeck = await db.getDeckPlaybooksForDeck(input.deckId);
      return {
        versionPlaybookId: version ? version.playbookId : null,
        playbookOnDeck: onDeck.some((playbook) => playbook.id === input.playbookId),
      };
    },
    ...overrides,
  });
}
