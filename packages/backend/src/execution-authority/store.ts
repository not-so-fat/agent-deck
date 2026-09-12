/**
 * Durable SQLite-backed execution-authority store (NOT-86).
 * Logic lives in ExecutionAuthorityLedger; this module hydrates/persists snapshots.
 */

import type Database from 'better-sqlite3';

import { ExecutionAuthorityLedger, type LedgerState } from './ledger';
import type {
  AuthorizedCallInput,
  ContractResult,
  CoordinatorEnrollment,
  EnrollCoordinatorResult,
  ExecutionAuthority,
  MintAuthorityInput,
  MintAuthorityResult,
  AuditEvent,
} from './types';

export type ExecutionAuthorityStoreOptions = {
  now?: () => Date;
};

export class ExecutionAuthorityStore {
  private readonly ledger: ExecutionAuthorityLedger;

  constructor(
    private readonly db: Database.Database,
    options: ExecutionAuthorityStoreOptions = {},
  ) {
    this.ensureTables();
    this.ledger = new ExecutionAuthorityLedger({ now: options.now });
    this.hydrate();
  }

  /** Test helper: replace clock without losing durable state. */
  withNow(now: () => Date): ExecutionAuthorityStore {
    const next = new ExecutionAuthorityStore(this.db, { now });
    return next;
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ea_enrollments (
        enrollment_id TEXT PRIMARY KEY,
        coordinator_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        allowed_deck_ids TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        secret_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ea_authorities (
        authority_id TEXT PRIMARY KEY,
        enrollment_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        deck_id TEXT NOT NULL,
        audience TEXT NOT NULL,
        allowed_services TEXT NOT NULL,
        allowed_tools TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('live', 'expired', 'revoked')),
        idempotency_key TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        FOREIGN KEY (enrollment_id) REFERENCES ea_enrollments (enrollment_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ea_authorities_mint_idempotency
        ON ea_authorities (enrollment_id, idempotency_key);

      CREATE TABLE IF NOT EXISTS ea_audit_events (
        event_id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        correlation_json TEXT NOT NULL,
        detail_json TEXT
      );
    `);
  }

  private hydrate(): void {
    const enrollments = this.db
      .prepare(
        `SELECT enrollment_id, coordinator_id, status, allowed_deck_ids, created_at, revoked_at, secret_hash
         FROM ea_enrollments`,
      )
      .all() as Array<{
      enrollment_id: string;
      coordinator_id: string;
      status: 'active' | 'revoked';
      allowed_deck_ids: string;
      created_at: string;
      revoked_at: string | null;
      secret_hash: string;
    }>;

    const authorities = this.db
      .prepare(
        `SELECT authority_id, enrollment_id, run_id, attempt_id, deck_id, audience,
                allowed_services, allowed_tools, issued_at, expires_at, status, idempotency_key, secret_hash
         FROM ea_authorities`,
      )
      .all() as Array<{
      authority_id: string;
      enrollment_id: string;
      run_id: string;
      attempt_id: string;
      deck_id: string;
      audience: 'dealer-worker';
      allowed_services: string;
      allowed_tools: string;
      issued_at: string;
      expires_at: string;
      status: 'live' | 'expired' | 'revoked';
      idempotency_key: string;
      secret_hash: string;
    }>;

    const audit = this.db
      .prepare(`SELECT event_id, at, kind, correlation_json, detail_json FROM ea_audit_events ORDER BY at ASC, event_id ASC`)
      .all() as Array<{
      event_id: string;
      at: string;
      kind: AuditEvent['kind'];
      correlation_json: string;
      detail_json: string | null;
    }>;

    const state: LedgerState = {
      enrollments: enrollments.map((row) => ({
        enrollmentId: row.enrollment_id,
        coordinatorId: row.coordinator_id,
        status: row.status,
        allowedDeckIds: JSON.parse(row.allowed_deck_ids) as string[],
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
      })),
      enrollmentSecretHashes: enrollments.map((row) => ({
        enrollmentId: row.enrollment_id,
        secretHash: row.secret_hash,
      })),
      authorities: authorities.map((row) => ({
        authorityId: row.authority_id,
        enrollmentId: row.enrollment_id,
        runId: row.run_id,
        attemptId: row.attempt_id,
        deckId: row.deck_id,
        audience: row.audience,
        allowedServices: JSON.parse(row.allowed_services) as string[],
        allowedTools: JSON.parse(row.allowed_tools) as ExecutionAuthority['allowedTools'],
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        status: row.status,
        idempotencyKey: row.idempotency_key,
      })),
      secretHashes: authorities.map((row) => ({
        authorityId: row.authority_id,
        secretHash: row.secret_hash,
      })),
      mintIndex: authorities.map((row) => ({
        enrollmentId: row.enrollment_id,
        idempotencyKey: row.idempotency_key,
        authorityId: row.authority_id,
      })),
      audit: audit.map((row) => ({
        eventId: row.event_id,
        at: row.at,
        kind: row.kind,
        correlation: JSON.parse(row.correlation_json) as AuditEvent['correlation'],
        detail: row.detail_json
          ? (JSON.parse(row.detail_json) as Record<string, unknown>)
          : undefined,
      })),
    };
    this.ledger.replaceState(state);
  }

  private persist(): void {
    const state = this.ledger.exportState();
    const tx = this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM ea_audit_events;
        DELETE FROM ea_authorities;
        DELETE FROM ea_enrollments;
      `);

      const insertEnrollment = this.db.prepare(
        `INSERT INTO ea_enrollments
           (enrollment_id, coordinator_id, status, allowed_deck_ids, created_at, revoked_at, secret_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const hashByEnrollment = new Map(
        state.enrollmentSecretHashes.map((r) => [r.enrollmentId, r.secretHash]),
      );
      for (const enrollment of state.enrollments) {
        const secretHash = hashByEnrollment.get(enrollment.enrollmentId);
        if (!secretHash) {
          throw new Error(`Missing enrollment secret hash for ${enrollment.enrollmentId}`);
        }
        insertEnrollment.run(
          enrollment.enrollmentId,
          enrollment.coordinatorId,
          enrollment.status,
          JSON.stringify(enrollment.allowedDeckIds),
          enrollment.createdAt,
          enrollment.revokedAt,
          secretHash,
        );
      }

      const insertAuthority = this.db.prepare(
        `INSERT INTO ea_authorities
           (authority_id, enrollment_id, run_id, attempt_id, deck_id, audience,
            allowed_services, allowed_tools, issued_at, expires_at, status, idempotency_key, secret_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const hashByAuthority = new Map(state.secretHashes.map((r) => [r.authorityId, r.secretHash]));
      for (const authority of state.authorities) {
        const secretHash = hashByAuthority.get(authority.authorityId);
        if (!secretHash) {
          throw new Error(`Missing authority secret hash for ${authority.authorityId}`);
        }
        insertAuthority.run(
          authority.authorityId,
          authority.enrollmentId,
          authority.runId,
          authority.attemptId,
          authority.deckId,
          authority.audience,
          JSON.stringify(authority.allowedServices),
          JSON.stringify(authority.allowedTools),
          authority.issuedAt,
          authority.expiresAt,
          authority.status,
          authority.idempotencyKey,
          secretHash,
        );
      }

      const insertAudit = this.db.prepare(
        `INSERT INTO ea_audit_events (event_id, at, kind, correlation_json, detail_json)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const event of state.audit) {
        insertAudit.run(
          event.eventId,
          event.at,
          event.kind,
          JSON.stringify(event.correlation),
          event.detail ? JSON.stringify(event.detail) : null,
        );
      }
    });
    tx();
  }

  private runMutating<T>(fn: () => ContractResult<T> | T): ContractResult<T> | T {
    const result = fn();
    this.persist();
    return result;
  }

  enrollCoordinator(input: {
    coordinatorId: string;
    allowedDeckIds: string[];
  }): ContractResult<EnrollCoordinatorResult> {
    return this.runMutating(() => this.ledger.enrollCoordinator(input)) as ContractResult<EnrollCoordinatorResult>;
  }

  revokeEnrollment(enrollmentId: string): ContractResult<{ enrollmentId: string }> {
    return this.runMutating(() => this.ledger.revokeEnrollment(enrollmentId)) as ContractResult<{
      enrollmentId: string;
    }>;
  }

  mintAuthority(input: MintAuthorityInput): ContractResult<MintAuthorityResult> {
    return this.runMutating(() => this.ledger.mintAuthority(input)) as ContractResult<MintAuthorityResult>;
  }

  inspectAuthority(authorityId: string): ContractResult<ExecutionAuthority> {
    return this.runMutating(() => this.ledger.inspectAuthority(authorityId)) as ContractResult<ExecutionAuthority>;
  }

  revokeAuthority(authorityId: string): ContractResult<{ authorityId: string }> {
    return this.runMutating(() => this.ledger.revokeAuthority(authorityId)) as ContractResult<{
      authorityId: string;
    }>;
  }

  invokeAuthorizedCall(
    input: AuthorizedCallInput,
  ): ContractResult<{ serviceId: string; toolName: string; result: string }> {
    return this.runMutating(() => this.ledger.invokeAuthorizedCall(input)) as ContractResult<{
      serviceId: string;
      toolName: string;
      result: string;
    }>;
  }

  listAuditEvents(filter: {
    runId?: string;
    attemptId?: string;
    authorityId?: string;
    enrollmentId?: string;
    requestId?: string;
  } = {}): AuditEvent[] {
    return this.ledger.listAuditEvents(filter);
  }

  getEnrollment(enrollmentId: string): CoordinatorEnrollment | undefined {
    return this.ledger.getEnrollment(enrollmentId);
  }

  listEnrollments(): CoordinatorEnrollment[] {
    return this.ledger.listEnrollments();
  }

  verifyEnrollmentSecret(enrollmentId: string, secret: string): boolean {
    return this.ledger.verifyEnrollmentSecret(enrollmentId, secret);
  }

  verifyAuthoritySecret(authorityId: string, secret: string): boolean {
    return this.ledger.verifyAuthoritySecret(authorityId, secret);
  }

  /**
   * Validate authority id+secret and return current authority (may transition to expired).
   */
  authenticateAuthority(
    authorityId: string,
    authoritySecret: string,
  ): ContractResult<ExecutionAuthority> {
    const inspected = this.ledger.inspectAuthority(authorityId);
    this.persist();
    if (!inspected.ok) {
      return inspected;
    }
    if (!this.ledger.verifyAuthoritySecret(authorityId, authoritySecret)) {
      return {
        ok: false,
        error_code: 'AUTHORITY_SECRET_INVALID',
        message: 'Invalid authority secret',
        correlation: { authorityId },
      };
    }
    if (inspected.data.status === 'expired') {
      return {
        ok: false,
        error_code: 'AUTHORITY_EXPIRED',
        message: 'Authority expired',
        correlation: {
          authorityId,
          enrollmentId: inspected.data.enrollmentId,
          runId: inspected.data.runId,
          attemptId: inspected.data.attemptId,
          deckId: inspected.data.deckId,
        },
      };
    }
    if (inspected.data.status === 'revoked') {
      return {
        ok: false,
        error_code: 'AUTHORITY_REVOKED',
        message: 'Authority revoked',
        reason: 'explicit_revoke',
        correlation: {
          authorityId,
          enrollmentId: inspected.data.enrollmentId,
          runId: inspected.data.runId,
          attemptId: inspected.data.attemptId,
          deckId: inspected.data.deckId,
        },
      };
    }
    return inspected;
  }
}
