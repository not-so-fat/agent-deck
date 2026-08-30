/** Activity age for live session rows — mirrors menubar CLI formatting. */
export function formatActivityAge(lastActivityAt: string, now: Date): string {
  const then = new Date(lastActivityAt).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

export function truncateDeckName(name: string, max = 24): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

export function workspaceBasename(workspaceRoot: string): string {
  const trimmed = workspaceRoot.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Live MCP session count per deck id (from GET /api/scope/bindings). */
export function countSessionsByDeckId(
  bindings: Array<{ deckId: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of bindings) {
    counts.set(row.deckId, (counts.get(row.deckId) ?? 0) + 1);
  }
  return counts;
}

/** Subtitle under deck name in My Decks — cards plus optional live session count. */
export function formatDeckListSubtitle(cardCount: number, sessionCount: number): string {
  const cards = cardCount > 0 ? `${cardCount} cards` : 'Empty';
  if (sessionCount <= 0) {
    return cards;
  }
  const sessions =
    sessionCount === 1 ? '1 session' : `${sessionCount} sessions`;
  return `${cards}, ${sessions}`;
}

export function sessionModeLabel(mode: LiveBinding['mode']): string {
  if (mode === 'agent-admin') {
    return 'admin';
  }
  if (mode === 'normal') {
    return 'normal';
  }
  return 'unknown';
}

export function sessionModeClass(mode: LiveBinding['mode']): string {
  if (mode === 'agent-admin') {
    return 'bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40';
  }
  if (mode === 'normal') {
    return 'bg-white/10 text-gray-300 ring-1 ring-white/10';
  }
  return 'bg-white/10 text-gray-300';
}

type LiveSessionGroup = {
  key: string;
  label: string;
  isWorkspaceGroup: boolean;
  rows: LiveBinding[];
};

/** Group live bindings by workspace; coalesce no-folder rows into a sibling workspace group. */
export function groupLiveBindings(bindings: LiveBinding[]): LiveSessionGroup[] {
  const workspaceGroups = new Map<
    string,
    { label: string; rows: LiveBinding[]; deckIds: Set<string> }
  >();
  const orphans: LiveBinding[] = [];
  const deckOnlyGroups = new Map<string, { label: string; rows: LiveBinding[] }>();

  for (const row of bindings) {
    if (row.workspaceRoot) {
      const key = row.workspaceRoot;
      const label = `${workspaceBasename(row.workspaceRoot)}/`;
      const group = workspaceGroups.get(key) ?? { label, rows: [], deckIds: new Set<string>() };
      group.rows.push(row);
      group.deckIds.add(row.deckId);
      workspaceGroups.set(key, group);
      continue;
    }
    orphans.push(row);
  }

  for (const orphan of orphans) {
    let attached = false;
    for (const group of workspaceGroups.values()) {
      if (group.deckIds.has(orphan.deckId)) {
        group.rows.push(orphan);
        attached = true;
        break;
      }
    }
    if (attached) {
      continue;
    }
    const key = `deck:${orphan.deckId}`;
    const label = `◆ ${truncateDeckName(orphan.deckName)}`;
    const group = deckOnlyGroups.get(key) ?? { label, rows: [] };
    group.rows.push(orphan);
    deckOnlyGroups.set(key, group);
  }

  const groups: LiveSessionGroup[] = [
    ...[...workspaceGroups.entries()].map(([key, { label, rows }]) => ({
      key,
      label,
      isWorkspaceGroup: true,
      rows: [...rows].sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1)),
    })),
    ...[...deckOnlyGroups.entries()].map(([key, { label, rows }]) => ({
      key,
      label,
      isWorkspaceGroup: false,
      rows: [...rows].sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1)),
    })),
  ];

  return groups.sort((a, b) => a.label.localeCompare(b.label));
}

export function liveSessionRowSubtitle(
  row: LiveBinding,
  options: {
    isWorkspaceGroup: boolean;
    highlighted: boolean;
    clientMeta: string;
  },
): string {
  const { isWorkspaceGroup, highlighted, clientMeta } = options;
  if (!row.workspaceRoot && isWorkspaceGroup) {
    return `no folder · ${clientMeta}`;
  }
  if (isWorkspaceGroup && highlighted) {
    return clientMeta;
  }
  if (isWorkspaceGroup) {
    return `${truncateDeckName(row.deckName)} · ${clientMeta}`;
  }
  return clientMeta;
}
