import type { SecretStore } from './secret-store';

export function serviceHeaderAccount(serviceId: string): string {
  return `custom-headers:${serviceId}`;
}

function parseHeaders(raw: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        next[key] = value;
      }
    }
    return Object.keys(next).length > 0 ? next : null;
  } catch {
    return null;
  }
}

/**
 * Secret custom headers (Authorization / API keys) for MCP service cards.
 * Kept in the local SecretStore (Keychain), never in SQLite or the git-synced
 * file store — mirrors {@link OAuthTokenVault}. This is what lets a user's Bearer
 * token survive a store reindex/restart without ever being committed to git.
 */
export class ServiceHeaderVault {
  constructor(private secretStore: SecretStore) {}

  async get(serviceId: string): Promise<Record<string, string> | null> {
    const stored = await this.secretStore.get(serviceHeaderAccount(serviceId));
    return stored ? parseHeaders(stored) : null;
  }

  async set(serviceId: string, headers: Record<string, string>): Promise<void> {
    const entries = Object.entries(headers).filter(
      ([, value]) => typeof value === 'string' && value.length > 0,
    );
    if (entries.length === 0) {
      await this.delete(serviceId);
      return;
    }
    await this.secretStore.set(
      serviceHeaderAccount(serviceId),
      JSON.stringify(Object.fromEntries(entries)),
    );
  }

  async delete(serviceId: string): Promise<void> {
    await this.secretStore.delete(serviceHeaderAccount(serviceId));
  }
}
