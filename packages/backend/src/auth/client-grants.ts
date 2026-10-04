import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type Database from 'better-sqlite3';

/**
 * NOT-318: per-agent remote grants for the single-owner hosted appliance.
 *
 * Two boundaries live here:
 *
 * - `ClientPrincipal` — the unified authorization principal every MCP
 *   session resolves to. Loopback launcher sessions resolve to `local`
 *   (unconstrained, exactly as today); remote bearer sessions resolve to
 *   `grant` (constrained by the grant allowlist). Both flow through the
 *   same deck-scope check (`principalAllowsDeck`), so the deck header can
 *   never authorize beyond the principal.
 * - `ClientGrantStore` — SQLite-backed grant metadata. V1 is one
 *   installation and one owner (`installationId` defaults to `'owner'`);
 *   the field exists so a future tenancy migration has something to
 *   partition on.
 *
 * Token format: `adg_<grantId>_<secret>` where `<secret>` carries 256
 * bits of CSPRNG entropy (32 bytes, base64url). The id prefix is
 * routing-only — it confers nothing by itself. The secret is shown once
 * at issuance; only a versioned SHA-256 verifier is persisted (suitable
 * for high-entropy tokens), compared in constant time.
 */

export const GRANT_TOKEN_PREFIX = 'adg';
/** Current verifier version. Bump when the hash construction changes. */
export const GRANT_VERIFIER_VERSION = 'v1';
/** Single-installation owner principal for V1. */
export const OWNER_INSTALLATION_ID = 'owner';

/** Unified authorization principal for one MCP session. */
export type ClientPrincipal =
  | { kind: 'local' }
  | {
      kind: 'grant';
      grantId: string;
      label: string;
      defaultDeck: string;
      allowedDecks: string[];
    };

/** Persisted grant row (never carries the bearer secret). */
export type ClientGrant = {
  id: string;
  label: string;
  verifierVersion: string;
  defaultDeck: string;
  allowedDecks: string[];
  installationId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

/** Owner-visible grant view: metadata only, never the persisted verifier. */
export type ClientGrantPublic = Omit<ClientGrant, 'verifierVersion'>;

/** Result of issuing a grant — the only moment the secret exists. */
export type IssuedGrant = {
  grant: ClientGrantPublic;
  /** Full bearer value `adg_<id>_<secret>`. Display once, then drop. */
  token: string;
};

type GrantRow = {
  id: string;
  label: string;
  verifier_version: string;
  secret_hash: string;
  default_deck: string;
  allowed_decks: string;
  installation_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Parse `adg_<grantId>_<secret>`. Returns null for anything else —
 * malformed input is indistinguishable from an unknown grant upstream.
 *
 * The split is anchored on the grant-id shape (`ag_<uuid>`), not on a
 * bare `_`: issued secrets are base64url and may themselves contain `_`,
 * so first- or last-underscore splitting misroutes roughly half of all
 * tokens. `issueGrant` is the only id minter, so the shape is closed.
 */
const GRANT_TOKEN_PATTERN = /^adg_(ag_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\S+)$/;

export function parseGrantToken(token: string): { grantId: string; secret: string } | null {
  if (typeof token !== 'string') {
    return null;
  }
  const match = GRANT_TOKEN_PATTERN.exec(token.trim());
  if (!match) {
    return null;
  }
  return { grantId: match[1], secret: match[2] };
}

/** True when the principal may serve `deckId`. Local sessions are unconstrained. */
export function principalAllowsDeck(principal: ClientPrincipal, deckId: string): boolean {
  if (principal.kind === 'local') {
    return true;
  }
  return principal.allowedDecks.includes(deckId);
}

/**
 * Resolve the effective deck for an authenticated grant: no requested deck
 * applies the grant default; a requested deck must sit inside the allowlist
 * (null = denied, never fall back — a forged header must not silently
 * land on the default).
 */
export function resolveGrantDeck(
  principal: Extract<ClientPrincipal, { kind: 'grant' }>,
  requestedDeckId?: string,
): string | null {
  const requested = requestedDeckId?.trim();
  if (!requested) {
    return principal.defaultDeck;
  }
  return principal.allowedDecks.includes(requested) ? requested : null;
}

export type IssueGrantInput = {
  label: string;
  defaultDeck: string;
  allowedDecks?: string[];
  expiresAt?: string | null;
  installationId?: string;
};

export class ClientGrantStore {
  constructor(
    private readonly db: Database.Database,
    private readonly installationId: string = OWNER_INSTALLATION_ID,
  ) {
    this.ensureTables();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_grants (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        verifier_version TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        default_deck TEXT NOT NULL,
        allowed_decks TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_grants_installation_idx
        ON agent_grants (installation_id);
    `);
  }

  /**
   * Issue a grant and its bearer secret. The returned token is the only
   * copy of the secret — persist nothing but the versioned verifier.
   */
  issueGrant(input: IssueGrantInput): IssuedGrant {
    const label = input.label?.trim();
    if (!label) {
      throw new Error('label required');
    }
    const defaultDeck = input.defaultDeck?.trim();
    if (!defaultDeck) {
      throw new Error('defaultDeck required');
    }
    const allowed = [...new Set((input.allowedDecks ?? [defaultDeck]).map((d) => d.trim()).filter(Boolean))];
    if (!allowed.includes(defaultDeck)) {
      allowed.push(defaultDeck);
    }
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
      const ms = Date.parse(input.expiresAt);
      if (!Number.isFinite(ms)) {
        throw new Error('expiresAt must be an ISO timestamp');
      }
    }

    const id = `ag_${randomUUID()}`;
    const secret = randomBytes(32).toString('base64url');
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO agent_grants
         (id, label, verifier_version, secret_hash, default_deck, allowed_decks,
          installation_id, created_at, expires_at, revoked_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        label,
        GRANT_VERIFIER_VERSION,
        hashSecret(secret),
        defaultDeck,
        JSON.stringify(allowed),
        input.installationId ?? this.installationId,
        createdAt,
        input.expiresAt ?? null,
      );
    return {
      grant: this.getGrant(id)!,
      token: `${GRANT_TOKEN_PREFIX}_${id}_${secret}`,
    };
  }

  getGrant(id: string): ClientGrantPublic | null {
    const row = this.db
      .prepare(
        `SELECT id, label, verifier_version, secret_hash, default_deck, allowed_decks,
                installation_id, created_at, expires_at, revoked_at, last_used_at
         FROM agent_grants WHERE id = ?`,
      )
      .get(id) as GrantRow | undefined;
    return row ? toPublicGrant(row) : null;
  }

  listGrants(): ClientGrantPublic[] {
    const rows = this.db
      .prepare(
        `SELECT id, label, verifier_version, secret_hash, default_deck, allowed_decks,
                installation_id, created_at, expires_at, revoked_at, last_used_at
         FROM agent_grants ORDER BY created_at ASC`,
      )
      .all() as GrantRow[];
    return rows.map(toPublicGrant);
  }

  /**
   * Authenticate a bearer token. Returns the grant principal on success,
   * null for every failure mode (unknown id, secret mismatch, expired,
   * revoked) — callers map all of them to one uniform 401 with no oracle.
   * Touches `last_used_at` on success only.
   */
  authenticateToken(token: string): Extract<ClientPrincipal, { kind: 'grant' }> | null {
    const parsed = parseGrantToken(token);
    if (!parsed) {
      // Same-cost dummy comparison so malformed input is not measurably
      // cheaper than a secret mismatch.
      dummyCompare();
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT id, label, verifier_version, secret_hash, default_deck, allowed_decks,
                installation_id, created_at, expires_at, revoked_at, last_used_at
         FROM agent_grants WHERE id = ?`,
      )
      .get(parsed.grantId) as GrantRow | undefined;
    if (!row) {
      dummyCompare();
      return null;
    }
    if (!verifierMatches(parsed.secret, row.secret_hash)) {
      return null;
    }
    if (row.revoked_at) {
      return null;
    }
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      return null;
    }
    this.db
      .prepare(`UPDATE agent_grants SET last_used_at = ? WHERE id = ?`)
      .run(nowIso(), row.id);
    return {
      kind: 'grant',
      grantId: row.id,
      label: row.label,
      defaultDeck: row.default_deck,
      allowedDecks: parseAllowedDecks(row.allowed_decks),
    };
  }

  /**
   * Revoke a grant. There is no un-revoke: a re-issued grant for the same
   * agent is a new id with a new secret. Returns false when unknown.
   */
  revokeGrant(id: string): boolean {
    const result = this.db
      .prepare(`UPDATE agent_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(nowIso(), id);
    return result.changes > 0;
  }
}

function toPublicGrant(row: GrantRow): ClientGrantPublic {
  return {
    id: row.id,
    label: row.label,
    defaultDeck: row.default_deck,
    allowedDecks: parseAllowedDecks(row.allowed_decks),
    installationId: row.installation_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

function parseAllowedDecks(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

/** Constant-time comparison of the presented secret against the stored verifier. */
function verifierMatches(secret: string, storedHex: string): boolean {
  let presented: Buffer;
  let stored: Buffer;
  try {
    presented = Buffer.from(hashSecret(secret), 'hex');
    stored = Buffer.from(storedHex, 'hex');
  } catch {
    return false;
  }
  if (presented.length !== stored.length) {
    return false;
  }
  return timingSafeEqual(presented, stored);
}

/** Burn comparable time when there is nothing to compare against (unknown id / malformed). */
function dummyCompare(): void {
  const a = Buffer.from(hashSecret('agent-deck-grant-dummy'), 'hex');
  const b = Buffer.from(hashSecret('agent-deck-grant-dummy-other'), 'hex');
  timingSafeEqual(a, b);
}
