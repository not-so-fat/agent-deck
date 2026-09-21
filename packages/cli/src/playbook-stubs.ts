import { getCliPackageRoot } from './paths';

export type StubSyncResult = {
  cursor: { created: number; updated: number; removed: number; dir: string };
  claude: { created: number; updated: number; removed: number; dirs: string[] };
};

export type LegacyStubCleanupResult = {
  cursor: { removed: number; dir: string };
  claude: { removed: number; dirs: string[] };
  removedPaths: string[];
};

function loadStubSyncModule(): {
  syncPlaybookStubs: (
    workspaceRoot: string,
    playbooks: Array<{ id: string; title: string; triggers: string[] }>,
    options?: { cursor?: boolean; claude?: boolean },
  ) => StubSyncResult;
  readUseManifest: (workspaceRoot: string) => {
    version: 3;
    deckId: string;
    deckName: string;
    mcpUrl?: string;
  } | null;
  readLegacyUseManifestV1: (workspaceRoot: string) => {
    version: 1;
    deckId: string;
    deckName: string;
    mcpUrl: string;
    updatedAt: string;
  } | null;
  writeUseManifest: (
    workspaceRoot: string,
    manifest: {
      version: 3;
      deckId: string;
      deckName: string;
      mcpUrl?: string;
    },
  ) => string;
  removeLegacyPlaybookStubs: (
    workspaceRoot: string,
    options?: { cursor?: boolean; claude?: boolean },
  ) => LegacyStubCleanupResult;
  isManagedStubContent: (content: string) => boolean;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(require.resolve('@agent-deck/backend/playbooks/stub-sync', {
    paths: [getCliPackageRoot()],
  }));
}

const stubSync = loadStubSyncModule();

export const syncPlaybookStubs = stubSync.syncPlaybookStubs;
export const readUseManifest = stubSync.readUseManifest;
export const readLegacyUseManifestV1 = stubSync.readLegacyUseManifestV1;
export const writeUseManifest = stubSync.writeUseManifest;
export const removeLegacyPlaybookStubs = stubSync.removeLegacyPlaybookStubs;
export const isManagedStubContent = stubSync.isManagedStubContent;

/**
 * User-facing migration note for the NOT-208 one-time cleanup. Returns null
 * when nothing was removed so callers stay quiet on already-migrated
 * workspaces.
 */
export function formatLegacyStubCleanupMessage(cleanup: LegacyStubCleanupResult): string | null {
  const total = cleanup.cursor.removed + cleanup.claude.removed;
  if (total === 0) {
    return null;
  }
  const parts = [`${total} legacy playbook stub(s)`];
  if (cleanup.cursor.removed > 0) {
    parts.push(`cursor -${cleanup.cursor.removed}`);
  }
  if (cleanup.claude.removed > 0) {
    parts.push(`claude -${cleanup.claude.removed}`);
  }
  return (
    `Removed ${parts.join(', ')} managed by Agent Deck` +
    ' — playbooks are now discovered at runtime via get_bound_deck/get_playbook, no manual cleanup needed.'
  );
}
