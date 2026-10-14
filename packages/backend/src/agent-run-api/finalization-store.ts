import { randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { FinalizeAgentRunResponse } from '@agent-deck/shared';

import type { GitBaseline } from './git-finalize';

/**
 * NOT-486: durable finalization state for API-created runs.
 *
 * `agent_run_baselines` holds the private pre-launch baseline (it carries
 * host paths and must never be returned); callers see only its opaque
 * `baselineRef` and digest. `agent_run_finalizations` holds at most one
 * finalization per run: the Idempotency-Key claim, a hash of the normalized
 * request, crash-recovery facts while it is in progress, and the public
 * result once committed. No file content, message, or bearer is stored.
 */

export type StoredBaseline = { runId: string; baselineRef: string; baseline: GitBaseline; createdAt: string };

export type FinalizationRecord = {
  runId: string;
  grantId: string;
  idempotencyKey: string;
  requestHash: string;
  state: 'finalizing' | 'finalized';
  pendingCommit: string | null;
  lockIno: number | null;
  result: FinalizeAgentRunResponse | null;
};

type FinalizationRow = {
  run_id: string;
  grant_id: string;
  idempotency_key: string;
  request_hash: string;
  state: 'finalizing' | 'finalized';
  pending_commit: string | null;
  lock_ino: number | null;
  result_json: string | null;
};

const FINALIZATION_COLUMNS =
  'run_id, grant_id, idempotency_key, request_hash, state, pending_commit, lock_ino, result_json';

export class FinalizationStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_run_baselines (
        run_id TEXT PRIMARY KEY,
        baseline_ref TEXT NOT NULL UNIQUE,
        baseline_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_run_finalizations (
        run_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        pending_commit TEXT,
        lock_ino INTEGER,
        result_json TEXT,
        created_at TEXT NOT NULL,
        finalized_at TEXT,
        UNIQUE (grant_id, idempotency_key)
      );
    `);
  }

  saveBaseline(runId: string, baseline: GitBaseline): StoredBaseline {
    const baselineRef = `bl_${randomBytes(12).toString('hex')}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO agent_run_baselines (run_id, baseline_ref, baseline_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(runId, baselineRef, JSON.stringify(baseline), createdAt);
    return { runId, baselineRef, baseline, createdAt };
  }

  getBaseline(runId: string): StoredBaseline | null {
    const row = this.db
      .prepare(`SELECT run_id, baseline_ref, baseline_json, created_at FROM agent_run_baselines WHERE run_id = ?`)
      .get(runId) as { run_id: string; baseline_ref: string; baseline_json: string; created_at: string } | undefined;
    if (!row) {
      return null;
    }
    return {
      runId: row.run_id,
      baselineRef: row.baseline_ref,
      baseline: JSON.parse(row.baseline_json) as GitBaseline,
      createdAt: row.created_at,
    };
  }

  /** Drop the baseline of a launch that failed closed. */
  deleteBaseline(runId: string): void {
    this.db.prepare(`DELETE FROM agent_run_baselines WHERE run_id = ?`).run(runId);
  }

  /**
   * Atomically claim the run's one finalization. Returns the existing record
   * when the run (or this grant's key) is already claimed.
   */
  claim(entry: { runId: string; grantId: string; idempotencyKey: string; requestHash: string }):
    | { claimed: true }
    | { claimed: false; existing: FinalizationRecord } {
    const result = this.db
      .prepare(
        `INSERT INTO agent_run_finalizations
         (run_id, grant_id, idempotency_key, request_hash, state, created_at)
         VALUES (?, ?, ?, ?, 'finalizing', ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(entry.runId, entry.grantId, entry.idempotencyKey, entry.requestHash, new Date().toISOString());
    if (result.changes > 0) {
      return { claimed: true };
    }
    const existing =
      this.get(entry.runId) ??
      this.toRecord(
        this.db
          .prepare(`SELECT ${FINALIZATION_COLUMNS} FROM agent_run_finalizations WHERE grant_id = ? AND idempotency_key = ?`)
          .get(entry.grantId, entry.idempotencyKey) as FinalizationRow | undefined,
      );
    return { claimed: false, existing: existing! };
  }

  get(runId: string): FinalizationRecord | null {
    return this.toRecord(
      this.db
        .prepare(`SELECT ${FINALIZATION_COLUMNS} FROM agent_run_finalizations WHERE run_id = ?`)
        .get(runId) as FinalizationRow | undefined,
    );
  }

  listInProgress(): FinalizationRecord[] {
    const rows = this.db
      .prepare(`SELECT ${FINALIZATION_COLUMNS} FROM agent_run_finalizations WHERE state = 'finalizing'`)
      .all() as FinalizationRow[];
    return rows.map((row) => this.toRecord(row)!);
  }

  markLocked(runId: string, lockIno: number): void {
    this.db.prepare(`UPDATE agent_run_finalizations SET lock_ino = ? WHERE run_id = ?`).run(lockIno, runId);
  }

  /** The commit object exists but the ref has not moved yet: enough to recover the outcome after a crash. */
  markPending(runId: string, result: FinalizeAgentRunResponse): void {
    this.db
      .prepare(`UPDATE agent_run_finalizations SET pending_commit = ?, result_json = ? WHERE run_id = ?`)
      .run(result.commit, JSON.stringify(result), runId);
  }

  complete(runId: string, result: FinalizeAgentRunResponse): void {
    this.db
      .prepare(
        `UPDATE agent_run_finalizations
         SET state = 'finalized', result_json = ?, pending_commit = ?, lock_ino = NULL, finalized_at = ?
         WHERE run_id = ?`,
      )
      .run(JSON.stringify(result), result.commit, new Date().toISOString(), runId);
  }

  /** Free the claim of a finalization that failed before its commit. */
  release(runId: string): void {
    this.db.prepare(`DELETE FROM agent_run_finalizations WHERE run_id = ? AND state = 'finalizing'`).run(runId);
  }

  private toRecord(row: FinalizationRow | undefined): FinalizationRecord | null {
    if (!row) {
      return null;
    }
    return {
      runId: row.run_id,
      grantId: row.grant_id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      state: row.state,
      pendingCommit: row.pending_commit,
      lockIno: row.lock_ino,
      result: row.result_json ? (JSON.parse(row.result_json) as FinalizeAgentRunResponse) : null,
    };
  }
}
