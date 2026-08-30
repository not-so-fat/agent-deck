import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { TrustedSessionStore, generateGrantSecret } from './store';

describe('TrustedSessionStore', () => {
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
});
