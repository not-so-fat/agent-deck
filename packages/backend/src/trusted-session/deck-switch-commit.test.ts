import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function makeWorkspaceRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-switch-'));
}

function useJsonPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.agent-deck', 'use.json');
}

function writeUseJson(
  workspaceRoot: string,
  manifest: Record<string, unknown>,
): void {
  fs.mkdirSync(path.join(workspaceRoot, '.agent-deck'), { recursive: true });
  fs.writeFileSync(useJsonPath(workspaceRoot), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function readUseJson(workspaceRoot: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(useJsonPath(workspaceRoot), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function deckWorkspaceRows(db: DatabaseManager): Array<{ workspaceRoot: string; deckId: string }> {
  const rows = db
    .getSqliteDatabase()
    .prepare(`SELECT workspace_root, deck_id FROM deck_workspaces ORDER BY workspace_root, deck_id`)
    .all() as Array<{ workspace_root: string; deck_id: string }>;
  return rows.map((row) => ({ workspaceRoot: row.workspace_root, deckId: row.deck_id }));
}

describe('TrustedSessionStore deck-switch approval commit (NOT-207)', () => {
  it('session decision rebinds only the session and leaves use.json on A', async () => {
    const { store, deckA, deckB } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseJson(workspaceRoot, { version: 3, deckId: deckA.id, deckName: 'deck-a' });
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
    });

    const result = store.applyDeckSwitchResolution(request.requestId, session.sessionId, 'session');

    expect(result.outcome).toBe('resolved');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckB.id);
    expect(readUseJson(workspaceRoot)).toMatchObject({ version: 3, deckId: deckA.id });
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('consumed');
  });

  it('workspace-default rebinds the session and writes use.json to B', async () => {
    const { store, deckA, deckB } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseJson(workspaceRoot, { version: 3, deckId: deckA.id, deckName: 'deck-a' });
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
    });

    const result = store.applyDeckSwitchResolution(
      request.requestId,
      session.sessionId,
      'workspace-default',
    );

    expect(result.outcome).toBe('resolved');
    if (result.outcome === 'resolved') {
      expect(result.workspaceRoot).toBe(workspaceRoot);
    }
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckB.id);
    expect(readUseJson(workspaceRoot)).toMatchObject({
      version: 3,
      deckId: deckB.id,
      deckName: 'deck-b',
    });
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('consumed');
  });

  it('workspace-default preserves the existing mcpUrl', async () => {
    const { store, deckA, deckB } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseJson(workspaceRoot, {
      version: 3,
      deckId: deckA.id,
      deckName: 'deck-a',
      mcpUrl: 'http://127.0.0.1:4020/mcp',
    });
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
    });

    const result = store.applyDeckSwitchResolution(
      request.requestId,
      session.sessionId,
      'workspace-default',
    );

    expect(result.outcome).toBe('resolved');
    expect(readUseJson(workspaceRoot)).toMatchObject({
      version: 3,
      deckId: deckB.id,
      mcpUrl: 'http://127.0.0.1:4020/mcp',
    });
  });

  it('workspace-default never touches the deck_workspaces stub-sync registry', async () => {
    const { db, store, deckA, deckB } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseJson(workspaceRoot, { version: 3, deckId: deckA.id, deckName: 'deck-a' });
    await db.upsertDeckWorkspace(workspaceRoot, deckA.id);
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
    });

    const result = store.applyDeckSwitchResolution(
      request.requestId,
      session.sessionId,
      'workspace-default',
    );

    expect(result.outcome).toBe('resolved');
    // Deck A's stub-sync registration for the folder survives; the registry
    // is not the assignment source of truth and must not be pruned.
    expect(deckWorkspaceRows(db)).toEqual([{ workspaceRoot, deckId: deckA.id }]);
    expect(readUseJson(workspaceRoot)).toMatchObject({ deckId: deckB.id });
  });

  it('decline leaves both bindings unchanged', async () => {
    const { store, deckA, deckB } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseJson(workspaceRoot, { version: 3, deckId: deckA.id, deckName: 'deck-a' });
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
    });

    const result = store.applyDeckSwitchResolution(request.requestId, session.sessionId, 'decline');

    expect(result.outcome).toBe('declined');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(readUseJson(workspaceRoot)).toMatchObject({ deckId: deckA.id });
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('declined');
  });

  it('repeat resolution is already-resolved with no second mutation', async () => {
    const { db, store, deckA, deckB } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
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
    const workspaceRoot = makeWorkspaceRoot();
    writeUseJson(workspaceRoot, { version: 3, deckId: deckA.id, deckName: 'deck-a' });
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
    });
    db.getSqliteDatabase()
      .prepare(`UPDATE deck_switch_requests SET expires_at = ? WHERE id = ?`)
      .run('2000-01-01T00:00:00.000Z', request.requestId);

    const result = store.applyDeckSwitchResolution(request.requestId, session.sessionId, 'session');

    expect(result.outcome).toBe('expired');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(readUseJson(workspaceRoot)).toMatchObject({ deckId: deckA.id });
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('expired');
  });

  it('resolving an already-expired request is stably expired, not consumed', async () => {
    const { db, store, deckA, deckB } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
    });
    db.getSqliteDatabase()
      .prepare(`UPDATE deck_switch_requests SET expires_at = ? WHERE id = ?`)
      .run('2000-01-01T00:00:00.000Z', request.requestId);

    expect(
      store.applyDeckSwitchResolution(request.requestId, session.sessionId, 'session').outcome,
    ).toBe('expired');
    const repeat = store.applyDeckSwitchResolution(
      request.requestId,
      session.sessionId,
      'workspace-default',
    );

    expect(repeat.outcome).toBe('expired');
    if (repeat.outcome === 'expired') {
      expect(repeat.request.status).toBe('expired');
    }
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
  });

  it('wrong-session resolution is unauthorized and keeps the request pending', async () => {
    const { store, deckA, deckB } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const other = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
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

  it('unknown target deck fails without mutating the session or the file', async () => {
    const { store, deckA } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseJson(workspaceRoot, { version: 3, deckId: deckA.id, deckName: 'deck-a' });
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: '00000000-0000-4000-8000-000000000099',
      workspaceRoot,
    });

    const result = store.applyDeckSwitchResolution(
      request.requestId,
      session.sessionId,
      'workspace-default',
    );

    expect(result.outcome).toBe('target-missing');
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckA.id);
    expect(readUseJson(workspaceRoot)).toMatchObject({ deckId: deckA.id });
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });

  it('revoked sessions fail without consuming the request or writing the file', async () => {
    const { store, deckA, deckB } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseJson(workspaceRoot, { version: 3, deckId: deckA.id, deckName: 'deck-a' });
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
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

  it('assignment write failure leaves the session on A with the request pending', async () => {
    const { store, deckA, deckB } = await setupDecks();
    const workspaceRoot = makeWorkspaceRoot();
    writeUseJson(workspaceRoot, { version: 3, deckId: deckA.id, deckName: 'deck-a' });
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
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
    expect(readUseJson(workspaceRoot)).toMatchObject({ deckId: deckA.id });
    expect(store.getDeckSwitchRequest(request.requestId)?.status).toBe('pending');
  });

  it('constructor-level assignment seam is honored for workspace-default', async () => {
    const db = new DatabaseManager(':memory:');
    const written: Array<{ workspaceRoot: string; deckId: string }> = [];
    const store = new TrustedSessionStore(db.getSqliteDatabase(), {
      workspaceAssignmentWriter: (workspaceRoot, deckId) => {
        written.push({ workspaceRoot, deckId });
      },
    });
    const deckA = await db.createDeck({ name: 'deck-a' });
    const deckB = await db.createDeck({ name: 'deck-b' });
    const workspaceRoot = makeWorkspaceRoot();
    const session = store.createRuntimeSession({ deckId: deckA.id });
    const request = store.createDeckSwitchRequest({
      runtimeSessionId: session.sessionId,
      currentDeckId: deckA.id,
      requestedDeckId: deckB.id,
      workspaceRoot,
    });

    const result = store.applyDeckSwitchResolution(
      request.requestId,
      session.sessionId,
      'workspace-default',
    );

    expect(result.outcome).toBe('resolved');
    expect(written).toEqual([{ workspaceRoot, deckId: deckB.id }]);
    expect(store.getRuntimeSessionRow(session.sessionId)?.deck_id).toBe(deckB.id);
  });
});
