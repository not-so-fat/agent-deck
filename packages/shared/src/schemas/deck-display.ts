import { z } from 'zod';
import path from 'node:path';

export const DeckDisplaySourceSchema = z.enum([
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

export const DeckListEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  isActive: z.boolean(),
  cardCounts: DeckCardCountsSchema,
  workspaceCount: z.number().int().nonnegative().optional(),
});

export type DeckListEntry = z.infer<typeof DeckListEntrySchema>;
export type LiveBinding = z.infer<typeof LiveBindingSchema>;
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

export function formatDisplayLine(
  deckName: string | null,
  counts: DeckCardCounts,
  options?: { offline?: boolean; mcpOffline?: boolean; updatedAt?: string; badge?: string },
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
  const suffixLength = updatedSuffix.length + mcpSuffix.length + badgeSuffix.length;
  const fixedLength = prefix.length + separator.length + countsPart.length + suffixLength;
  const maxNameLength = DISPLAY_LINE_MAX_LENGTH - fixedLength;

  let name = deckName;
  if (maxNameLength < 1) {
    const line = `${prefix}${countsPart}${badgeSuffix}${mcpSuffix}${updatedSuffix}`;
    return line.length > DISPLAY_LINE_MAX_LENGTH ? line.slice(0, DISPLAY_LINE_MAX_LENGTH) : line;
  }
  if (name.length > maxNameLength) {
    name = `${name.slice(0, Math.max(1, maxNameLength - 1))}…`;
  }

  const line = `${prefix}${name}${separator}${countsPart}${badgeSuffix}${mcpSuffix}${updatedSuffix}`;
  return line.length > DISPLAY_LINE_MAX_LENGTH ? line.slice(0, DISPLAY_LINE_MAX_LENGTH) : line;
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
