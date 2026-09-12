import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ExecutionAuthorityStore } from './store';

describe('ExecutionAuthorityStore (NOT-86 durable)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives restart: enroll → mint → inspect without secret re-issue', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-store-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'test.db');

    const db1 = new Database(dbPath);
    const store1 = new ExecutionAuthorityStore(db1);
    const enrolled = store1.enrollCoordinator({
      coordinatorId: 'coord-1',
      allowedDeckIds: ['deck_a'],
    });
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;

    const minted = store1.mintAuthority({
      enrollmentId: enrolled.data.enrollment.enrollmentId,
      runId: 'run_1',
      attemptId: 'attempt_1',
      deckId: 'deck_a',
      audience: 'dealer-worker',
      idempotencyKey: 'run_1:attempt_1',
      allowedServices: ['svc_1'],
      allowedTools: [{ serviceId: 'svc_1', toolName: 'ping' }],
      ttlMs: 60_000,
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const authorityId = minted.data.authority.authorityId;
    const secret = minted.data.authoritySecret!;
    db1.close();

    const db2 = new Database(dbPath);
    const store2 = new ExecutionAuthorityStore(db2);
    const inspected = store2.inspectAuthority(authorityId);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.data.status).toBe('live');

    const remint = store2.mintAuthority({
      enrollmentId: enrolled.data.enrollment.enrollmentId,
      runId: 'run_1',
      attemptId: 'attempt_1',
      deckId: 'deck_a',
      audience: 'dealer-worker',
      idempotencyKey: 'run_1:attempt_1',
      allowedServices: ['svc_1'],
      allowedTools: [{ serviceId: 'svc_1', toolName: 'ping' }],
      ttlMs: 60_000,
    });
    expect(remint.ok).toBe(true);
    if (!remint.ok) return;
    expect(remint.data.secretIssued).toBe(false);
    expect(remint.data.authoritySecret).toBeNull();

    const auth = store2.authenticateAuthority(authorityId, secret);
    expect(auth.ok).toBe(true);
    db2.close();
  });
});
