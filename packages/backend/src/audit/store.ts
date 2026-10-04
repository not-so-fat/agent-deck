import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { OWNER_INSTALLATION_ID } from '../auth/client-grants';

export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const AUDIT_EVENTS = [
  'grant.created',
  'grant.used',
  'grant.revoked',
  'deck.selection_denied',
  'owner.sign_in_succeeded',
  'owner.sign_in_failed',
  'elevation.requested',
  'elevation.approved',
  'elevation.denied',
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];
export type AuditOutcome = 'succeeded' | 'denied';
export type AuditActor = 'owner' | 'local-launch' | `ag_${string}`;
export type AuditReasonCode =
  | 'invalid_credentials'
  | 'resource_out_of_scope'
  | 'deck_fixed'
  | 'admin_required'
  | 'owner_denied';

export type AuditEntry = {
  id: string;
  timestamp: string;
  installationId: string;
  actor: AuditActor;
  event: AuditEvent;
  targetId: string;
  outcome: AuditOutcome;
  reasonCode: AuditReasonCode | null;
};

export type WriteAuditEntry = Omit<AuditEntry, 'id' | 'timestamp' | 'installationId'> & {
  installationId?: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Never persist an untrusted deck header/body value as audit content. */
export function auditDeckTarget(value: string): string {
  return UUID_PATTERN.test(value) ? value : 'invalid-deck-id';
}

type AuditRow = {
  id: string;
  timestamp: string;
  installation_id: string;
  actor: AuditActor;
  event: AuditEvent;
  target_id: string;
  outcome: AuditOutcome;
  reason_code: AuditReasonCode | null;
};

/**
 * Append-only, identifier-only security audit ledger.
 *
 * The typed write shape deliberately has no free-form metadata field. Callers
 * cannot pass request headers, credentials, tokens, tool arguments or results,
 * and the API returns exactly the columns below.
 */
export class AuditStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    this.ensureTable();
    this.pruneExpired();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        event TEXT NOT NULL,
        target_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason_code TEXT
      );
      CREATE INDEX IF NOT EXISTS audit_events_page_idx
        ON audit_events (timestamp DESC, id DESC);
    `);
  }

  append(entry: WriteAuditEntry): AuditEntry {
    const latest = this.db
      .prepare(`SELECT timestamp FROM audit_events ORDER BY timestamp DESC LIMIT 1`)
      .get() as { timestamp: string } | undefined;
    const timestampMs = Math.max(
      this.now(),
      latest ? Date.parse(latest.timestamp) + 1 : Number.NEGATIVE_INFINITY,
    );
    const row: AuditEntry = {
      id: `aud_${randomUUID()}`,
      // SQLite connections in the backend and MCP process can append inside
      // the same millisecond. Keep the public timestamp monotonic so newest-
      // first order and id cursors remain deterministic across processes.
      timestamp: new Date(timestampMs).toISOString(),
      installationId: entry.installationId ?? OWNER_INSTALLATION_ID,
      actor: entry.actor,
      event: entry.event,
      targetId: entry.targetId,
      outcome: entry.outcome,
      reasonCode: entry.reasonCode,
    };
    this.db
      .prepare(
        `INSERT INTO audit_events
         (id, timestamp, installation_id, actor, event, target_id, outcome, reason_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.timestamp,
        row.installationId,
        row.actor,
        row.event,
        row.targetId,
        row.outcome,
        row.reasonCode,
      );
    return row;
  }

  list(options: { limit: number; before?: string }): AuditEntry[] {
    const cursor = options.before ? this.resolveCursor(options.before) : null;
    const rows = cursor
      ? this.db
          .prepare(
            `SELECT id, timestamp, installation_id, actor, event, target_id, outcome, reason_code
             FROM audit_events
             WHERE timestamp < ? OR (timestamp = ? AND id < ?)
             ORDER BY timestamp DESC, id DESC
             LIMIT ?`,
          )
          .all(cursor.timestamp, cursor.timestamp, cursor.id, options.limit)
      : this.db
          .prepare(
            `SELECT id, timestamp, installation_id, actor, event, target_id, outcome, reason_code
             FROM audit_events
             ORDER BY timestamp DESC, id DESC
             LIMIT ?`,
          )
          .all(options.limit);
    return (rows as AuditRow[]).map(toAuditEntry);
  }

  pruneExpired(): number {
    const cutoff = new Date(this.now() - AUDIT_RETENTION_MS).toISOString();
    return this.db.prepare(`DELETE FROM audit_events WHERE timestamp < ?`).run(cutoff).changes;
  }

  private resolveCursor(before: string): { timestamp: string; id: string } | null {
    const byId = this.db
      .prepare(`SELECT id, timestamp FROM audit_events WHERE id = ?`)
      .get(before) as { id: string; timestamp: string } | undefined;
    if (byId) return byId;

    const timestamp = Date.parse(before);
    return Number.isFinite(timestamp)
      ? { timestamp: new Date(timestamp).toISOString(), id: '' }
      : null;
  }
}

function toAuditEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    installationId: row.installation_id,
    actor: row.actor,
    event: row.event,
    targetId: row.target_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
  };
}
