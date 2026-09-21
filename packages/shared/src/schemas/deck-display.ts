import { z } from 'zod';
import path from 'node:path';

export const DeckDisplaySourceSchema = z.enum([
  'launch',
  'session_override',
  'env',
  'unbound',
]);

export const DeckCardCountsSchema = z.object({
  mcp: z.number().int().min(0),
  credentials: z.number().int().min(0),
  playbooks: z.number().int().min(0),
});

export const LiveBindingSchema = z.object({
  badge: z.string().min(1),
  deckId: z.string().uuid(),
  deckName: z.string().min(1),
  source: DeckDisplaySourceSchema.exclude(['unbound']),
  // Absent for header/auto-bound sessions (deck without a known folder).
  workspaceRoot: z.string().min(1).optional(),
  clientName: z.string().min(1).optional(),
  mode: z.enum(['normal', 'agent-admin']).optional(),
  cardCounts: DeckCardCountsSchema,
  updatedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
});

export const DeckDisplaySchema = z.object({
  workspaceRoot: z.string(),
  deckId: z.string().uuid().nullable(),
  deckName: z.string().nullable(),
  source: DeckDisplaySourceSchema,
  cardCounts: DeckCardCountsSchema,
  oauthWarningCount: z.number().int().min(0).optional(),
  agentDeckOnline: z.boolean(),
  mcpOnline: z.boolean().optional(),
  updatedAt: z.string().datetime().optional(),
  displayLine: z.string(),
});

export const StatusLinePayloadSchema = z.object({
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  workspace: z
    .object({
      current_dir: z.string().optional(),
      project_dir: z.string().optional(),
    })
    .optional(),
});

export type DeckDisplaySource = z.infer<typeof DeckDisplaySourceSchema>;
export type DeckCardCounts = z.infer<typeof DeckCardCountsSchema>;

/**
 * Where the active deck for a session comes from (NOT-211).
 * `session` = session-only override that differs from the saved workspace
 * default (compared by deck id); `workspace` = following the saved workspace
 * default (or nothing overriding it); `launch` = launch-selected deck with no
 * saved default.
 */
export const BindingActiveSourceSchema = z.enum(['session', 'workspace', 'launch']);

export type BindingActiveSource = z.infer<typeof BindingActiveSourceSchema>;

export const DeckListEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  isActive: z.boolean(),
  cardCounts: DeckCardCountsSchema,
  workspaceCount: z.number().int().nonnegative().optional(),
});

export type DeckListEntry = z.infer<typeof DeckListEntrySchema>;
export type LiveBinding = z.infer<typeof LiveBindingSchema>;
export const PendingAdminChallengeSchema = z.object({
  challengeId: z.string().min(1),
  runtimeSessionId: z.string().min(1),
  deckId: z.string().uuid(),
  deckName: z.string().min(1).optional(),
  expiresAt: z.string().datetime(),
  approvalPath: z.string().min(1),
});

export type PendingAdminChallenge = z.infer<typeof PendingAdminChallengeSchema>;
export type DeckDisplay = z.infer<typeof DeckDisplaySchema>;
export type StatusLinePayload = z.infer<typeof StatusLinePayloadSchema>;

export const DISPLAY_LINE_MAX_LENGTH = 120;

export function countDeckCards(deck: {
  services?: Array<{ type?: string }>;
  credentials?: unknown[];
  playbooks?: unknown[];
}): DeckCardCounts {
  const services = deck.services ?? [];
  return {
    mcp: services.filter((service) => service.type === 'mcp').length,
    credentials: deck.credentials?.length ?? 0,
    playbooks: deck.playbooks?.length ?? 0,
  };
}

export function formatDisplayUpdatedSuffix(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return ` (updated ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())})`;
}

export type DisplayLineOptions = {
  offline?: boolean;
  mcpOffline?: boolean;
  updatedAt?: string;
  badge?: string;
  /**
   * Saved workspace-default deck name (NOT-211). The override marker is
   * decided by `sessionOverride` when defined (id-based decision made by the
   * caller); otherwise it falls back to the name comparison, so callers that
   * do not need override detail keep the existing one-line shape.
   */
  workspaceDefaultName?: string | null;
  /**
   * Explicit id-based override decision (NOT-211 repair). When defined it wins
   * over the name comparison: `true` shows the marker even if the names match
   * (same-name/different-id is a real override), `false` hides it even if the
   * saved file name is stale after a deck rename.
   */
  sessionOverride?: boolean;
};

export const SESSION_OVERRIDE_MARKER_PREFIX = ' · session (default ';
export const SESSION_OVERRIDE_MARKER_SUFFIX = ')';

/**
 * Decide which workspace-default name to show in the session-override marker
 * (NOT-211). Returns null when there is no override: no active deck, no saved
 * default, or — when the caller leaves `sessionOverride` undefined — active
 * and default names match.
 */
function resolveSessionOverrideDefault(
  deckName: string | null,
  workspaceDefaultName?: string | null,
  sessionOverride?: boolean,
): string | null {
  const active = deckName?.trim();
  const fallback = workspaceDefaultName?.trim();
  if (!active || !fallback) {
    return null;
  }
  if (sessionOverride !== undefined) {
    return sessionOverride ? fallback : null;
  }
  return active === fallback ? null : fallback;
}

function boundDisplayLine(line: string): string {
  return line.length > DISPLAY_LINE_MAX_LENGTH ? line.slice(0, DISPLAY_LINE_MAX_LENGTH) : line;
}

export function formatDisplayLine(
  deckName: string | null,
  counts: DeckCardCounts,
  options?: DisplayLineOptions,
): string {
  const prefix = '◆ ';
  const updatedSuffix = options?.updatedAt ? formatDisplayUpdatedSuffix(options.updatedAt) : '';

  if (options?.offline) {
    const offlineLine = `${prefix}Agent Deck offline${updatedSuffix}`;
    return offlineLine.length > DISPLAY_LINE_MAX_LENGTH
      ? offlineLine.slice(0, DISPLAY_LINE_MAX_LENGTH)
      : offlineLine;
  }

  if (!deckName) {
    const unboundLine = `${prefix}Unbound — bind a deck to use Agent Deck`;
    const withMcp = options?.mcpOffline ? `${unboundLine} · MCP offline` : unboundLine;
    return withMcp.length > DISPLAY_LINE_MAX_LENGTH
      ? withMcp.slice(0, DISPLAY_LINE_MAX_LENGTH)
      : withMcp;
  }

  const countsPart = `${counts.mcp} MCP · ${counts.credentials} keys · ${counts.playbooks} playbooks`;
  const separator = ' · ';
  const badgeSuffix = options?.badge ? ` · ⌘${options.badge}` : '';
  const mcpSuffix = options?.mcpOffline ? ' · MCP offline' : '';
  // Room for the override marker is reserved before truncating the active
  // name, so a real session override stays visible within the budget.
  const overrideDefault = resolveSessionOverrideDefault(
    deckName,
    options?.workspaceDefaultName,
    options?.sessionOverride,
  );
  let marker = '';
  if (overrideDefault !== null) {
    const fullMarker = `${SESSION_OVERRIDE_MARKER_PREFIX}${overrideDefault}${SESSION_OVERRIDE_MARKER_SUFFIX}`;
    const otherFixedLength =
      prefix.length + separator.length + countsPart.length + updatedSuffix.length + mcpSuffix.length + badgeSuffix.length;
    const maxMarkerLength = DISPLAY_LINE_MAX_LENGTH - otherFixedLength - 1;
    if (fullMarker.length <= maxMarkerLength) {
      marker = fullMarker;
    } else {
      const spare = maxMarkerLength - SESSION_OVERRIDE_MARKER_PREFIX.length - SESSION_OVERRIDE_MARKER_SUFFIX.length;
      if (spare >= 2) {
        marker = `${SESSION_OVERRIDE_MARKER_PREFIX}${overrideDefault.slice(0, spare - 1)}…${SESSION_OVERRIDE_MARKER_SUFFIX}`;
      }
    }
  }
  const suffixLength = updatedSuffix.length + mcpSuffix.length + badgeSuffix.length + marker.length;
  const fixedLength = prefix.length + separator.length + countsPart.length + suffixLength;
  const maxNameLength = DISPLAY_LINE_MAX_LENGTH - fixedLength;

  let name = deckName;
  if (maxNameLength < 1) {
    // No room for the active name: drop it, then shrink the marker's default
    // name to fit rather than losing the override entirely.
    const lineless = `${prefix}${countsPart}${badgeSuffix}${mcpSuffix}${updatedSuffix}`;
    if (!marker) {
      return boundDisplayLine(lineless);
    }
    const spare =
      DISPLAY_LINE_MAX_LENGTH -
      (lineless.length + SESSION_OVERRIDE_MARKER_PREFIX.length + SESSION_OVERRIDE_MARKER_SUFFIX.length);
    if (spare < 2) {
      return boundDisplayLine(lineless);
    }
    const shown =
      overrideDefault!.length > spare ? `${overrideDefault!.slice(0, spare - 1)}…` : overrideDefault!;
    return `${lineless}${SESSION_OVERRIDE_MARKER_PREFIX}${shown}${SESSION_OVERRIDE_MARKER_SUFFIX}`;
  }
  if (name.length > maxNameLength) {
    name =
      maxNameLength >= 2
        ? `${name.slice(0, maxNameLength - 1)}…`
        : name.slice(0, Math.max(0, maxNameLength));
  }

  return `${prefix}${name}${separator}${countsPart}${badgeSuffix}${mcpSuffix}${updatedSuffix}${marker}`;
}

/**
 * Append a concise session-override marker to an already-bounded display line
 * (NOT-211). The explicit `sessionOverride` flag (id-based decision) wins over
 * the name comparison when defined; otherwise names are compared as a
 * fallback. Returns the line unchanged when there is no override. The marker
 * is always kept visible within the max length: the default name is truncated
 * first, and as a last resort the base line is shortened to make room.
 */
export function appendSessionOverrideSuffix(
  line: string,
  deckName: string | null,
  workspaceDefaultName?: string | null,
  sessionOverride?: boolean,
): string {
  const fallback = resolveSessionOverrideDefault(deckName, workspaceDefaultName, sessionOverride);
  if (fallback === null) {
    return line;
  }
  const full = `${line}${SESSION_OVERRIDE_MARKER_PREFIX}${fallback}${SESSION_OVERRIDE_MARKER_SUFFIX}`;
  if (full.length <= DISPLAY_LINE_MAX_LENGTH) {
    return full;
  }
  const spare =
    DISPLAY_LINE_MAX_LENGTH -
    (line.length + SESSION_OVERRIDE_MARKER_PREFIX.length + SESSION_OVERRIDE_MARKER_SUFFIX.length);
  if (spare >= 2) {
    return `${line}${SESSION_OVERRIDE_MARKER_PREFIX}${fallback.slice(0, spare - 1)}…${SESSION_OVERRIDE_MARKER_SUFFIX}`;
  }
  const keep =
    DISPLAY_LINE_MAX_LENGTH -
    (SESSION_OVERRIDE_MARKER_PREFIX.length + SESSION_OVERRIDE_MARKER_SUFFIX.length + 2);
  if (keep < 1) {
    return full.slice(0, DISPLAY_LINE_MAX_LENGTH);
  }
  const shortLine = line.length > keep ? `${line.slice(0, Math.max(0, keep - 1))}…` : line;
  const room =
    DISPLAY_LINE_MAX_LENGTH -
    (shortLine.length + SESSION_OVERRIDE_MARKER_PREFIX.length + SESSION_OVERRIDE_MARKER_SUFFIX.length);
  const shown = fallback.length > room ? `${fallback.slice(0, Math.max(0, room - 1))}…` : fallback;
  return `${shortLine}${SESSION_OVERRIDE_MARKER_PREFIX}${shown}${SESSION_OVERRIDE_MARKER_SUFFIX}`;
}

export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return path.resolve(workspaceRoot.trim());
}

export function resolveStatusLineSessionId(payload: StatusLinePayload): string | undefined {
  const sessionId = payload.session_id?.trim();
  return sessionId || undefined;
}

export function resolveStatusLineWorkspace(payload: StatusLinePayload, fallbackCwd?: string): string | undefined {
  const projectDir = payload.workspace?.project_dir?.trim();
  if (projectDir) {
    return normalizeWorkspaceRoot(projectDir);
  }

  const cwd = payload.cwd?.trim() || payload.workspace?.current_dir?.trim() || fallbackCwd?.trim();
  return cwd ? normalizeWorkspaceRoot(cwd) : undefined;
}
