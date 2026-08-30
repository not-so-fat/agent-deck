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
});
