import type Database from 'better-sqlite3';

import type { AgentRunClient, AgentRunTools } from '@agent-deck/shared';

/**
 * NOT-480: request identity for API-created runs.
 *
 * The run's events and lifecycle stay in the canonical run record
 * (`meta.json` + `run.jsonl`); this index holds only what authorization and
 * idempotency need: the creating grant, the deck, and a hash of the
 * normalized request. Prompts, results, and bearer values are never stored.
 */
export type AgentRunIndexEntry = {
  runId: string;
  grantId: string;
  idempotencyKey: string;
  requestHash: string;
  deckId: string;
  client: AgentRunClient;
  tools: AgentRunTools;
  createdAt: string;
};

type AgentRunIndexRow = {
  run_id: string;
  grant_id: string;
  idempotency_key: string;
  request_hash: string;
  deck_id: string;
  client: AgentRunClient;
  tools: AgentRunTools;
  created_at: string;
};

const COLUMNS = 'run_id, grant_id, idempotency_key, request_hash, deck_id, client, tools, created_at';

export class AgentRunIndex {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_run_requests (
        run_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        deck_id TEXT NOT NULL,
        client TEXT NOT NULL,
        tools TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (grant_id, idempotency_key)
      );
    `);
  }

  /**
   * Claim `(grantId, idempotencyKey)` for a new run. Returns the existing
   * entry instead when the key is already claimed; the insert is atomic, so
   * concurrent claimants observe exactly one winner.
   */
  reserve(entry: Omit<AgentRunIndexEntry, 'createdAt'>): { reserved: true } | { reserved: false; existing: AgentRunIndexEntry } {
    const result = this.db
      .prepare(
        `INSERT INTO agent_run_requests (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (grant_id, idempotency_key) DO NOTHING`,
      )
      .run(
        entry.runId,
        entry.grantId,
        entry.idempotencyKey,
        entry.requestHash,
        entry.deckId,
        entry.client,
        entry.tools,
        new Date().toISOString(),
      );
    if (result.changes > 0) {
      return { reserved: true };
    }
    return { reserved: false, existing: this.findByKey(entry.grantId, entry.idempotencyKey)! };
  }

  /** Drop a claim whose launch failed closed (no model work happened). */
  release(runId: string): void {
    this.db.prepare(`DELETE FROM agent_run_requests WHERE run_id = ?`).run(runId);
  }

  get(runId: string): AgentRunIndexEntry | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM agent_run_requests WHERE run_id = ?`)
      .get(runId) as AgentRunIndexRow | undefined;
    return row ? toEntry(row) : null;
  }

  findByKey(grantId: string, idempotencyKey: string): AgentRunIndexEntry | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM agent_run_requests WHERE grant_id = ? AND idempotency_key = ?`)
      .get(grantId, idempotencyKey) as AgentRunIndexRow | undefined;
    return row ? toEntry(row) : null;
  }
}

function toEntry(row: AgentRunIndexRow): AgentRunIndexEntry {
  return {
    runId: row.run_id,
    grantId: row.grant_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    deckId: row.deck_id,
    client: row.client,
    tools: row.tools,
    createdAt: row.created_at,
  };
}
