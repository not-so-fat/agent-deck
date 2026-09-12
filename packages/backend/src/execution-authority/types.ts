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
  | 'RESOURCE_OUT_OF_SCOPE'
  | 'INTERACTION_REQUIRED'
  | 'ENROLLMENT_REVOKED'
  | 'COORDINATOR_NOT_ENROLLED';

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
  correlation?: AuditCorrelation;
}

export interface ContractSuccess<T> {
  ok: true;
  data: T;
}

export type ContractResult<T> = ContractSuccess<T> | ContractError;

export interface MintAuthorityInput {
  enrollmentId: string;
  runId: string;
  attemptId: string;
  deckId: string;
  audience: AuthorityAudience;
  idempotencyKey: string;
  /**
   * Pre-materialized Deck policy snapshot for the in-memory skeleton.
   * Production (NOT-86) authors these from deck policy at mint; optional
   * toolScopeHint may only narrow.
   */
  allowedServices: string[];
  allowedTools: AllowedTool[];
  /** TTL in milliseconds from mint time. */
  ttlMs: number;
}

export interface MintAuthorityResult {
  authority: ExecutionAuthority;
  /** One-time secret — Dealer must not persist this; deliver via OS/launcher only. */
  authoritySecret: string;
}

export interface AuthorizedCallInput {
  authorityId: string;
  authoritySecret: string;
  serviceId: string;
  toolName: string;
  /** When true, Deck returns INTERACTION_REQUIRED instead of executing. */
  requiresInteraction?: boolean;
}
