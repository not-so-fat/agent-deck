/**
 * Trusted unattended execution contract types (NOT-85).
 * Authoritative design: docs/superpowers/specs/2026-09-12-trusted-unattended-execution-contract-design.md
 *
 * Interactive workspace grants remain separate (PRD_TRUSTED_AGENT_SESSIONS).
 */

export type EnrollmentStatus = 'active' | 'revoked';
export type AuthorityStatus = 'live' | 'expired' | 'revoked';
export type AuthorityAudience = 'dealer-worker';

export type ContractErrorCode =
  | 'GRANT_REQUIRED'
  | 'AUTHORITY_EXPIRED'
  | 'AUTHORITY_REVOKED'
  | 'AUTHORITY_UNKNOWN'
  | 'AUTHORITY_SECRET_INVALID'
  | 'RESOURCE_OUT_OF_SCOPE'
  | 'INTERACTION_REQUIRED'
  | 'ENROLLMENT_REVOKED'
  | 'COORDINATOR_NOT_ENROLLED'
  | 'IDEMPOTENCY_KEY_CONFLICT'
  | 'INVALID_MINT_REQUEST'
  | 'AUDIENCE_MISMATCH';

/** Fine-grained cause when one error_code covers multiple recovery paths. */
export type ContractErrorReason =
  | 'deck_not_permitted'
  | 'tool_not_in_snapshot'
  | 'enrollment_revoked'
  | 'explicit_revoke'
  | 'params_mismatch'
  | 'ttl_non_positive';

export type AuditEventKind =
  | 'enrollment_created'
  | 'enrollment_revoked'
  | 'authority_minted'
  | 'authority_inspected'
  | 'authority_revoked'
  | 'authority_expired'
  | 'call_allowed'
  | 'call_denied';

export interface AllowedTool {
  serviceId: string;
  toolName: string;
}

export interface CoordinatorEnrollment {
  enrollmentId: string;
  coordinatorId: string;
  status: EnrollmentStatus;
  allowedDeckIds: string[];
  createdAt: string;
  revokedAt: string | null;
}

export interface ExecutionAuthority {
  authorityId: string;
  enrollmentId: string;
  runId: string;
  attemptId: string;
  deckId: string;
  audience: AuthorityAudience;
  allowedServices: string[];
  allowedTools: AllowedTool[];
  issuedAt: string;
  expiresAt: string;
  status: AuthorityStatus;
  idempotencyKey: string;
}

export interface AuditCorrelation {
  enrollmentId?: string;
  authorityId?: string;
  runId?: string;
  attemptId?: string;
  deckId?: string;
  requestId?: string;
}

export interface AuditEvent {
  eventId: string;
  at: string;
  kind: AuditEventKind;
  correlation: AuditCorrelation;
  detail?: Record<string, unknown>;
}

export interface ContractError {
  ok: false;
  error_code: ContractErrorCode;
  message: string;
  reason?: ContractErrorReason;
  correlation?: AuditCorrelation;
}

export interface ContractSuccess<T> {
  ok: true;
  data: T;
}

export type ContractResult<T> = ContractSuccess<T> | ContractError;

export interface EnrollCoordinatorResult {
  enrollment: CoordinatorEnrollment;
  /** One-time secret for coordinator mint/metadata auth (`enrs_…`). */
  enrollmentSecret: string;
}

export interface MintAuthorityInput {
  enrollmentId: string;
  runId: string;
  attemptId: string;
  deckId: string;
  audience: AuthorityAudience;
  idempotencyKey: string;
  /**
   * Pre-materialized Deck policy snapshot.
   * HTTP mint authors these from deck policy; optional toolScopeHint may only narrow.
   */
  allowedServices: string[];
  allowedTools: AllowedTool[];
  /** TTL in milliseconds from mint time; must be > 0. */
  ttlMs: number;
}

/** Coordinator-supplied mint body before Deck authors the tool snapshot. */
export interface MintAuthorityRequest {
  enrollmentId: string;
  runId: string;
  attemptId: string;
  deckId: string;
  audience: AuthorityAudience;
  idempotencyKey: string;
  ttlMs: number;
  /** Optional narrowing hint; Deck intersects with current deck policy. */
  toolScopeHint?: AllowedTool[];
}

export interface MintAuthorityResult {
  authority: ExecutionAuthority;
  /**
   * One-time secret when `secretIssued` is true.
   * Null on idempotent remint — Dealer must retain the launcher handle from first mint.
   */
  authoritySecret: string | null;
  secretIssued: boolean;
}

export interface AuthorizedCallInput {
  authorityId: string;
  authoritySecret: string;
  /** Must match the authority's audience (stolen-authority binding). */
  audience: string;
  serviceId: string;
  toolName: string;
  /** When true, Deck returns INTERACTION_REQUIRED instead of executing. */
  requiresInteraction?: boolean;
}
