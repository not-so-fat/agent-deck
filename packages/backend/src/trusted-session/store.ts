import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  ADMIN_CHALLENGE_TTL_MS,
  ADMIN_MODE_LEASE_MS,
  RUNTIME_SESSION_LEASE_MS,
  prefixTrustedId,
  type AgentSessionMode,
  type RuntimeSession,
  type WorkspaceGrantStatus,
} from '@agent-deck/shared';
import type Database from 'better-sqlite3';

export type WorkspaceKeyRow = {
  id: string;
  path_digest: string;
  created_at: string;
};

export type WorkspaceGrantRow = {
  id: string;
  workspace_key_id: string;
  deck_id: string;
  secret_hash: string;
  status: WorkspaceGrantStatus;
  created_at: string;
  activated_at: string | null;
  revoked_at: string | null;
};

export type RuntimeSessionRow = {
  id: string;
  mcp_session_id: string | null;
  workspace_key_id: string;
  workspace_grant_id: string;
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

export function hashGrantSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function generateGrantSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function verifyGrantSecret(secret: string, secretHash: string): boolean {
  const digest = Buffer.from(hashGrantSecret(secret), 'hex');
  const expected = Buffer.from(secretHash, 'hex');
  if (digest.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(digest, expected);
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_keys (
        id TEXT PRIMARY KEY,
        path_digest TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_grants (
        id TEXT PRIMARY KEY,
        workspace_key_id TEXT NOT NULL,
        deck_id TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
        created_at TEXT NOT NULL,
        activated_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (workspace_key_id) REFERENCES workspace_keys (id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS workspace_grants_one_active
        ON workspace_grants (workspace_key_id)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS runtime_sessions (
        id TEXT PRIMARY KEY,
        mcp_session_id TEXT,
        workspace_key_id TEXT NOT NULL,
        workspace_grant_id TEXT NOT NULL,
        deck_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('normal', 'agent-admin')),
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        admin_expires_at TEXT,
        revoked_at TEXT,
        FOREIGN KEY (workspace_key_id) REFERENCES workspace_keys (id),
        FOREIGN KEY (workspace_grant_id) REFERENCES workspace_grants (id)
      );

      CREATE INDEX IF NOT EXISTS runtime_sessions_grant_idx
        ON runtime_sessions (workspace_grant_id);

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
    `);
  }

  getOrCreateWorkspaceKey(pathDigest: string): WorkspaceKeyRow {
    const existing = this.db
      .prepare('SELECT id, path_digest, created_at FROM workspace_keys WHERE path_digest = ?')
      .get(pathDigest) as WorkspaceKeyRow | undefined;

    if (existing) {
      return existing;
    }

    const id = prefixTrustedId('wsp', randomUUID());
    const createdAt = nowIso();
    this.db
      .prepare('INSERT INTO workspace_keys (id, path_digest, created_at) VALUES (?, ?, ?)')
      .run(id, pathDigest, createdAt);

    return { id, path_digest: pathDigest, created_at: createdAt };
  }

  getWorkspaceKeyById(id: string): WorkspaceKeyRow | null {
    return (
      (this.db
        .prepare('SELECT id, path_digest, created_at FROM workspace_keys WHERE id = ?')
        .get(id) as WorkspaceKeyRow | undefined) ?? null
    );
  }

  getActiveGrantForWorkspace(workspaceKeyId: string): WorkspaceGrantRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, workspace_key_id, deck_id, secret_hash, status, created_at, activated_at, revoked_at
           FROM workspace_grants
           WHERE workspace_key_id = ? AND status = 'active'`,
        )
        .get(workspaceKeyId) as WorkspaceGrantRow | undefined) ?? null
    );
  }

  getGrantById(grantId: string): WorkspaceGrantRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, workspace_key_id, deck_id, secret_hash, status, created_at, activated_at, revoked_at
           FROM workspace_grants WHERE id = ?`,
        )
        .get(grantId) as WorkspaceGrantRow | undefined) ?? null
    );
  }

  findActiveGrantBySecret(secret: string): WorkspaceGrantRow | null {
    const hash = hashGrantSecret(secret);
    return (
      (this.db
        .prepare(
          `SELECT id, workspace_key_id, deck_id, secret_hash, status, created_at, activated_at, revoked_at
           FROM workspace_grants WHERE secret_hash = ? AND status = 'active'`,
        )
        .get(hash) as WorkspaceGrantRow | undefined) ?? null
    );
  }

  createPendingGrant(workspaceKeyId: string, deckId: string, secret: string): WorkspaceGrantRow {
    const id = prefixTrustedId('wgr', randomUUID());
    const createdAt = nowIso();
    const secretHash = hashGrantSecret(secret);

    this.db
      .prepare(
        `INSERT INTO workspace_grants
         (id, workspace_key_id, deck_id, secret_hash, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, workspaceKeyId, deckId, secretHash, createdAt);

    return {
      id,
      workspace_key_id: workspaceKeyId,
      deck_id: deckId,
      secret_hash: secretHash,
      status: 'pending',
      created_at: createdAt,
      activated_at: null,
      revoked_at: null,
    };
  }

  activateGrant(grantId: string): WorkspaceGrantRow | null {
    const grant = this.getGrantById(grantId);
    if (!grant || grant.status !== 'pending') {
      return null;
    }

    const activatedAt = nowIso();
    const revokeActive = this.db.prepare(
      `UPDATE workspace_grants
       SET status = 'revoked', revoked_at = ?
       WHERE workspace_key_id = ? AND status = 'active'`,
    );
    const activate = this.db.prepare(
      `UPDATE workspace_grants
       SET status = 'active', activated_at = ?
       WHERE id = ? AND status = 'pending'`,
    );

    const tx = this.db.transaction(() => {
      revokeActive.run(activatedAt, grant.workspace_key_id);
      activate.run(activatedAt, grantId);
    });
    tx();

    return this.getGrantById(grantId);
  }

  revokeGrant(grantId: string): void {
    const revokedAt = nowIso();
    this.db
      .prepare(
        `UPDATE workspace_grants SET status = 'revoked', revoked_at = ? WHERE id = ? AND status != 'revoked'`,
      )
      .run(revokedAt, grantId);
    this.revokeSessionsForGrant(grantId, revokedAt);
  }

  revokeSessionsForGrant(grantId: string, revokedAt: string = nowIso()): number {
    const result = this.db
      .prepare(
        `UPDATE runtime_sessions SET revoked_at = ? WHERE workspace_grant_id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, grantId);
    return result.changes;
  }

  createRuntimeSession(input: {
    workspaceKeyId: string;
    workspaceGrantId: string;
    deckId: string;
    mcpSessionId?: string;
  }): RuntimeSession {
    const id = prefixTrustedId('ses', randomUUID());
    const lastSeenAt = nowIso();
    const expiresAt = addMs(lastSeenAt, RUNTIME_SESSION_LEASE_MS);

    this.db
      .prepare(
        `INSERT INTO runtime_sessions
         (id, mcp_session_id, workspace_key_id, workspace_grant_id, deck_id, mode,
          last_seen_at, expires_at, admin_expires_at)
         VALUES (?, ?, ?, ?, ?, 'normal', ?, ?, NULL)`,
      )
      .run(
        id,
        input.mcpSessionId ?? null,
        input.workspaceKeyId,
        input.workspaceGrantId,
        input.deckId,
        lastSeenAt,
        expiresAt,
      );

    return this.toRuntimeSession(this.getRuntimeSessionRow(id)!);
  }

  findActiveRuntimeSessionForMcp(mcpSessionId: string, grantId: string): RuntimeSession | null {
    const now = nowIso();
    const row = this.db
      .prepare(
        `SELECT id, mcp_session_id, workspace_key_id, workspace_grant_id, deck_id, mode,
                last_seen_at, expires_at, admin_expires_at, revoked_at
         FROM runtime_sessions
         WHERE mcp_session_id = ? AND workspace_grant_id = ?
           AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(mcpSessionId, grantId, now) as RuntimeSessionRow | undefined;

    if (!row) {
      return null;
    }

    const touched = this.touchRuntimeSession(row.id);
    return touched;
  }

  revokePendingGrant(grantId: string): void {
    const revokedAt = nowIso();
    this.db
      .prepare(
        `UPDATE workspace_grants SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(revokedAt, grantId);
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

  getRuntimeSessionRow(sessionId: string): RuntimeSessionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT id, mcp_session_id, workspace_key_id, workspace_grant_id, deck_id, mode,
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

  countWorkspacesForDeck(deckId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT workspace_key_id) AS count
         FROM workspace_grants
         WHERE deck_id = ? AND status = 'active'`,
      )
      .get(deckId) as { count: number };
    return row.count;
  }

  /**
   * C8: elevated-agent deck change — rotate grant, rebind approving session, revoke peers.
   * Plaintext grant secret is stored hashed only; caller must run `agent-deck use` to refresh local grant file.
   */
  rotateGrantForElevatedSession(
    runtimeSessionId: string,
    newDeckId: string,
  ): { session: RuntimeSession; peersRevoked: number; grantId: string } | null {
    const row = this.getRuntimeSessionRow(runtimeSessionId);
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }
    if (row.mode !== 'agent-admin') {
      return null;
    }
    if (row.deck_id === newDeckId) {
      const session = this.touchRuntimeSession(runtimeSessionId);
      return session
        ? { session, peersRevoked: 0, grantId: row.workspace_grant_id }
        : null;
    }

    const oldGrantId = row.workspace_grant_id;
    const secret = generateGrantSecret();
    const pending = this.createPendingGrant(row.workspace_key_id, newDeckId, secret);
    const activated = this.activateGrant(pending.id);
    if (!activated) {
      this.revokePendingGrant(pending.id);
      return null;
    }

    const revokedAt = nowIso();
    const peersRevoked = this.db
      .prepare(
        `UPDATE runtime_sessions SET revoked_at = ?
         WHERE workspace_grant_id = ? AND id != ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, oldGrantId, runtimeSessionId).changes;

    const now = nowIso();
    const adminExpiresAt = row.admin_expires_at;
    this.db
      .prepare(
        `UPDATE runtime_sessions
         SET workspace_grant_id = ?, deck_id = ?, last_seen_at = ?, expires_at = ?
         WHERE id = ?`,
      )
      .run(
        activated.id,
        newDeckId,
        now,
        addMs(now, RUNTIME_SESSION_LEASE_MS),
        runtimeSessionId,
      );

    const session = this.toRuntimeSession(this.getRuntimeSessionRow(runtimeSessionId)!);
    return { session, peersRevoked, grantId: activated.id };
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
      workspaceKey: row.workspace_key_id,
      workspaceGrantId: row.workspace_grant_id,
      deckId: row.deck_id,
      mode: row.mode,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      adminExpiresAt: row.admin_expires_at,
    };
  }
}
