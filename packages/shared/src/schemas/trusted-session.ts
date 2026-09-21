import { z } from 'zod';

export const AgentSessionModeSchema = z.enum(['normal', 'agent-admin']);

export const TrustedSessionErrorCodeSchema = z.enum([
  'GRANT_REQUIRED',
  'SESSION_INVALID',
  'SESSION_REVOKED',
  'RESOURCE_OUT_OF_SCOPE',
  'ADMIN_REQUIRED',
  'DASHBOARD_REQUIRED',
  'ADMIN_CHALLENGE_EXPIRED',
  /** Launch-selected deck cannot be changed by the agent (NOT-105). */
  'DECK_FIXED',
  /** Bound session must request a human-approved switch via switch_deck (NOT-214). */
  'SWITCH_APPROVAL_REQUIRED',
  /** Deck-switch request past its TTL (NOT-207). */
  'DECK_SWITCH_EXPIRED',
  /** Deck-switch request already resolved; repeat resolution is a no-op (NOT-207). */
  'DECK_SWITCH_CONSUMED',
]);

/** @deprecated Legacy v2 grant file shape — CLI reads for migration only (NOT-108). */
export const WorkspaceGrantStatusSchema = z.enum(['pending', 'active', 'revoked']);

export const RuntimeSessionSchema = z
  .object({
    sessionId: z.string(),
    mcpSessionId: z.string().optional(),
    deckId: z.string(),
    mode: AgentSessionModeSchema,
    lastSeenAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    adminExpiresAt: z.string().datetime().nullable(),
  })
  .strict();

/** Legacy v2 grant manifest — CLI assignment migration only. */
export const WorkspaceGrantManifestSchema = z
  .object({
    version: z.literal(2),
    workspaceKey: z.string(),
    grantId: z.string(),
    secret: z.string().min(32),
    deckId: z.string(),
    deckName: z.string().optional(),
    mcpUrl: z.string().url().optional(),
    store: z.enum(['file', 'keychain']).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

/** Alias so CLI source can avoid the legacy "grant" name (NOT-50 wording sweep). */
export const WorkspaceV2ManifestSchema = WorkspaceGrantManifestSchema;

/** Plain folder→deck assignment (NOT-108). No secret. */
export const WorkspaceAssignmentSchema = z
  .object({
    version: z.literal(3),
    deckId: z.string().min(1),
    deckName: z.string().min(1),
    mcpUrl: z.string().url().optional(),
  })
  .strict();

export const RedactedSessionBindingSchema = z
  .object({
    sessionId: z.string(),
    deckId: z.string(),
    deckName: z.string().optional(),
    mode: AgentSessionModeSchema,
    expiresAt: z.string().datetime(),
    adminExpiresAt: z.string().datetime().nullable().optional(),
    display_summary: z.string().optional(),
  })
  .strict();

export type AgentSessionMode = z.infer<typeof AgentSessionModeSchema>;
export type TrustedSessionErrorCode = z.infer<typeof TrustedSessionErrorCodeSchema>;
export type WorkspaceGrantStatus = z.infer<typeof WorkspaceGrantStatusSchema>;
export type RuntimeSession = z.infer<typeof RuntimeSessionSchema>;
export type WorkspaceGrantManifest = z.infer<typeof WorkspaceGrantManifestSchema>;
export type WorkspaceAssignment = z.infer<typeof WorkspaceAssignmentSchema>;
export type RedactedSessionBinding = z.infer<typeof RedactedSessionBindingSchema>;

export type TrustedSessionErrorBody = {
  success: false;
  error: string;
  error_code: TrustedSessionErrorCode;
};

export function trustedSessionError(
  code: TrustedSessionErrorCode,
  message: string,
): TrustedSessionErrorBody {
  return { success: false, error: message, error_code: code };
}

export function httpStatusForTrustedError(code: TrustedSessionErrorCode): number {
  switch (code) {
    case 'GRANT_REQUIRED':
    case 'SESSION_INVALID':
    case 'SESSION_REVOKED':
      return 401;
    case 'RESOURCE_OUT_OF_SCOPE':
    case 'ADMIN_REQUIRED':
    case 'DASHBOARD_REQUIRED':
    case 'DECK_FIXED':
    case 'SWITCH_APPROVAL_REQUIRED':
      return 403;
    case 'DECK_SWITCH_CONSUMED':
      return 409;
    case 'ADMIN_CHALLENGE_EXPIRED':
    case 'DECK_SWITCH_EXPIRED':
      return 410;
    default:
      return 500;
  }
}

/**
 * Human approval scope for a deck-switch request (NOT-207).
 * Exactly three decisions exist: rebind this session only, rebind the
 * session and the workspace default, or decline.
 */
export const DeckSwitchDecisionSchema = z.enum(['session', 'workspace-default', 'decline']);

export type DeckSwitchDecision = z.infer<typeof DeckSwitchDecisionSchema>;

/** Approval request body for resolving one opaque deck-switch request. */
export const DeckSwitchResolveBodySchema = z
  .object({
    runtimeSessionId: z.string().min(1),
    decision: DeckSwitchDecisionSchema,
  })
  .strict();

export type DeckSwitchResolveBody = z.infer<typeof DeckSwitchResolveBodySchema>;

/** Successful resolution result for a deck-switch request. */
export const DeckSwitchResolutionSchema = z
  .object({
    requestId: z.string(),
    decision: DeckSwitchDecisionSchema,
    status: z.enum(['consumed', 'declined']),
    deckId: z.string().optional(),
    deckName: z.string().optional(),
    workspaceRoot: z.string().optional(),
  })
  .strict();

export type DeckSwitchResolution = z.infer<typeof DeckSwitchResolutionSchema>;
