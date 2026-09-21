import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  ADMIN_CHALLENGE_TTL_MS,
  ADMIN_MODE_LEASE_MS,
  DASHBOARD_SESSION_LEASE_MS,
  RUNTIME_SESSION_LEASE_MS,
  prefixTrustedId,
  type AgentSessionMode,
  type RuntimeSession,
} from '@agent-deck/shared';
import type Database from 'better-sqlite3';

export type RuntimeSessionRow = {
  id: string;
  mcp_session_id: string | null;
  deck_id: string;
  mode: AgentSessionMode;
  last_seen_at: string;
  expires_at: string;
  admin_expires_at: string | null;
  revoked_at: string | null;
};

export type AdminChallengeRow = {
  id: string;
  runtime_session_id: string;
  consumed_at: string | null;
  expires_at: string;
  created_at: string;
};

export type DashboardSessionRow = {
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
};

/** Default validity of a deck-switch request (NOT-205). */
export const DECK_SWITCH_REQUEST_TTL_MS = 30 * 60 * 1000;

export type DeckSwitchRequestStatus = 'pending' | 'approved' | 'declined' | 'expired' | 'consumed';

export type DeckSwitchRequestRow = {
  id: string;
  runtime_session_id: string;
  mcp_session_id: string | null;
  current_deck_id: string;
  requested_deck_id: string;
  workspace_root: string | null;
  status: DeckSwitchRequestStatus;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
};

/**
 * Server-side deck-switch request (NOT-205).
 * The requested deck id and workspace root stay server-side; client-facing
 * readers get {@link DeckSwitchRequestSummary} instead.
 */
export type DeckSwitchRequest = {
  requestId: string;
  runtimeSessionId: string;
  mcpSessionId?: string;
  currentDeckId: string;
  requestedDeckId: string;
  workspaceRoot?: string;
  status: DeckSwitchRequestStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
};

/**
 * Display-safe client view of a deck-switch request: opaque request id plus
 * lifecycle fields only. Never carries the requested deck id or workspace
 * root, so a pending/declined request exposes nothing of the target deck.
 */
export type DeckSwitchRequestSummary = {
  requestId: string;
  status: DeckSwitchRequestStatus;
  createdAt: string;
  expiresAt: string;
};

const DECK_SWITCH_STATUS_TRANSITIONS: Record<DeckSwitchRequestStatus, DeckSwitchRequestStatus[]> = {
  pending: ['approved', 'declined', 'expired'],
  approved: ['consumed'],
  declined: [],
  expired: [],
  consumed: [],
};

const DASHBOARD_SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function hashDashboardSessionToken(token: string): string {
  return hashSecret(token);
}

/**
 * NOT-205: project a request to its display-safe client view.
 * Only the opaque request id plus lifecycle fields are exposed; the
 * requested deck id, session identity, and workspace root stay server-side.
 */
export function toDeckSwitchRequestSummary(request: DeckSwitchRequest): DeckSwitchRequestSummary {
  return {
    requestId: request.requestId,
    status: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export class TrustedSessionStore {
  constructor(private readonly db: Database.Database) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.maybeShedGrantSchema();
    // NOT-107: shed legacy issuer tables (created by the deleted SQLite store).
    this.db.exec(`
      DROP TABLE IF EXISTS ea_audit_events;
      DROP TABLE IF EXISTS ea_authorities;
      DROP TABLE IF EXISTS ea_enrollments;
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_sessions (
        id TEXT PRIMARY KEY,
        mcp_session_id TEXT,
        deck_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('normal', 'agent-admin')),
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        admin_expires_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS admin_challenges (
        id TEXT PRIMARY KEY,
        runtime_session_id TEXT NOT NULL,
        consumed_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (runtime_session_id) REFERENCES runtime_sessions (id)
      );

      CREATE TABLE IF NOT EXISTS dashboard_nonces (
        nonce TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dashboard_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS dashboard_sessions_expiry_idx
        ON dashboard_sessions (expires_at);

      CREATE TABLE IF NOT EXISTS deck_switch_requests (
        id TEXT PRIMARY KEY,
        runtime_session_id TEXT NOT NULL,
        mcp_session_id TEXT,
        current_deck_id TEXT NOT NULL,
        requested_deck_id TEXT NOT NULL,
        workspace_root TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'consumed')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE INDEX IF NOT EXISTS deck_switch_requests_pending_idx
        ON deck_switch_requests (runtime_session_id, requested_deck_id, status, expires_at);
    `);
  }

  /**
   * NOT-108 PR2: drop grant ledger and rebuild runtime_sessions without
   * workspace_key_id / workspace_grant_id (same drop-and-recreate pattern as NOT-105).
   * Literals below are intentional — this is the only place that may still name the
   * legacy tables so upgrades can DROP them.
   */
  private maybeShedGrantSchema(): void {
    const cols = this.db.pragma('table_info(runtime_sessions)') as Array<{
      name: string;
    }>;
    const hasGrantColumn =
      cols.length > 0 && cols.some((col) => col.name === 'workspace_grant_id' || col.name === 'workspace_key_id');
    const grantsExist = (
      this.db.pragma('table_info(workspace_grants)') as Array<{ name: string }>
    ).length > 0;
    const keysExist = (
      this.db.pragma('table_info(workspace_keys)') as Array<{ name: string }>
    ).length > 0;

    if (!hasGrantColumn && !grantsExist && !keysExist) {
      return;
    }

    const foreignKeysEnabled =
      Number(this.db.pragma('foreign_keys', { simple: true })) === 1;
    if (foreignKeysEnabled) {
      this.db.pragma('foreign_keys = OFF');
    }
    try {
      this.db.exec(`
        DROP TABLE IF EXISTS admin_challenges;
        DROP TABLE IF EXISTS deck_switch_requests;
        DROP TABLE IF EXISTS runtime_sessions;
        DROP TABLE IF EXISTS workspace_grants;
        DROP TABLE IF EXISTS workspace_keys;
      `);
    } finally {
      if (foreignKeysEnabled) {
        this.db.pragma('foreign_keys = ON');
      }
    }
  }

  createRuntimeSession(input: {
    deckId: string;
    mcpSessionId?: string;
  }): RuntimeSession {
    const id = prefixTrustedId('ses', randomUUID());
    const lastSeenAt = nowIso();
    const expiresAt = addMs(lastSeenAt, RUNTIME_SESSION_LEASE_MS);

    this.db
      .prepare(
        `INSERT INTO runtime_sessions
         (id, mcp_session_id, deck_id, mode, last_seen_at, expires_at, admin_expires_at)
         VALUES (?, ?, ?, 'normal', ?, ?, NULL)`,
      )
      .run(id, input.mcpSessionId ?? null, input.deckId, lastSeenAt, expiresAt);

    return this.toRuntimeSession(this.getRuntimeSessionRow(id)!);
  }

  /**
   * Latest runtime row for an MCP transport id, including expired/revoked.
   * Used to keep transport→deck ownership immutable after the active lease ends.
   */
  findLatestRuntimeSessionByMcpSessionId(mcpSessionId: string): RuntimeSession | null {
    const row = this.db
      .prepare(
        `SELECT id, mcp_session_id, deck_id, mode,
                last_seen_at, expires_at, admin_expires_at, revoked_at
         FROM runtime_sessions
         WHERE mcp_session_id = ?
         ORDER BY last_seen_at DESC
         LIMIT 1`,
      )
      .get(mcpSessionId) as RuntimeSessionRow | undefined;

    return row ? this.toRuntimeSession(row) : null;
  }

  findActiveRuntimeSessionByMcpSessionId(mcpSessionId: string): RuntimeSession | null {
    const now = nowIso();
    const row = this.db
      .prepare(
        `SELECT id, mcp_session_id, deck_id, mode,
                last_seen_at, expires_at, admin_expires_at, revoked_at
         FROM runtime_sessions
         WHERE mcp_session_id = ?
           AND revoked_at IS NULL AND expires_at > ?
         ORDER BY last_seen_at DESC
         LIMIT 1`,
      )
      .get(mcpSessionId, now) as RuntimeSessionRow | undefined;

    return row ? this.toRuntimeSession(row) : null;
  }

  findActiveLaunchSessionForMcp(mcpSessionId: string, deckId: string): RuntimeSession | null {
    const now = nowIso();
    const row = this.db
      .prepare(
        `SELECT id, mcp_session_id, deck_id, mode,
                last_seen_at, expires_at, admin_expires_at, revoked_at
         FROM runtime_sessions
         WHERE mcp_session_id = ? AND deck_id = ?
           AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(mcpSessionId, deckId, now) as RuntimeSessionRow | undefined;

    if (!row) {
      return null;
    }

    return this.touchRuntimeSession(row.id);
  }

  getRuntimeSessionModeByMcpSessionId(mcpSessionId: string): AgentSessionMode | null {
    return this.getRuntimeSessionModesByMcpSessionIds([mcpSessionId]).get(mcpSessionId) ?? null;
  }

  getRuntimeSessionModesByMcpSessionIds(mcpSessionIds: string[]): Map<string, AgentSessionMode> {
    const uniqueIds = [...new Set(mcpSessionIds.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return new Map();
    }

    const now = nowIso();
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT mcp_session_id, mode FROM runtime_sessions
         WHERE mcp_session_id IN (${placeholders}) AND revoked_at IS NULL AND expires_at > ?`,
      )
      .all(...uniqueIds, now) as Array<{ mcp_session_id: string; mode: AgentSessionMode }>;

    return new Map(rows.map((row) => [row.mcp_session_id, row.mode]));
  }

  createDashboardNonce(nonce: string, expiresAtIso: string): void {
    this.db
      .prepare(
        `INSERT INTO dashboard_nonces (nonce, expires_at, created_at) VALUES (?, ?, ?)`,
      )
      .run(nonce, expiresAtIso, nowIso());
  }

  consumeDashboardNonce(nonce: string): boolean {
    const row = this.db
      .prepare(
        `SELECT nonce, expires_at, consumed_at FROM dashboard_nonces WHERE nonce = ?`,
      )
      .get(nonce) as { nonce: string; expires_at: string; consumed_at: string | null } | undefined;

    if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) {
      return false;
    }

    this.db
      .prepare(`UPDATE dashboard_nonces SET consumed_at = ? WHERE nonce = ?`)
      .run(nowIso(), nonce);
    return true;
  }

  expireDashboardNonces(): number {
    const now = nowIso();
    const result = this.db
      .prepare(`DELETE FROM dashboard_nonces WHERE expires_at <= ? OR consumed_at IS NOT NULL`)
      .run(now);
    return result.changes;
  }

  createDashboardSession(): string {
    const token = randomBytes(32).toString('base64url');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO dashboard_sessions (token_hash, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(hashDashboardSessionToken(token), now, now, addMs(now, DASHBOARD_SESSION_LEASE_MS));
    return token;
  }

  validateAndTouchDashboardSession(token: string): boolean {
    const tokenHash = hashDashboardSessionToken(token);
    const row = this.db
      .prepare(
        `SELECT token_hash, created_at, last_seen_at, expires_at
         FROM dashboard_sessions WHERE token_hash = ?`,
      )
      .get(tokenHash) as DashboardSessionRow | undefined;

    const nowMs = Date.now();
    if (!row || Date.parse(row.expires_at) <= nowMs) {
      if (row) {
        this.db.prepare(`DELETE FROM dashboard_sessions WHERE token_hash = ?`).run(tokenHash);
      }
      return false;
    }

    if (Date.parse(row.last_seen_at) <= nowMs - DASHBOARD_SESSION_TOUCH_INTERVAL_MS) {
      const now = new Date(nowMs).toISOString();
      this.db
        .prepare(
          `UPDATE dashboard_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?`,
        )
        .run(now, addMs(now, DASHBOARD_SESSION_LEASE_MS), tokenHash);
    }
    return true;
  }

  expireDashboardSessions(): number {
    const result = this.db
      .prepare(`DELETE FROM dashboard_sessions WHERE expires_at <= ?`)
      .run(nowIso());
    return result.changes;
  }

  getRuntimeSessionRow(sessionId: string): RuntimeSessionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, mcp_session_id, deck_id, mode,
                  last_seen_at, expires_at, admin_expires_at, revoked_at
           FROM runtime_sessions WHERE id = ?`,
        )
        .get(sessionId) as RuntimeSessionRow | undefined) ?? null
    );
  }

  touchRuntimeSession(sessionId: string): RuntimeSession | null {
    const row = this.getRuntimeSessionRow(sessionId);
    if (!row || row.revoked_at) {
      return null;
    }

    const now = nowIso();
    if (Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }

    let mode = row.mode;
    let adminExpiresAt = row.admin_expires_at;

    if (mode === 'agent-admin' && adminExpiresAt && Date.parse(adminExpiresAt) <= Date.now()) {
      mode = 'normal';
      adminExpiresAt = null;
    }

    const expiresAt = addMs(now, RUNTIME_SESSION_LEASE_MS);
    const nextAdminExpiresAt =
      mode === 'agent-admin' ? addMs(now, ADMIN_MODE_LEASE_MS) : null;

    this.db
      .prepare(
        `UPDATE runtime_sessions
         SET last_seen_at = ?, expires_at = ?, mode = ?, admin_expires_at = ?
         WHERE id = ?`,
      )
      .run(now, expiresAt, mode, nextAdminExpiresAt, sessionId);

    return this.toRuntimeSession(this.getRuntimeSessionRow(sessionId)!);
  }

  elevateSessionToAdmin(sessionId: string): RuntimeSession | null {
    const row = this.getRuntimeSessionRow(sessionId);
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }

    const now = nowIso();
    this.db
      .prepare(
        `UPDATE runtime_sessions
         SET mode = 'agent-admin', admin_expires_at = ?, last_seen_at = ?, expires_at = ?
         WHERE id = ?`,
      )
      .run(addMs(now, ADMIN_MODE_LEASE_MS), now, addMs(now, RUNTIME_SESSION_LEASE_MS), sessionId);

    return this.toRuntimeSession(this.getRuntimeSessionRow(sessionId)!);
  }

  /** Launch-session deck switch after elevated assignment update (NOT-108). */
  setRuntimeSessionDeck(sessionId: string, deckId: string): RuntimeSession | null {
    const row = this.getRuntimeSessionRow(sessionId);
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }
    if (row.mode !== 'agent-admin') {
      return null;
    }

    const now = nowIso();
    this.db
      .prepare(
        `UPDATE runtime_sessions
         SET deck_id = ?, last_seen_at = ?, expires_at = ?
         WHERE id = ?`,
      )
      .run(deckId, now, addMs(now, RUNTIME_SESSION_LEASE_MS), sessionId);

    return this.toRuntimeSession(this.getRuntimeSessionRow(sessionId)!);
  }

  downgradeSessionToNormal(sessionId: string): RuntimeSession | null {
    const row = this.getRuntimeSessionRow(sessionId);
    if (!row || row.revoked_at) {
      return null;
    }

    const now = nowIso();
    this.db
      .prepare(
        `UPDATE runtime_sessions
         SET mode = 'normal', admin_expires_at = NULL, last_seen_at = ?, expires_at = ?
         WHERE id = ?`,
      )
      .run(now, addMs(now, RUNTIME_SESSION_LEASE_MS), sessionId);

    return this.toRuntimeSession(this.getRuntimeSessionRow(sessionId)!);
  }

  revokeRuntimeSession(sessionId: string): void {
    this.db
      .prepare(`UPDATE runtime_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(nowIso(), sessionId);
  }

  createAdminChallenge(runtimeSessionId: string): AdminChallengeRow {
    const id = prefixTrustedId('adm', randomUUID());
    const createdAt = nowIso();
    const expiresAt = addMs(createdAt, ADMIN_CHALLENGE_TTL_MS);

    this.db
      .prepare(
        `INSERT INTO admin_challenges (id, runtime_session_id, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, runtimeSessionId, expiresAt, createdAt);

    return {
      id,
      runtime_session_id: runtimeSessionId,
      consumed_at: null,
      expires_at: expiresAt,
      created_at: createdAt,
    };
  }

  consumeAdminChallenge(challengeId: string, runtimeSessionId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id, runtime_session_id, consumed_at, expires_at, created_at
         FROM admin_challenges WHERE id = ?`,
      )
      .get(challengeId) as AdminChallengeRow | undefined;

    if (!row || row.runtime_session_id !== runtimeSessionId) {
      return false;
    }
    if (row.consumed_at || Date.parse(row.expires_at) <= Date.now()) {
      return false;
    }

    this.db
      .prepare(`UPDATE admin_challenges SET consumed_at = ? WHERE id = ?`)
      .run(nowIso(), challengeId);
    return true;
  }

  listPendingAdminChallenges(): Array<{
    challengeId: string;
    runtimeSessionId: string;
    deckId: string;
    expiresAt: string;
    createdAt: string;
  }> {
    const now = nowIso();
    const rows = this.db
      .prepare(
        `SELECT ac.id, ac.runtime_session_id, ac.expires_at, ac.created_at, rs.deck_id
         FROM admin_challenges ac
         INNER JOIN runtime_sessions rs ON rs.id = ac.runtime_session_id
         WHERE ac.consumed_at IS NULL
           AND ac.expires_at > ?
           AND rs.revoked_at IS NULL`,
      )
      .all(now) as Array<{
      id: string;
      runtime_session_id: string;
      expires_at: string;
      created_at: string;
      deck_id: string;
    }>;

    return rows.map((row) => ({
      challengeId: row.id,
      runtimeSessionId: row.runtime_session_id,
      deckId: row.deck_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }));
  }

  /**
   * NOT-205: record a human-decision deck-switch request.
   * Never mutates the runtime session binding — the session keeps serving
   * its current deck while the request is pending (or declined).
   * Duplicate pending requests for the same session and requested target are
   * idempotent: the existing pending request is returned as-is.
   */
  createDeckSwitchRequest(input: {
    runtimeSessionId: string;
    mcpSessionId?: string;
    currentDeckId: string;
    requestedDeckId: string;
    workspaceRoot?: string;
    ttlMs?: number;
  }): DeckSwitchRequest {
    const ttlMs = input.ttlMs ?? DECK_SWITCH_REQUEST_TTL_MS;
    let result: DeckSwitchRequest | null = null;
    const tx = this.db.transaction(() => {
      this.expireDeckSwitchRequests();
      const existing = this.db
        .prepare(
          `SELECT id, runtime_session_id, mcp_session_id, current_deck_id,
                  requested_deck_id, workspace_root, status,
                  created_at, expires_at, resolved_at
           FROM deck_switch_requests
           WHERE runtime_session_id = ? AND requested_deck_id = ?
             AND status = 'pending' AND expires_at > ?
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(input.runtimeSessionId, input.requestedDeckId, nowIso()) as
        | DeckSwitchRequestRow
        | undefined;
      if (existing) {
        result = this.toDeckSwitchRequest(existing);
        return;
      }

      const id = prefixTrustedId('req', randomUUID());
      const createdAt = nowIso();
      const expiresAt = addMs(createdAt, ttlMs);
      this.db
        .prepare(
          `INSERT INTO deck_switch_requests
           (id, runtime_session_id, mcp_session_id, current_deck_id,
            requested_deck_id, workspace_root, status, created_at, expires_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
        )
        .run(
          id,
          input.runtimeSessionId,
          input.mcpSessionId ?? null,
          input.currentDeckId,
          input.requestedDeckId,
          input.workspaceRoot ?? null,
          createdAt,
          expiresAt,
        );
      result = this.toDeckSwitchRequest(this.getDeckSwitchRequestRow(id)!);
    });
    tx();
    return result!;
  }

  private getDeckSwitchRequestRow(requestId: string): DeckSwitchRequestRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, runtime_session_id, mcp_session_id, current_deck_id,
                  requested_deck_id, workspace_root, status,
                  created_at, expires_at, resolved_at
           FROM deck_switch_requests WHERE id = ?`,
        )
        .get(requestId) as DeckSwitchRequestRow | undefined) ?? null
    );
  }

  /**
   * Read a request, lazily marking it expired when its TTL has passed.
   * An expired request is returned with status `expired` and can never be
   * approved afterwards.
   */
  getDeckSwitchRequest(requestId: string): DeckSwitchRequest | null {
    const row = this.getDeckSwitchRequestRow(requestId);
    if (!row) {
      return null;
    }
    if (row.status === 'pending' && Date.parse(row.expires_at) <= Date.now()) {
      this.markDeckSwitchRequestExpired(requestId);
      return this.toDeckSwitchRequest(this.getDeckSwitchRequestRow(requestId)!);
    }
    return this.toDeckSwitchRequest(row);
  }

  /** Client-safe view: opaque id plus lifecycle fields, no target deck data. */
  getDeckSwitchRequestSummary(requestId: string): DeckSwitchRequestSummary | null {
    const request = this.getDeckSwitchRequest(requestId);
    return request ? toDeckSwitchRequestSummary(request) : null;
  }

  listPendingDeckSwitchRequests(runtimeSessionId?: string): DeckSwitchRequest[] {
    this.expireDeckSwitchRequests();
    const now = nowIso();
    const rows =
      runtimeSessionId === undefined
        ? (this.db
            .prepare(
              `SELECT id, runtime_session_id, mcp_session_id, current_deck_id,
                      requested_deck_id, workspace_root, status,
                      created_at, expires_at, resolved_at
               FROM deck_switch_requests
               WHERE status = 'pending' AND expires_at > ?
               ORDER BY created_at ASC`,
            )
            .all(now) as DeckSwitchRequestRow[])
        : (this.db
            .prepare(
              `SELECT id, runtime_session_id, mcp_session_id, current_deck_id,
                      requested_deck_id, workspace_root, status,
                      created_at, expires_at, resolved_at
               FROM deck_switch_requests
               WHERE runtime_session_id = ? AND status = 'pending' AND expires_at > ?
               ORDER BY created_at ASC`,
            )
            .all(runtimeSessionId, now) as DeckSwitchRequestRow[]);
    return rows.map((row) => this.toDeckSwitchRequest(row));
  }

  /**
   * Compare-and-set status transition. Returns the updated request on success,
   * or null when the request is missing, the current status differs from
   * `expectedStatus`, the transition is illegal, or an expired pending request
   * is resolved to anything but `expired`. Exactly one concurrent resolver
   * wins because the UPDATE is conditional on the expected status.
   */
  transitionDeckSwitchRequestStatus(
    requestId: string,
    expectedStatus: DeckSwitchRequestStatus,
    nextStatus: DeckSwitchRequestStatus,
  ): DeckSwitchRequest | null {
    if (!DECK_SWITCH_STATUS_TRANSITIONS[expectedStatus]?.includes(nextStatus)) {
      return null;
    }
    const row = this.getDeckSwitchRequestRow(requestId);
    if (!row) {
      return null;
    }
    if (row.status === 'pending' && Date.parse(row.expires_at) <= Date.now()) {
      this.markDeckSwitchRequestExpired(requestId);
      return null;
    }
    if (row.status !== expectedStatus) {
      return null;
    }

    const now = nowIso();
    const resolvedAt = expectedStatus === 'pending' ? now : row.resolved_at;
    const result = this.db
      .prepare(
        `UPDATE deck_switch_requests
         SET status = ?, resolved_at = ?
         WHERE id = ? AND status = ?`,
      )
      .run(nextStatus, resolvedAt, requestId, expectedStatus);
    if (result.changes === 0) {
      return null;
    }
    return this.toDeckSwitchRequest(this.getDeckSwitchRequestRow(requestId)!);
  }

  /**
   * Sweep pending requests past their TTL to `expired`. Returns the number
   * of requests newly expired.
   */
  expireDeckSwitchRequests(): number {
    const now = nowIso();
    const result = this.db
      .prepare(
        `UPDATE deck_switch_requests
         SET status = 'expired', resolved_at = ?
         WHERE status = 'pending' AND expires_at <= ?`,
      )
      .run(now, now);
    return result.changes;
  }

  private markDeckSwitchRequestExpired(requestId: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE deck_switch_requests
         SET status = 'expired', resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, requestId);
  }

  private toDeckSwitchRequest(row: DeckSwitchRequestRow): DeckSwitchRequest {
    return {
      requestId: row.id,
      runtimeSessionId: row.runtime_session_id,
      mcpSessionId: row.mcp_session_id ?? undefined,
      currentDeckId: row.current_deck_id,
      requestedDeckId: row.requested_deck_id,
      workspaceRoot: row.workspace_root ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at,
    };
  }

  expireStaleSessions(): number {
    const now = nowIso();
    const downgrade = this.db.prepare(
      `UPDATE runtime_sessions
       SET mode = 'normal', admin_expires_at = NULL
       WHERE mode = 'agent-admin' AND admin_expires_at IS NOT NULL AND admin_expires_at <= ?`,
    );
    const expire = this.db.prepare(
      `UPDATE runtime_sessions SET revoked_at = ?
       WHERE revoked_at IS NULL AND expires_at <= ?`,
    );

    let expiredCount = 0;
    const tx = this.db.transaction(() => {
      downgrade.run(now);
      const result = expire.run(now, now);
      expiredCount = result.changes;
    });
    tx();

    return expiredCount;
  }

  private toRuntimeSession(row: RuntimeSessionRow): RuntimeSession {
    return {
      sessionId: row.id,
      mcpSessionId: row.mcp_session_id ?? undefined,
      deckId: row.deck_id,
      mode: row.mode,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      adminExpiresAt: row.admin_expires_at,
    };
  }
}
