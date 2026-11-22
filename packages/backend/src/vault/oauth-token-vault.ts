import { DatabaseManager } from '../models/database';

import type { SecretStore } from './secret-store';

export type OAuthTokenBundle = {
  accessToken: string;
  refreshToken?: string;
  /**
   * NOT-639: access-token expiry, kept with the tokens so it survives a store
   * reindex/rebuild of the `services` table (which only mirrors it in SQLite).
   */
  expiresAt?: string;
};

export function oauthTokenAccount(serviceId: string): string {
  return `oauth-tokens:${serviceId}`;
}

function parseBundle(raw: string): OAuthTokenBundle | null {
  try {
    const parsed = JSON.parse(raw) as OAuthTokenBundle;
    if (typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0) {
      return {
        accessToken: parsed.accessToken,
        refreshToken:
          typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0
            ? parsed.refreshToken
            : undefined,
        expiresAt:
          typeof parsed.expiresAt === 'string' && !Number.isNaN(Date.parse(parsed.expiresAt))
            ? parsed.expiresAt
            : undefined,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

function stripAuthorizationHeader(headers: Record<string, string> | null | undefined): Record<string, string> | null {
  if (!headers) {
    return null;
  }
  const next = { ...headers };
  delete next.Authorization;
  return Object.keys(next).length > 0 ? next : null;
}

/** OAuth access/refresh tokens — Keychain/file store; SQLite holds expiry + has-token flag only. */
export class OAuthTokenVault {
  constructor(
    private secretStore: SecretStore,
    private db: DatabaseManager,
  ) {}

  async get(
    serviceId: string,
    legacyAccess?: string | null,
    legacyRefresh?: string | null,
  ): Promise<OAuthTokenBundle | null> {
    const account = oauthTokenAccount(serviceId);
    const stored = await this.secretStore.get(account);
    if (stored) {
      return parseBundle(stored);
    }

    const legacyAccessToken = legacyAccess?.trim();
    if (!legacyAccessToken) {
      return null;
    }

    const bundle: OAuthTokenBundle = {
      accessToken: legacyAccessToken,
      refreshToken: legacyRefresh?.trim() || undefined,
    };
    await this.secretStore.set(account, JSON.stringify(bundle));
    await this.db.clearOAuthTokensFromDb(serviceId, { hasToken: true });
    return bundle;
  }

  async set(
    serviceId: string,
    accessToken: string,
    refreshToken?: string,
    expiresAt?: string,
    opts: { clearRefreshRejected?: boolean } = {},
  ): Promise<void> {
    const bundle: OAuthTokenBundle = {
      accessToken: accessToken.trim(),
      refreshToken: refreshToken?.trim() || undefined,
      expiresAt: expiresAt || undefined,
    };
    await this.secretStore.set(oauthTokenAccount(serviceId), JSON.stringify(bundle));
    // `null` (not `undefined`) so a token without an expiry clears a stale one.
    // NOT-654: when a new token lands after a successful refresh/reconnect,
    // the rejected-grant flag clears in the same UPDATE — never before the
    // token is durably stored, and never left behind after it.
    await this.db.clearOAuthTokensFromDb(serviceId, {
      expiresAt: expiresAt ?? null,
      hasToken: true,
      ...(opts.clearRefreshRejected ? { refreshRejected: false } : {}),
    });
  }

  /**
   * NOT-639: re-mirror the vault's token state into SQLite when a rebuilt
   * `services` row (reindex, fresh DB) lost the has-token flag or the expiry.
   */
  async restoreDbState(
    serviceId: string,
    bundle: OAuthTokenBundle,
    current: { oauthHasToken?: boolean; oauthTokenExpiresAt?: string | null },
  ): Promise<void> {
    const missingFlag = !current.oauthHasToken;
    const missingExpiry = !current.oauthTokenExpiresAt && Boolean(bundle.expiresAt);
    if (!missingFlag && !missingExpiry) {
      return;
    }
    await this.db.clearOAuthTokensFromDb(serviceId, {
      hasToken: true,
      ...(missingExpiry ? { expiresAt: bundle.expiresAt } : {}),
    });
  }

  async has(
    serviceId: string,
    legacyAccess?: string | null,
    legacyRefresh?: string | null,
  ): Promise<boolean> {
    if (legacyAccess?.trim()) {
      return true;
    }
    if (await this.secretStore.has(oauthTokenAccount(serviceId))) {
      return true;
    }
    const service = await this.db.getService(serviceId);
    return Boolean(service?.oauthHasToken);
  }

  async delete(serviceId: string): Promise<void> {
    await this.secretStore.delete(oauthTokenAccount(serviceId));
    await this.db.clearOAuthTokensFromDb(serviceId, { hasToken: false, expiresAt: null });
  }

  /** Remove legacy Authorization header duplicated in services.headers. */
  async scrubLegacyAuthHeader(serviceId: string): Promise<void> {
    const service = await this.db.getService(serviceId);
    if (!service?.headers?.Authorization) {
      return;
    }
    await this.db.updateService(serviceId, {
      headers: stripAuthorizationHeader(service.headers) ?? undefined,
    });
  }
}
