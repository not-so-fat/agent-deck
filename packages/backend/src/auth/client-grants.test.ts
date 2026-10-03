/**
 * NOT-318: ClientGrantStore unit tests.
 *
 * Evidence for: token issuance stores no recoverable Bearer [REDACTED] and
 * lookup is stable across restart.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ClientGrantStore,
  GRANT_VERIFIER_VERSION,
  OWNER_INSTALLATION_ID,
  parseGrantToken,
  principalAllowsDeck,
  resolveGrantDeck,
  type ClientPrincipal,
} from './client-grants';

function openStore(file?: string): { db: Database.Database; store: ClientGrantStore } {
  const db = file ? new Database(file) : new Database(':memory:');
  return { db, store: new ClientGrantStore(db) };
}

function secretOf(token: string): string {
  const parsed = parseGrantToken(token);
  expect(parsed).not.toBeNull();
  return parsed!.secret;
}

describe('ClientGrantStore issuance (NOT-318)', () => {
  const dbs: Database.Database[] = [];
  const tempDirs: string[] = [];
  afterEach(() => {
    while (dbs.length) {
      dbs.pop()?.close();
    }
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('issues 256-bit secrets and persists only a versioned verifier', () => {
    const { db, store } = openStore();
    dbs.push(db);
    const issued = store.issueGrant({ label: 'field-agent', defaultDeck: 'deck-a' });

    // 32 bytes of entropy, base64url-encoded.
    const entropyBytes = Buffer.from(secretOf(issued.token), 'base64url').length;
    expect(entropyBytes).toBeGreaterThanOrEqual(32);

    const rows = db.prepare('SELECT * FROM agent_grants').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].verifier_version).toBe(GRANT_VERIFIER_VERSION);
    expect(rows[0].installation_id).toBe(OWNER_INSTALLATION_ID);

    // No recoverable Bearer [REDACTED] anywhere in the persisted row: neither the
    // full token, nor the raw secret, appears in any column value.
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain(issued.token);
    expect(dumped).not.toContain(secretOf(issued.token));

    // The stored verifier is a SHA-256 hex digest of the secret (64 chars),
    // not the secret itself.
    expect(rows[0].secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].secret_hash).not.toBe(secretOf(issued.token));
  });

  it('authenticates the issued token and survives a store restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-grants-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'grants.db');

    const first = openStore(file);
    const issued = first.store.issueGrant({
      label: 'restart-probe',
      defaultDeck: 'deck-a',
      allowedDecks: ['deck-a', 'deck-b'],
    });
    const before = first.store.authenticateToken(issued.token);
    expect(before).toMatchObject({ kind: 'grant', grantId: issued.grant.id });
    first.db.close();

    // Recreate the store over the same file: lookup is stable across restart.
    const second = openStore(file);
    dbs.push(second.db);
    const after = second.store.authenticateToken(issued.token);
    expect(after).toMatchObject({
      kind: 'grant',
      grantId: issued.grant.id,
      label: 'restart-probe',
      defaultDeck: 'deck-a',
      allowedDecks: ['deck-a', 'deck-b'],
    });
  });

  it('rejects unknown ids and wrong secrets without an oracle', () => {
    const { db, store } = openStore();
    dbs.push(db);
    const issued = store.issueGrant({ label: 'oracle', defaultDeck: 'deck-a' });
    const parsed = parseGrantToken(issued.token)!;

    expect(store.authenticateToken('adg_nope_wrongsecret')).toBeNull();
    expect(store.authenticateToken(`adg_${parsed.grantId}_wrongsecret`)).toBeNull();
    expect(store.authenticateToken('Bearer junk')).toBeNull();
    expect(store.authenticateToken('')).toBeNull();
    // The valid token still works afterwards.
    expect(store.authenticateToken(issued.token)).not.toBeNull();
  });

  it('fails expired and revoked grants on every mode', () => {
    const { db, store } = openStore();
    dbs.push(db);
    const expired = store.issueGrant({
      label: 'expired',
      defaultDeck: 'deck-a',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(store.authenticateToken(expired.token)).toBeNull();

    const revoked = store.issueGrant({ label: 'revoked', defaultDeck: 'deck-a' });
    expect(store.authenticateToken(revoked.token)).not.toBeNull();
    expect(store.revokeGrant(revoked.grant.id)).toBe(true);
    expect(store.authenticateToken(revoked.token)).toBeNull();
    expect(store.revokeGrant('ag_does-not-exist')).toBe(false);
  });

  it('touches lastUsedAt on success only', () => {
    const { db, store } = openStore();
    dbs.push(db);
    const issued = store.issueGrant({ label: 'touch', defaultDeck: 'deck-a' });
    expect(store.getGrant(issued.grant.id)?.lastUsedAt).toBeNull();
    store.authenticateToken(issued.token);
    expect(store.getGrant(issued.grant.id)?.lastUsedAt).not.toBeNull();

    const failing = store.issueGrant({ label: 'no-touch', defaultDeck: 'deck-a' });
    const parsed = parseGrantToken(failing.token)!;
    store.authenticateToken(`adg_${parsed.grantId}_wrong`);
    expect(store.getGrant(failing.grant.id)?.lastUsedAt).toBeNull();
  });

  it('keeps the default deck inside the allowlist', () => {
    const { db, store } = openStore();
    dbs.push(db);
    const issued = store.issueGrant({
      label: 'allowlist',
      defaultDeck: 'deck-a',
      allowedDecks: ['deck-b'],
    });
    expect(issued.grant.allowedDecks).toEqual(expect.arrayContaining(['deck-a', 'deck-b']));
  });
});

describe('grant principal deck resolution (NOT-318)', () => {
  const grant = (allowedDecks: string[], defaultDeck = 'deck-a'): Extract<ClientPrincipal, { kind: 'grant' }> => ({
    kind: 'grant',
    grantId: 'ag_test',
    label: 'test',
    defaultDeck,
    allowedDecks,
  });

  it('uses the grant default when no deck is requested', () => {
    expect(resolveGrantDeck(grant(['deck-a', 'deck-b']), undefined)).toBe('deck-a');
    expect(resolveGrantDeck(grant(['deck-a', 'deck-b']), '  ')).toBe('deck-a');
  });

  it('allows an explicitly requested deck inside the grant', () => {
    expect(resolveGrantDeck(grant(['deck-a', 'deck-b']), 'deck-b')).toBe('deck-b');
  });

  it('denies a requested deck outside the grant without falling back', () => {
    expect(resolveGrantDeck(grant(['deck-a']), 'deck-evil')).toBeNull();
  });

  it('resolves local and grant principals through one allowlist check', () => {
    const local: ClientPrincipal = { kind: 'local' };
    expect(principalAllowsDeck(local, 'any-deck')).toBe(true);
    expect(principalAllowsDeck(grant(['deck-a']), 'deck-a')).toBe(true);
    expect(principalAllowsDeck(grant(['deck-a']), 'deck-other')).toBe(false);
  });

  it('rejects malformed tokens without distinguishing them', () => {
    expect(parseGrantToken('')).toBeNull();
    expect(parseGrantToken('Bearer abc')).toBeNull();
    expect(parseGrantToken('adg_onlyid')).toBeNull();
    expect(parseGrantToken('adg__secret')).toBeNull();
    expect(parseGrantToken('adg_id_')).toBeNull();
    // Surrounding whitespace is trimmed; the id shape stays enforced.
    expect(parseGrantToken('  adg_ag_12345678-1234-1234-1234-1234567890ab_secret  ')).not.toBeNull();
    expect(parseGrantToken('  adg_x_y  ')).toBeNull();
    // Issued secrets are base64url and may contain `_`: the id shape anchors
    // the split, so the full remainder stays the secret.
    expect(
      parseGrantToken('adg_ag_12345678-1234-1234-1234-1234567890ab_ab_cd-ef'),
    ).toEqual({
      grantId: 'ag_12345678-1234-1234-1234-1234567890ab',
      secret: 'ab_cd-ef',
    });
  });
});
