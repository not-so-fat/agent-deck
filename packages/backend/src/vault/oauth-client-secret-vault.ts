import { DatabaseManager } from '../models/database';
import type { SecretStore } from './secret-store';

export function oauthClientSecretAccount(serviceId: string): string {
  return `oauth-client-secret:${serviceId}`;
}

export function oauthHostClientAccount(serviceId: string): string {
  return `oauth-host-client:${serviceId}`;
}

/**
 * The OAuth client this host registered for itself (dynamic registration). It lives next to this
 * host's tokens and client secret, never on the service card: the card is shared across hosts
 * (git-synced store) and is rebuilt into SQLite on every reindex, so a host-specific client kept
 * only in SQLite is lost on restart while its tokens survive (refresh then fails with a client
 * mismatch).
 */
export type OAuthHostClient = { clientId: string; redirectUri: string };

/** Card fields the effective client is resolved from. */
export type OAuthCardClient = {
  id: string;
  oauthClientId?: string | null;
  oauthRedirectUri?: string | null;
};

/** OAuth app client secrets — Keychain/file store; SQLite holds Client ID only. */
export class OAuthClientSecretVault {
  constructor(
    private secretStore: SecretStore,
    private db: DatabaseManager,
  ) {}

  async get(serviceId: string, legacyPlaintext?: string | null): Promise<string | null> {
    const account = oauthClientSecretAccount(serviceId);
    const stored = await this.secretStore.get(account);
    if (stored) {
      return stored;
    }

    const legacy = legacyPlaintext?.trim();
    if (!legacy) {
      return null;
    }

    await this.secretStore.set(account, legacy);
    await this.db.updateService(serviceId, { oauthClientSecret: '' });
    return legacy;
  }

  async set(serviceId: string, secret: string): Promise<void> {
    await this.secretStore.set(oauthClientSecretAccount(serviceId), secret.trim());
    await this.db.updateService(serviceId, { oauthClientSecret: '' });
  }

  async has(serviceId: string, legacyPlaintext?: string | null): Promise<boolean> {
    if (legacyPlaintext?.trim()) {
      return true;
    }
    return this.secretStore.has(oauthClientSecretAccount(serviceId));
  }

  async getHostClient(serviceId: string): Promise<OAuthHostClient | null> {
    const raw = await this.secretStore.get(oauthHostClientAccount(serviceId));
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<OAuthHostClient>;
      if (typeof parsed.clientId === 'string' && parsed.clientId && typeof parsed.redirectUri === 'string' && parsed.redirectUri) {
        return { clientId: parsed.clientId, redirectUri: parsed.redirectUri };
      }
    } catch {
      // unreadable record: fall back to the card
    }
    return null;
  }

  async setHostClient(serviceId: string, client: OAuthHostClient): Promise<void> {
    await this.secretStore.set(oauthHostClientAccount(serviceId), JSON.stringify(client));
  }

  async deleteHostClient(serviceId: string): Promise<void> {
    await this.secretStore.delete(oauthHostClientAccount(serviceId));
  }

  /**
   * The client this host uses for a service: its own registered client when that was registered
   * for the current redirect URI, else the card's client.
   */
  async resolveClient(
    service: OAuthCardClient,
    currentRedirectUri: string,
  ): Promise<{ clientId: string; redirectUri: string | null; hostRegistered: boolean }> {
    const host = await this.getHostClient(service.id);
    if (host && host.redirectUri === currentRedirectUri) {
      return { clientId: host.clientId, redirectUri: host.redirectUri, hostRegistered: true };
    }
    return {
      clientId: service.oauthClientId || '',
      redirectUri: service.oauthRedirectUri || null,
      hostRegistered: false,
    };
  }

  async delete(serviceId: string): Promise<void> {
    await this.secretStore.delete(oauthClientSecretAccount(serviceId));
    await this.db.updateService(serviceId, { oauthClientSecret: '' });
  }
}
