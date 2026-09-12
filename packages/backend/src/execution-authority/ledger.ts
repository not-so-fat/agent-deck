/**
 * In-memory execution-authority ledger (NOT-85 logic engine).
 * Durable SQLite wrapper: `ExecutionAuthorityStore` (NOT-86).
 */

import { randomUUID } from 'node:crypto';

import { prefixTrustedId } from '@agent-deck/shared';

import { hashGrantSecret, verifyGrantSecret } from '../trusted-session/store';
import type {
  AllowedTool,
  AuditCorrelation,
  AuditEvent,
  AuditEventKind,
  AuthorizedCallInput,
  ContractResult,
  CoordinatorEnrollment,
  EnrollCoordinatorResult,
  ExecutionAuthority,
  MintAuthorityInput,
  MintAuthorityResult,
} from './types';

function newId(kind: 'enr' | 'authz' | 'req' | 'evt'): string {
  return prefixTrustedId(kind, randomUUID());
}

/** Serializable ledger state for durable hydrate/persist. */
export type LedgerState = {
  enrollments: CoordinatorEnrollment[];
  enrollmentSecretHashes: Array<{ enrollmentId: string; secretHash: string }>;
  authorities: ExecutionAuthority[];
  secretHashes: Array<{ authorityId: string; secretHash: string }>;
  mintIndex: Array<{ enrollmentId: string; idempotencyKey: string; authorityId: string }>;
  audit: AuditEvent[];
};

function cloneAuthority(authority: ExecutionAuthority): ExecutionAuthority {
  return {
    ...authority,
    allowedServices: [...authority.allowedServices],
    allowedTools: authority.allowedTools.map((t) => ({ ...t })),
  };
}

function toolsEqual(a: AllowedTool[], b: AllowedTool[]): boolean {
  if (a.length !== b.length) return false;
  const key = (t: AllowedTool) => `${t.serviceId}\0${t.toolName}`;
  const sortedA = [...a].map(key).sort();
  const sortedB = [...b].map(key).sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function mintParamsMatch(existing: ExecutionAuthority, input: MintAuthorityInput): boolean {
  const storedTtlMs = Date.parse(existing.expiresAt) - Date.parse(existing.issuedAt);
  return (
    existing.runId === input.runId &&
    existing.attemptId === input.attemptId &&
    existing.deckId === input.deckId &&
    existing.audience === input.audience &&
    storedTtlMs === input.ttlMs &&
    existing.allowedServices.length === input.allowedServices.length &&
    existing.allowedServices.every((s) => input.allowedServices.includes(s)) &&
    toolsEqual(existing.allowedTools, input.allowedTools)
  );
}

export interface ExecutionAuthorityLedgerOptions {
  /** Injectable clock for expiry tests. */
  now?: () => Date;
}

/**
 * Deck-side authorization ledger (skeleton). Authoritative for enrollment and
 * execution authority; does not model Dealer run lifecycle.
 */
export class ExecutionAuthorityLedger {
  private readonly enrollments = new Map<string, CoordinatorEnrollment>();
  private readonly enrollmentSecretHashes = new Map<string, string>();
  private readonly authorities = new Map<string, ExecutionAuthority>();
  private readonly secretHashes = new Map<string, string>();
  private readonly mintIndex = new Map<string, string>(); // enrollmentId\0idempotencyKey -> authorityId
  private readonly audit: AuditEvent[] = [];
  private readonly now: () => Date;

  constructor(options: ExecutionAuthorityLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  exportState(): LedgerState {
    return {
      enrollments: [...this.enrollments.values()].map((e) => ({
        ...e,
        allowedDeckIds: [...e.allowedDeckIds],
      })),
      enrollmentSecretHashes: [...this.enrollmentSecretHashes.entries()].map(
        ([enrollmentId, secretHash]) => ({ enrollmentId, secretHash }),
      ),
      authorities: [...this.authorities.values()].map(cloneAuthority),
      secretHashes: [...this.secretHashes.entries()].map(([authorityId, secretHash]) => ({
        authorityId,
        secretHash,
      })),
      mintIndex: [...this.mintIndex.entries()].map(([key, authorityId]) => {
        const [enrollmentId, idempotencyKey] = key.split('\0');
        return { enrollmentId, idempotencyKey, authorityId };
      }),
      audit: this.audit.map((event) => ({
        ...event,
        correlation: { ...event.correlation },
        detail: event.detail ? { ...event.detail } : undefined,
      })),
    };
  }

  replaceState(state: LedgerState): void {
    this.enrollments.clear();
    this.enrollmentSecretHashes.clear();
    this.authorities.clear();
    this.secretHashes.clear();
    this.mintIndex.clear();
    this.audit.length = 0;
    for (const enrollment of state.enrollments) {
      this.enrollments.set(enrollment.enrollmentId, {
        ...enrollment,
        allowedDeckIds: [...enrollment.allowedDeckIds],
      });
    }
    for (const row of state.enrollmentSecretHashes) {
      this.enrollmentSecretHashes.set(row.enrollmentId, row.secretHash);
    }
    for (const authority of state.authorities) {
      this.authorities.set(authority.authorityId, cloneAuthority(authority));
    }
    for (const row of state.secretHashes) {
      this.secretHashes.set(row.authorityId, row.secretHash);
    }
    for (const row of state.mintIndex) {
      this.mintIndex.set(`${row.enrollmentId}\0${row.idempotencyKey}`, row.authorityId);
    }
    for (const event of state.audit) {
      this.audit.push({
        ...event,
        correlation: { ...event.correlation },
        detail: event.detail ? { ...event.detail } : undefined,
      });
    }
  }

  getEnrollment(enrollmentId: string): CoordinatorEnrollment | undefined {
    const enrollment = this.enrollments.get(enrollmentId);
    if (!enrollment) return undefined;
    return { ...enrollment, allowedDeckIds: [...enrollment.allowedDeckIds] };
  }

  listEnrollments(): CoordinatorEnrollment[] {
    return [...this.enrollments.values()].map((e) => ({
      ...e,
      allowedDeckIds: [...e.allowedDeckIds],
    }));
  }

  verifyEnrollmentSecret(enrollmentId: string, secret: string): boolean {
    const hash = this.enrollmentSecretHashes.get(enrollmentId);
    if (!hash) return false;
    return verifyGrantSecret(secret, hash);
  }

  verifyAuthoritySecret(authorityId: string, secret: string): boolean {
    const hash = this.secretHashes.get(authorityId);
    if (!hash) return false;
    return verifyGrantSecret(secret, hash);
  }

  enrollCoordinator(input: {
    coordinatorId: string;
    allowedDeckIds: string[];
  }): ContractResult<EnrollCoordinatorResult> {
    const enrollment: CoordinatorEnrollment = {
      enrollmentId: newId('enr'),
      coordinatorId: input.coordinatorId,
      status: 'active',
      allowedDeckIds: [...input.allowedDeckIds],
      createdAt: this.now().toISOString(),
      revokedAt: null,
    };
    const enrollmentSecret = `enrs_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    this.enrollments.set(enrollment.enrollmentId, enrollment);
    this.enrollmentSecretHashes.set(enrollment.enrollmentId, hashGrantSecret(enrollmentSecret));
    this.pushAudit('enrollment_created', {
      enrollmentId: enrollment.enrollmentId,
    }, { coordinatorId: input.coordinatorId });
    return {
      ok: true,
      data: {
        enrollment: {
          ...enrollment,
          allowedDeckIds: [...enrollment.allowedDeckIds],
        },
        enrollmentSecret,
      },
    };
  }

  revokeEnrollment(enrollmentId: string): ContractResult<{ enrollmentId: string }> {
    const enrollment = this.enrollments.get(enrollmentId);
    if (!enrollment) {
      return {
        ok: false,
        error_code: 'COORDINATOR_NOT_ENROLLED',
        message: 'Unknown enrollment',
        correlation: { enrollmentId },
      };
    }
    if (enrollment.status === 'revoked') {
      return { ok: true, data: { enrollmentId } };
    }
    enrollment.status = 'revoked';
    enrollment.revokedAt = this.now().toISOString();
    this.pushAudit('enrollment_revoked', { enrollmentId });

    for (const stored of this.authorities.values()) {
      if (stored.enrollmentId !== enrollmentId) continue;
      const authority = this.refreshAuthorityStatus(stored.authorityId);
      if (!authority || authority.status !== 'live') continue;
      authority.status = 'revoked';
      this.pushAudit('authority_revoked', {
        enrollmentId,
        authorityId: authority.authorityId,
        runId: authority.runId,
        attemptId: authority.attemptId,
        deckId: authority.deckId,
      }, { reason: 'enrollment_revoked' });
    }
    return { ok: true, data: { enrollmentId } };
  }

  mintAuthority(input: MintAuthorityInput): ContractResult<MintAuthorityResult> {
    if (!(input.ttlMs > 0)) {
      return {
        ok: false,
        error_code: 'INVALID_MINT_REQUEST',
        message: 'ttlMs must be positive',
        reason: 'ttl_non_positive',
        correlation: { enrollmentId: input.enrollmentId },
      };
    }

    const enrollment = this.enrollments.get(input.enrollmentId);
    if (!enrollment) {
      return {
        ok: false,
        error_code: 'COORDINATOR_NOT_ENROLLED',
        message: 'Unknown enrollment',
        correlation: { enrollmentId: input.enrollmentId },
      };
    }
    if (enrollment.status !== 'active') {
      return {
        ok: false,
        error_code: 'ENROLLMENT_REVOKED',
        message: 'Enrollment is revoked',
        correlation: { enrollmentId: input.enrollmentId },
      };
    }
    if (!enrollment.allowedDeckIds.includes(input.deckId)) {
      return {
        ok: false,
        error_code: 'RESOURCE_OUT_OF_SCOPE',
        message: 'Deck not permitted for this enrollment',
        reason: 'deck_not_permitted',
        correlation: { enrollmentId: input.enrollmentId, deckId: input.deckId },
      };
    }

    const mintKey = `${input.enrollmentId}\0${input.idempotencyKey}`;
    const existingId = this.mintIndex.get(mintKey);
    if (existingId) {
      const existing = this.refreshAuthorityStatus(existingId)!;
      if (!mintParamsMatch(existing, input)) {
        return {
          ok: false,
          error_code: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'Idempotency key reused with different mint parameters',
          reason: 'params_mismatch',
          correlation: {
            enrollmentId: existing.enrollmentId,
            authorityId: existing.authorityId,
            runId: existing.runId,
            attemptId: existing.attemptId,
            deckId: existing.deckId,
          },
        };
      }
      if (existing.status === 'live') {
        // Idempotent remint does not re-issue the secret (Dealer must retain launcher handle).
        return {
          ok: true,
          data: {
            authority: cloneAuthority(existing),
            authoritySecret: null,
            secretIssued: false,
          },
        };
      }
      return {
        ok: false,
        error_code: existing.status === 'expired' ? 'AUTHORITY_EXPIRED' : 'AUTHORITY_REVOKED',
        message: `Authority already ${existing.status}`,
        reason: existing.status === 'revoked' ? 'explicit_revoke' : undefined,
        correlation: {
          enrollmentId: existing.enrollmentId,
          authorityId: existing.authorityId,
          runId: existing.runId,
          attemptId: existing.attemptId,
          deckId: existing.deckId,
        },
      };
    }

    const issuedAt = this.now();
    const authority: ExecutionAuthority = {
      authorityId: newId('authz'),
      enrollmentId: input.enrollmentId,
      runId: input.runId,
      attemptId: input.attemptId,
      deckId: input.deckId,
      audience: input.audience,
      allowedServices: [...input.allowedServices],
      allowedTools: input.allowedTools.map((t) => ({ ...t })),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
      status: 'live',
      idempotencyKey: input.idempotencyKey,
    };
    const authoritySecret = `seas_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    this.authorities.set(authority.authorityId, authority);
    this.secretHashes.set(authority.authorityId, hashGrantSecret(authoritySecret));
    this.mintIndex.set(mintKey, authority.authorityId);
    this.pushAudit('authority_minted', {
      enrollmentId: authority.enrollmentId,
      authorityId: authority.authorityId,
      runId: authority.runId,
      attemptId: authority.attemptId,
      deckId: authority.deckId,
    });
    return {
      ok: true,
      data: {
        authority: cloneAuthority(authority),
        authoritySecret,
        secretIssued: true,
      },
    };
  }

  inspectAuthority(authorityId: string): ContractResult<ExecutionAuthority> {
    const authority = this.refreshAuthorityStatus(authorityId);
    if (!authority) {
      return {
        ok: false,
        error_code: 'AUTHORITY_UNKNOWN',
        message: 'Unknown authority',
        correlation: { authorityId },
      };
    }
    this.pushAudit('authority_inspected', {
      enrollmentId: authority.enrollmentId,
      authorityId: authority.authorityId,
      runId: authority.runId,
      attemptId: authority.attemptId,
      deckId: authority.deckId,
    });
    return { ok: true, data: cloneAuthority(authority) };
  }

  revokeAuthority(authorityId: string): ContractResult<{ authorityId: string }> {
    const authority = this.authorities.get(authorityId);
    if (!authority) {
      return {
        ok: false,
        error_code: 'AUTHORITY_UNKNOWN',
        message: 'Unknown authority',
        correlation: { authorityId },
      };
    }
    if (authority.status !== 'revoked') {
      authority.status = 'revoked';
      this.pushAudit('authority_revoked', {
        enrollmentId: authority.enrollmentId,
        authorityId: authority.authorityId,
        runId: authority.runId,
        attemptId: authority.attemptId,
        deckId: authority.deckId,
      }, { reason: 'explicit_revoke' });
    }
    return { ok: true, data: { authorityId } };
  }

  /**
   * Simulate one authorized Deck tool call under execution authority.
   * Never waits for human approval — returns INTERACTION_REQUIRED immediately.
   */
  invokeAuthorizedCall(
    input: AuthorizedCallInput,
  ): ContractResult<{ serviceId: string; toolName: string; result: string }> {
    const authority = this.refreshAuthorityStatus(input.authorityId);
    const correlation: AuditCorrelation = {
      authorityId: input.authorityId,
    };

    if (!authority) {
      return {
        ok: false,
        error_code: 'AUTHORITY_UNKNOWN',
        message: 'Unknown authority',
        correlation,
      };
    }

    correlation.enrollmentId = authority.enrollmentId;
    correlation.runId = authority.runId;
    correlation.attemptId = authority.attemptId;
    correlation.deckId = authority.deckId;

    const expectedHash = this.secretHashes.get(authority.authorityId);
    if (!expectedHash || !verifyGrantSecret(input.authoritySecret, expectedHash)) {
      this.pushAudit('call_denied', correlation, { reason: 'bad_secret' });
      return {
        ok: false,
        error_code: 'AUTHORITY_SECRET_INVALID',
        message: 'Invalid authority secret',
        correlation,
      };
    }

    if (input.audience !== authority.audience) {
      this.pushAudit('call_denied', correlation, {
        reason: 'audience_mismatch',
        expected: authority.audience,
        actual: input.audience,
      });
      return {
        ok: false,
        error_code: 'AUDIENCE_MISMATCH',
        message: 'Caller audience does not match authority audience',
        correlation,
      };
    }

    if (authority.status === 'expired') {
      this.pushAudit('call_denied', correlation, { reason: 'expired' });
      return {
        ok: false,
        error_code: 'AUTHORITY_EXPIRED',
        message: 'Authority expired',
        correlation,
      };
    }
    if (authority.status === 'revoked') {
      this.pushAudit('call_denied', correlation, { reason: 'revoked' });
      return {
        ok: false,
        error_code: 'AUTHORITY_REVOKED',
        message: 'Authority revoked',
        reason: 'explicit_revoke',
        correlation,
      };
    }

    if (input.requiresInteraction) {
      const requestId = newId('req');
      correlation.requestId = requestId;
      this.pushAudit('call_denied', correlation, { reason: 'interaction_required' });
      return {
        ok: false,
        error_code: 'INTERACTION_REQUIRED',
        message: 'Control-plane decision required; do not hold the worker',
        correlation,
      };
    }

    if (!this.toolAllowed(authority, input.serviceId, input.toolName)) {
      this.pushAudit('call_denied', correlation, {
        reason: 'tool_not_in_snapshot',
        serviceId: input.serviceId,
        toolName: input.toolName,
      });
      return {
        ok: false,
        error_code: 'RESOURCE_OUT_OF_SCOPE',
        message: 'Tool not in authority snapshot',
        reason: 'tool_not_in_snapshot',
        correlation,
      };
    }

    this.pushAudit('call_allowed', correlation, {
      serviceId: input.serviceId,
      toolName: input.toolName,
    });
    return {
      ok: true,
      data: {
        serviceId: input.serviceId,
        toolName: input.toolName,
        result: 'ok',
      },
    };
  }

  listAuditEvents(filter: {
    runId?: string;
    attemptId?: string;
    authorityId?: string;
    enrollmentId?: string;
    requestId?: string;
  } = {}): AuditEvent[] {
    return this.audit.filter((event) => {
      const c = event.correlation;
      if (filter.runId && c.runId !== filter.runId) return false;
      if (filter.attemptId && c.attemptId !== filter.attemptId) return false;
      if (filter.authorityId && c.authorityId !== filter.authorityId) return false;
      if (filter.enrollmentId && c.enrollmentId !== filter.enrollmentId) return false;
      if (filter.requestId && c.requestId !== filter.requestId) return false;
      return true;
    });
  }

  private toolAllowed(authority: ExecutionAuthority, serviceId: string, toolName: string): boolean {
    if (!authority.allowedServices.includes(serviceId)) return false;
    return authority.allowedTools.some(
      (t: AllowedTool) => t.serviceId === serviceId && t.toolName === toolName,
    );
  }

  private refreshAuthorityStatus(authorityId: string): ExecutionAuthority | undefined {
    const authority = this.authorities.get(authorityId);
    if (!authority) return undefined;
    if (authority.status === 'live' && Date.parse(authority.expiresAt) <= this.now().getTime()) {
      authority.status = 'expired';
      this.pushAudit('authority_expired', {
        enrollmentId: authority.enrollmentId,
        authorityId: authority.authorityId,
        runId: authority.runId,
        attemptId: authority.attemptId,
        deckId: authority.deckId,
      });
    }
    return authority;
  }

  private pushAudit(
    kind: AuditEventKind,
    correlation: AuditCorrelation,
    detail?: Record<string, unknown>,
  ): void {
    this.audit.push({
      eventId: newId('evt'),
      at: this.now().toISOString(),
      kind,
      correlation: { ...correlation },
      detail,
    });
  }
}
