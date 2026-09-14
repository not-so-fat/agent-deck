import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DatabaseManager } from '../models/database';
import {
  TrustedSessionStore,
  generateGrantSecret,
  hashDashboardSessionToken,
} from './store';

describe('TrustedSessionStore', () => {
  it('persists hashed dashboard sessions across store instances', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const token = store.createDashboardSession();

    const row = db
      .prepare('SELECT token_hash, last_seen_at, expires_at FROM dashboard_sessions')
      .get() as { token_hash: string; last_seen_at: string; expires_at: string };
    expect(row.token_hash).toBe(hashDashboardSessionToken(token));
    expect(row.token_hash).not.toBe(token);

    const restartedStore = new TrustedSessionStore(db);
    expect(restartedStore.validateAndTouchDashboardSession(token)).toBe(true);
  });

  it('rejects and removes expired dashboard sessions', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const token = store.createDashboardSession();
    const tokenHash = hashDashboardSessionToken(token);
    db.prepare('UPDATE dashboard_sessions SET expires_at = ? WHERE token_hash = ?')
      .run('2000-01-01T00:00:00.000Z', tokenHash);

    expect(store.validateAndTouchDashboardSession(token)).toBe(false);
    expect(
      db.prepare('SELECT token_hash FROM dashboard_sessions WHERE token_hash = ?').get(tokenHash),
    ).toBeUndefined();
  });

  it('renews an active dashboard session after the touch interval', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const token = store.createDashboardSession();
    const tokenHash = hashDashboardSessionToken(token);
    db.prepare(
      'UPDATE dashboard_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?',
    ).run('2000-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', tokenHash);

    expect(store.validateAndTouchDashboardSession(token)).toBe(true);
    const touched = db
      .prepare('SELECT last_seen_at, expires_at FROM dashboard_sessions WHERE token_hash = ?')
      .get(tokenHash) as { last_seen_at: string; expires_at: string };
    expect(Date.parse(touched.last_seen_at)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00.000Z'));
    expect(Date.parse(touched.expires_at)).toBeLessThan(Date.parse('2099-01-01T00:00:00.000Z'));
  });

  it('issues and validates grants through runtime sessions', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const workspace = store.getOrCreateWorkspaceKey('abc123');
    const secret = generateGrantSecret();
    const pending = store.createPendingGrant(workspace.id, 'deck-1', secret);
    store.activateGrant(pending.id);

    const grant = store.findActiveGrantBySecret(secret);
    expect(grant?.deck_id).toBe('deck-1');

    const session = store.createRuntimeSession({
      workspaceKeyId: workspace.id,
      workspaceGrantId: grant!.id,
      deckId: grant!.deck_id,
    });
    expect(session.mode).toBe('normal');
    expect(session.deckId).toBe('deck-1');
  });

  it('elevates and downgrades admin mode', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const workspace = store.getOrCreateWorkspaceKey('def456');
    const secret = generateGrantSecret();
    const pending = store.createPendingGrant(workspace.id, 'deck-2', secret);
    store.activateGrant(pending.id);
    const grant = store.findActiveGrantBySecret(secret)!;
    const session = store.createRuntimeSession({
      workspaceKeyId: workspace.id,
      workspaceGrantId: grant.id,
      deckId: grant.deck_id,
    });

    const challenge = store.createAdminChallenge(session.sessionId);
    expect(store.consumeAdminChallenge(challenge.id, session.sessionId)).toBe(true);

    const elevated = store.elevateSessionToAdmin(session.sessionId);
    expect(elevated?.mode).toBe('agent-admin');

    const normal = store.downgradeSessionToNormal(session.sessionId);
    expect(normal?.mode).toBe('normal');
  });

  it('lists unconsumed admin challenges for menubar', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const workspace = store.getOrCreateWorkspaceKey('menubar');
    const secret = generateGrantSecret();
    const pending = store.createPendingGrant(workspace.id, 'deck-m', secret);
    store.activateGrant(pending.id);
    const grant = store.findActiveGrantBySecret(secret)!;
    const session = store.createRuntimeSession({
      workspaceKeyId: workspace.id,
      workspaceGrantId: grant.id,
      deckId: grant.deck_id,
    });
    const challenge = store.createAdminChallenge(session.sessionId);
    const listed = store.listPendingAdminChallenges();
    expect(listed).toHaveLength(1);
    expect(listed[0].challengeId).toBe(challenge.id);
  });

  it('pending grants are inactive until activation (C7)', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const workspace = store.getOrCreateWorkspaceKey('c7-test');
    const secret = generateGrantSecret();
    const pending = store.createPendingGrant(workspace.id, 'deck-c7', secret);

    expect(store.findActiveGrantBySecret(secret)).toBeNull();
    store.activateGrant(pending.id);
    expect(store.findActiveGrantBySecret(secret)?.status).toBe('active');
  });

  it('reuses runtime session for the same MCP transport id', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const workspace = store.getOrCreateWorkspaceKey('reuse');
    const secret = generateGrantSecret();
    const pending = store.createPendingGrant(workspace.id, 'deck-r', secret);
    store.activateGrant(pending.id);
    const grant = store.findActiveGrantBySecret(secret)!;

    const first = store.createRuntimeSession({
      workspaceKeyId: workspace.id,
      workspaceGrantId: grant.id,
      deckId: grant.deck_id,
      mcpSessionId: 'mcp-transport-1',
    });
    store.elevateSessionToAdmin(first.sessionId);

    const reused = store.findActiveRuntimeSessionForMcp('mcp-transport-1', grant.id);
    expect(reused?.sessionId).toBe(first.sessionId);
    expect(reused?.mode).toBe('agent-admin');
  });

  it('keeps mcp-session ownership after runtime revoke (NOT-53)', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const workspace = store.getOrCreateWorkspaceKey('own');
    const secretA = generateGrantSecret();
    const secretB = generateGrantSecret();
    const pendingA = store.createPendingGrant(workspace.id, 'deck-a', secretA);
    store.activateGrant(pendingA.id);
    const grantA = store.findActiveGrantBySecret(secretA)!;

    // Second grant on another workspace key (one active grant per workspace).
    const workspaceB = store.getOrCreateWorkspaceKey('own-b');
    const pendingB = store.createPendingGrant(workspaceB.id, 'deck-b', secretB);
    store.activateGrant(pendingB.id);
    const grantB = store.findActiveGrantBySecret(secretB)!;

    const session = store.createRuntimeSession({
      workspaceKeyId: workspace.id,
      workspaceGrantId: grantA.id,
      deckId: grantA.deck_id,
      mcpSessionId: 'mcp-owned',
    });
    store.revokeRuntimeSession(session.sessionId);

    expect(store.findActiveRuntimeSessionByMcpSessionId('mcp-owned')).toBeNull();
    const historical = store.findLatestRuntimeSessionByMcpSessionId('mcp-owned');
    expect(historical?.workspaceGrantId).toBe(grantA.id);
    expect(historical?.workspaceGrantId).not.toBe(grantB.id);
  });

  it('rotates grant for elevated session and revokes peers (C8)', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const workspace = store.getOrCreateWorkspaceKey('c8-rotate');
    const secret = generateGrantSecret();
    const pending = store.createPendingGrant(workspace.id, 'deck-a', secret);
    store.activateGrant(pending.id);
    const grant = store.findActiveGrantBySecret(secret)!;

    const admin = store.createRuntimeSession({
      workspaceKeyId: workspace.id,
      workspaceGrantId: grant.id,
      deckId: 'deck-a',
      mcpSessionId: 'mcp-admin',
    });
    store.elevateSessionToAdmin(admin.sessionId);

    const peer = store.createRuntimeSession({
      workspaceKeyId: workspace.id,
      workspaceGrantId: grant.id,
      deckId: 'deck-a',
      mcpSessionId: 'mcp-peer',
    });

    const rotated = store.rotateGrantForElevatedSession(admin.sessionId, 'deck-b');
    expect(rotated?.session.deckId).toBe('deck-b');
    expect(rotated?.peersRevoked).toBe(1);

    const peerRow = store.getRuntimeSessionRow(peer.sessionId);
    expect(peerRow?.revoked_at).toBeTruthy();

    const adminRow = store.getRuntimeSessionRow(admin.sessionId);
    expect(adminRow?.revoked_at).toBeFalsy();
    expect(adminRow?.mode).toBe('agent-admin');
  });

  it('creates a launch session with null workspace key and grant (NOT-105)', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const session = store.createRuntimeSession({
      workspaceKeyId: null,
      workspaceGrantId: null,
      deckId: 'deck-launch',
      mcpSessionId: 'mcp-launch-1',
    });
    expect(session.workspaceKey).toBeNull();
    expect(session.workspaceGrantId).toBeNull();
    expect(session.deckId).toBe('deck-launch');

    const found = store.findActiveLaunchSessionForMcp('mcp-launch-1', 'deck-launch');
    expect(found?.sessionId).toBe(session.sessionId);
  });

  it('migrates runtime_sessions NOT NULL columns to nullable (NOT-105)', () => {
    const manager = new DatabaseManager(`:memory:${Math.random()}`);
    const db = manager.getSqliteDatabase();

    db.exec(`
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
      DROP TABLE IF EXISTS admin_challenges;
      DROP TABLE IF EXISTS runtime_sessions;
      CREATE TABLE runtime_sessions (
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
      CREATE TABLE admin_challenges (
        id TEXT PRIMARY KEY,
        runtime_session_id TEXT NOT NULL,
        consumed_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (runtime_session_id) REFERENCES runtime_sessions (id)
      );
    `);

    db.prepare(
      `INSERT INTO workspace_keys (id, path_digest, created_at) VALUES (?, ?, ?)`,
    ).run('wsp_old', 'digest-old', '2020-01-01T00:00:00.000Z');
    db.prepare(
      `INSERT INTO workspace_grants
       (id, workspace_key_id, deck_id, secret_hash, status, created_at, activated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      'wgr_old',
      'wsp_old',
      'deck-old',
      'a'.repeat(64),
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO runtime_sessions
       (id, mcp_session_id, workspace_key_id, workspace_grant_id, deck_id, mode,
        last_seen_at, expires_at, admin_expires_at)
       VALUES (?, ?, ?, ?, ?, 'normal', ?, ?, NULL)`,
    ).run(
      'ses_old',
      'mcp-old',
      'wsp_old',
      'wgr_old',
      'deck-old',
      '2020-01-01T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z',
    );

    const before = db.pragma('table_info(runtime_sessions)') as Array<{
      name: string;
      notnull: number;
    }>;
    expect(before.find((c) => c.name === 'workspace_key_id')?.notnull).toBe(1);

    const store = new TrustedSessionStore(db);
    const after = db.pragma('table_info(runtime_sessions)') as Array<{
      name: string;
      notnull: number;
    }>;
    expect(after.find((c) => c.name === 'workspace_key_id')?.notnull).toBe(0);
    expect(after.find((c) => c.name === 'workspace_grant_id')?.notnull).toBe(0);

    const launch = store.createRuntimeSession({
      workspaceKeyId: null,
      workspaceGrantId: null,
      deckId: 'deck-new',
    });
    expect(launch.workspaceKey).toBeNull();
    expect(launch.workspaceGrantId).toBeNull();
  });
});
