import { z } from 'zod';

export const AgentSessionModeSchema = z.enum(['normal', 'agent-admin']);

export const TrustedSessionErrorCodeSchema = z.enum([
  'GRANT_REQUIRED',
  'SESSION_INVALID',
  'SESSION_REVOKED',
  'WORKSPACE_SCOPE_MISMATCH',
  'RESOURCE_OUT_OF_SCOPE',
  'ADMIN_REQUIRED',
  'DASHBOARD_REQUIRED',
  'ADMIN_CHALLENGE_EXPIRED',
]);

export const WorkspaceGrantStatusSchema = z.enum(['pending', 'active', 'revoked']);

export const RuntimeSessionSchema = z
  .object({
    sessionId: z.string(),
    mcpSessionId: z.string().optional(),
    workspaceKey: z.string(),
    workspaceGrantId: z.string(),
    deckId: z.string(),
    mode: AgentSessionModeSchema,
    lastSeenAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    adminExpiresAt: z.string().datetime().nullable(),
  })
  .strict();

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

export const RedactedSessionBindingSchema = z
  .object({
    sessionId: z.string(),
    workspaceKey: z.string(),
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
    case 'WORKSPACE_SCOPE_MISMATCH':
    case 'RESOURCE_OUT_OF_SCOPE':
    case 'ADMIN_REQUIRED':
    case 'DASHBOARD_REQUIRED':
      return 403;
    case 'ADMIN_CHALLENGE_EXPIRED':
      return 410;
    default:
      return 500;
  }
}
