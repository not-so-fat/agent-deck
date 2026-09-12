/**
 * In-memory execution-authority ledger — inspectable skeleton for NOT-85.
 * Production persistence and HTTP/MCP surfaces land in NOT-86.
 */

import { createHash, randomBytes } from 'node:crypto';

import type {
  AllowedTool,
  AuditCorrelation,
  AuditEvent,
  AuditEventKind,
  AuthorizedCallInput,
  ContractResult,
  CoordinatorEnrollment,
  ExecutionAuthority,
  MintAuthorityInput,
  MintAuthorityResult,
} from './types';

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
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
  private readonly authorities = new Map<string, ExecutionAuthority>();
  private readonly secretHashes = new Map<string, string>();
  private readonly mintIndex = new Map<string, string>(); // enrollmentId\0idempotencyKey -> authorityId
  private readonly audit: AuditEvent[] = [];
  private readonly now: () => Date;

  constructor(options: ExecutionAuthorityLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  enrollCoordinator(input: {
    coordinatorId: string;
    allowedDeckIds: string[];
  }): ContractResult<CoordinatorEnrollment> {
    const enrollment: CoordinatorEnrollment = {
      enrollmentId: id('enr'),
      coordinatorId: input.coordinatorId,
      status: 'active',
      allowedDeckIds: [...input.allowedDeckIds],
      createdAt: this.now().toISOString(),
      revokedAt: null,
    };
    this.enrollments.set(enrollment.enrollmentId, enrollment);
    this.pushAudit('enrollment_created', {
      enrollmentId: enrollment.enrollmentId,
    }, { coordinatorId: input.coordinatorId });
    return { ok: true, data: enrollment };
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

    for (const authority of this.authorities.values()) {
      if (authority.enrollmentId === enrollmentId && authority.status === 'live') {
        authority.status = 'revoked';
        this.pushAudit('authority_revoked', {
          enrollmentId,
          authorityId: authority.authorityId,
          runId: authority.runId,
          attemptId: authority.attemptId,
          deckId: authority.deckId,
        }, { reason: 'enrollment_revoked' });
      }
    }
    return { ok: true, data: { enrollmentId } };
  }

  mintAuthority(input: MintAuthorityInput): ContractResult<MintAuthorityResult> {
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
        correlation: { enrollmentId: input.enrollmentId, deckId: input.deckId },
      };
    }

    const mintKey = `${input.enrollmentId}\0${input.idempotencyKey}`;
    const existingId = this.mintIndex.get(mintKey);
    if (existingId) {
      const existing = this.refreshAuthorityStatus(existingId)!;
      if (existing.status === 'live') {
        // Idempotent remint does not re-issue the secret (Dealer must retain launcher handle).
        return {
          ok: true,
          data: {
            authority: existing,
            authoritySecret: '',
          },
        };
      }
      return {
        ok: false,
        error_code: existing.status === 'expired' ? 'AUTHORITY_EXPIRED' : 'AUTHORITY_REVOKED',
        message: `Authority already ${existing.status}`,
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
      authorityId: id('authz'),
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
    const authoritySecret = `seas_${randomBytes(24).toString('hex')}`;
    this.authorities.set(authority.authorityId, authority);
    this.secretHashes.set(authority.authorityId, hashSecret(authoritySecret));
    this.mintIndex.set(mintKey, authority.authorityId);
    this.pushAudit('authority_minted', {
      enrollmentId: authority.enrollmentId,
      authorityId: authority.authorityId,
      runId: authority.runId,
      attemptId: authority.attemptId,
      deckId: authority.deckId,
    });
    return { ok: true, data: { authority, authoritySecret } };
  }

  inspectAuthority(authorityId: string): ContractResult<ExecutionAuthority> {
    const authority = this.refreshAuthorityStatus(authorityId);
    if (!authority) {
      return {
        ok: false,
        error_code: 'AUTHORITY_REVOKED',
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
    return { ok: true, data: { ...authority, allowedTools: authority.allowedTools.map((t) => ({ ...t })) } };
  }

  revokeAuthority(authorityId: string): ContractResult<{ authorityId: string }> {
    const authority = this.authorities.get(authorityId);
    if (!authority) {
      return {
        ok: false,
        error_code: 'AUTHORITY_REVOKED',
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
      });
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
        error_code: 'AUTHORITY_REVOKED',
        message: 'Unknown authority',
        correlation,
      };
    }

    correlation.enrollmentId = authority.enrollmentId;
    correlation.runId = authority.runId;
    correlation.attemptId = authority.attemptId;
    correlation.deckId = authority.deckId;

    const expectedHash = this.secretHashes.get(authority.authorityId);
    if (!expectedHash || hashSecret(input.authoritySecret) !== expectedHash) {
      this.pushAudit('call_denied', correlation, { reason: 'bad_secret' });
      return {
        ok: false,
        error_code: 'AUTHORITY_REVOKED',
        message: 'Invalid authority secret',
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
        correlation,
      };
    }

    if (input.requiresInteraction) {
      const requestId = id('req');
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
        reason: 'out_of_scope',
        serviceId: input.serviceId,
        toolName: input.toolName,
      });
      return {
        ok: false,
        error_code: 'RESOURCE_OUT_OF_SCOPE',
        message: 'Tool not in authority snapshot',
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
  } = {}): AuditEvent[] {
    return this.audit.filter((event) => {
      const c = event.correlation;
      if (filter.runId && c.runId !== filter.runId) return false;
      if (filter.attemptId && c.attemptId !== filter.attemptId) return false;
      if (filter.authorityId && c.authorityId !== filter.authorityId) return false;
      if (filter.enrollmentId && c.enrollmentId !== filter.enrollmentId) return false;
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
      eventId: id('evt'),
      at: this.now().toISOString(),
      kind,
      correlation: { ...correlation },
      detail,
    });
  }
}
