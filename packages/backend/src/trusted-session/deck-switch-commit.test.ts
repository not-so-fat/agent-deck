import { describe, expect, it } from 'vitest';

import { DatabaseManager } from '../models/database';
import { TrustedSessionStore } from './store';

function setup() {
  const db = new DatabaseManager(':memory:');
  const store = new TrustedSessionStore(db.getSqliteDatabase());
  return { db, store };
}

async function setupDecks() {
  const { db, store } = setup();
  const deckA = await db.createDeck({ name: 'deck-a' });
  const deckB = await db.createDeck({ name: 'deck-b' });
  return { db, store, deckA, deckB };
}

function workspaceBindings(db: DatabaseManager): Array<{ workspaceRoot: string; deckId: string }> {
  const rows = db
    .getSqliteDatabase()
    .prepare(`SELECT workspace_root, deck_id FROM deck_workspaces ORDER BY workspace_root, deck_id`)
    .all() as Array<{ workspace_root: string; deck_id: string }>;
  return rows.map((row) => ({ workspaceRoot: row.workspace_root, deckId: row.deck_id }));
}

describe('TrustedSessionStore deck-switch approval commit (NOT-207)', () => {
  it('session decision rebinds only the session and consumes the request', async () => {
    const { db, store, deckA, deckB } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    await db.upsertDeckWorkspace('/work/ws', deckA.id);
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const result = store.applyDeckSwitchResolution(request.requestId, session.sessionId, 'session');

    expect(result.outcome).toBe('resolved');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckB.id);
    expect(workspaceBindings(db)).toEqual([{ workspaceRoot: '/work/ws', deckId: deckA.id }]);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('consumed');
  });

  it('workspace-default rebinds the session and replaces the workspace assignment', async () => {
    const { db, store, deckA, deckB } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    await db.upsertDeckWorkspace('/work/ws', deckA.id);
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const result = store.applyDeckSwitchResolution(
      request.requestId,
      session.sessionId,
      'workspace-default',
    );

    expect(result.outcome).toBe('resolved');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckB.id);
    expect(workspaceBindings(db)).toEqual([{ workspaceRoot: '/work/ws', deckId: deckB.id }]);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('consumed');
  });

  it('decline leaves both bindings unchanged', async () => {
    const { db, store, deckA, deckB } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    await db.upsertDeckWorkspace('/work/ws', deckA.id);
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const result = store.applyDeckSwitchResolution(request.requestId, session.sessionId, 'decline');

    expect(result.outcome).toBe('declined');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(workspaceBindings(db)).toEqual([{ workspaceRoot: '/work/ws', deckId: deckA.id }]);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('declined');
  });

  it('repeat resolution is already-resolved with no second mutation', async () => {
    const { db, store, deckA, deckB } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    expect(
      store.applyDeckSwitchResolution(request.requestId, session.sessionId, 'session').outcome,
    ).toBe('resolved');
    const deckC = await db.createDeck({ name: 'deck-c' });
    db.getSqliteDatabase()
      .prepare(`UPDATE runtime_sessions SET deck_id = ? WHERE id = ?`)
      .run(deckC.id, session.sessionId);

    const repeat = store.applyDeckSwitchResolution(request.requestId, session.sessionId, 'session');

    expect(repeat.outcome).toBe('already-resolved');
    if (repeat.outcome === 'already-resolved') {
      expect(repeat.request.status).toBe('consumed');
    }
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckC.id);
  });

  it('expired requests cannot resolve and leave bindings unchanged', async () => {
    const { db, store, deckA, deckB } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });
    db.getSqliteDatabase()
      .prepare(`UPDATE deck_switch_requests SET expires_at = ? WHERE id = ?`)
      .run('2000-01-01T00:00:00.000Z', request.requestId);

    const result = store.applyDeckSwitchResolution(request.requestId, session.sessionId, 'session');

    expect(result.outcome).toBe('expired');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(workspaceBindings(db)).toEqual([]);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('expired');
  });

  it('wrong-session resolution is unauthorized and keeps the request pending', async () => {
    const { store, deckA, deckB } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const other = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const result = store.applyDeckSwitchResolution(
      request.requestId,
      other.sessionId,
      'workspace-default',
    );

    expect(result.outcome).toBe('unauthorized');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });

  it('missing requests resolve to not-found', async () => {
    const { store, deckA } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });

    expect(store.applyDeckSwitchResolution('req_missing', session.sessionId, 'session')).toEqual({
      outcome: 'not-found',
    });
  });

  it('unknown target deck fails without mutating the session', async () => {
    const { db, store, deckA } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    await db.upsertDeckWorkspace('/work/ws', deckA.id);
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: '00000000-0000-4000-8000-000000000099',
      workspaceRoot: '/work/ws',
    });

    const result = store.applyDeckSwitchResolution(
      request.requestId,
      session.sessionId,
      'workspace-default',
    );

    expect(result.outcome).toBe('target-missing');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(workspaceBindings(db)).toEqual([{ workspaceRoot: '/work/ws', deckId: deckA.id }]);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });

  it('revoked sessions fail without consuming the request', async () => {
    const { store, deckA, deckB } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });
    store.revokeRuntimeSession(session.sessionId);

    const result = store.applyDeckSwitchResolution(request.requestId, session.sessionId, 'session');

    expect(result.outcome).toBe('session-invalid');
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });

  it('workspace-default without a workspace root fails without mutating', async () => {
    const { store, deckA, deckB } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
    });

    const result = store.applyDeckSwitchResolution(
      request.requestId,
      session.sessionId,
      'workspace-default',
    );

    expect(result.outcome).toBe('workspace-required');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });

  it('assignment write failure rolls back the session rebind', async () => {
    const { db, store, deckA, deckB } = await setupDecks();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    await db.upsertDeckWorkspace('/work/ws', deckA.id);
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot: '/work/ws',
    });

    const result = store.applyDeckSwitchResolution(
      request.requestId,
      session.sessionId,
      'workspace-default',
      {
        writeWorkspaceAssignment: () => {
          throw new Error('disk full');
        },
      },
    );

    expect(result.outcome).toBe('assignment-failed');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(workspaceBindings(db)).toEqual([{ workspaceRoot: '/work/ws', deckId: deckA.id }]);
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });
});
