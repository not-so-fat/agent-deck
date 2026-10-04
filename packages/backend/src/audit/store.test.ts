import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { AUDIT_RETENTION_MS, AuditStore } from './store';

describe('AuditStore', () => {
  it('stores only the fixed audit fields and returns newest first', () => {
    const db = new Database(':memory:');
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new AuditStore(db, () => now);
    const first = store.append({
      actor: 'owner', event: 'grant.created', targetId: 'ag_one', outcome: 'succeeded', reasonCode: null,
    });
    now += 1;
    const second = store.append({
      actor: 'ag_one', event: 'grant.used', targetId: 'deck_one', outcome: 'succeeded', reasonCode: null,
    });

    expect(store.list({ limit: 10 }).map((row) => row.id)).toEqual([second.id, first.id]);
    expect(Object.keys(store.list({ limit: 1 })[0]).sort()).toEqual([
      'actor', 'event', 'id', 'installationId', 'outcome', 'reasonCode', 'targetId', 'timestamp',
    ]);
    db.close();
  });

  it('pages by row id without duplicates', () => {
    const db = new Database(':memory:');
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new AuditStore(db, () => now);
    const ids = Array.from({ length: 3 }, (_, index) => {
      now += index;
      return store.append({
        actor: 'owner', event: 'grant.created', targetId: `ag_${index}`, outcome: 'succeeded', reasonCode: null,
      }).id;
    });
    const firstPage = store.list({ limit: 2 });
    const secondPage = store.list({ limit: 2, before: firstPage[1].id });
    expect([...firstPage, ...secondPage].map((row) => row.id)).toEqual(ids.reverse());
    db.close();
  });

  it('prunes entries older than 90 days on startup with a fake clock', () => {
    const db = new Database(':memory:');
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const initial = new AuditStore(db, () => now);
    initial.append({
      actor: 'owner', event: 'owner.sign_in_succeeded', targetId: 'owner', outcome: 'succeeded', reasonCode: null,
    });
    now += AUDIT_RETENTION_MS + 24 * 60 * 60 * 1000;
    const restarted = new AuditStore(db, () => now);
    expect(restarted.list({ limit: 10 })).toEqual([]);
    db.close();
  });
});

