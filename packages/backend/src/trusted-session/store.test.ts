import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { DatabaseManager } from '../models/database';
import {
  TrustedSessionStore,
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

  it('creates runtime sessions for a deck', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const session = store.createRuntimeSession({ deckId: 'deck-1' });
    expect(session.mode).toBe('normal');
    expect(session.deckId).toBe('deck-1');
  });

  it('elevates and downgrades admin mode', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const session = store.createRuntimeSession({ deckId: 'deck-2' });

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
    const session = store.createRuntimeSession({ deckId: 'deck-m' });
    const challenge = store.createAdminChallenge(session.sessionId);
    const listed = store.listPendingAdminChallenges();
    expect(listed).toHaveLength(1);
    expect(listed[0].challengeId).toBe(challenge.id);
  });

  it('reuses launch session for the same MCP transport id and deck', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);

    const first = store.createRuntimeSession({
      deckId: 'deck-r',
      mcpSessionId: 'mcp-transport-1',
    });
    store.elevateSessionToAdmin(first.sessionId);

    const reused = store.findActiveLaunchSessionForMcp('mcp-transport-1', 'deck-r');
    expect(reused?.sessionId).toBe(first.sessionId);
    expect(reused?.mode).toBe('agent-admin');
  });

  it('keeps mcp-session ownership by deck after runtime revoke (NOT-53)', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);

    const session = store.createRuntimeSession({
      deckId: 'deck-a',
      mcpSessionId: 'mcp-owned',
    });
    store.revokeRuntimeSession(session.sessionId);

    expect(store.findActiveRuntimeSessionByMcpSessionId('mcp-owned')).toBeNull();
    const historical = store.findLatestRuntimeSessionByMcpSessionId('mcp-owned');
    expect(historical?.deckId).toBe('deck-a');
    expect(historical?.deckId).not.toBe('deck-b');
  });

  it('setRuntimeSessionDeck switches deck for elevated sessions only', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const session = store.createRuntimeSession({ deckId: 'deck-a' });

    expect(store.setRuntimeSessionDeck(session.sessionId, 'deck-b')).toBeNull();

    store.elevateSessionToAdmin(session.sessionId);
    const updated = store.setRuntimeSessionDeck(session.sessionId, 'deck-b');
    expect(updated?.deckId).toBe('deck-b');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe('deck-b');
  });

  it('creates a launch session with mcpSessionId (NOT-105)', () => {
    const db = new Database(':memory:');
    const store = new TrustedSessionStore(db);
    const session = store.createRuntimeSession({
      deckId: 'deck-launch',
      mcpSessionId: 'mcp-launch-1',
    });
    expect(session.deckId).toBe('deck-launch');
    expect(session.mcpSessionId).toBe('mcp-launch-1');

    const found = store.findActiveLaunchSessionForMcp('mcp-launch-1', 'deck-launch');
    expect(found?.sessionId).toBe(session.sessionId);
  });

  it('migrates away grant columns and drops grant tables (NOT-108)', () => {
    const manager = new DatabaseManager(':memory:');
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
    }>;
    expect(before.some((c) => c.name === 'workspace_grant_id')).toBe(true);

    const store = new TrustedSessionStore(db);
    const after = db.pragma('table_info(runtime_sessions)') as Array<{
      name: string;
    }>;
    expect(after.some((c) => c.name === 'workspace_key_id')).toBe(false);
    expect(after.some((c) => c.name === 'workspace_grant_id')).toBe(false);
    expect(
      (db.pragma('table_info(workspace_grants)') as Array<{ name: string }>).length,
    ).toBe(0);
    expect(
      (db.pragma('table_info(workspace_keys)') as Array<{ name: string }>).length,
    ).toBe(0);

    const launch = store.createRuntimeSession({
      deckId: 'deck-new',
    });
    expect(launch.deckId).toBe('deck-new');
  });
});
