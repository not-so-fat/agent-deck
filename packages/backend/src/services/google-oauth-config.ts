import type { Service } from '@agent-deck/shared';
import type { StoreService } from '@agent-deck/shared';
import { getOAuthRedirectUri } from '../config/oauth-redirect';
import type { DatabaseManager } from '../models/database';
import { storeServiceFromDb } from '../store/service-codec';
import type { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';

/** Minimal store writer surface the heal path needs (FileStoreWriter in prod). */
export type GoogleOAuthStoreWriter = {
  writeService(service: StoreService): Promise<void>;
};

export const GOOGLE_OAUTH_AUTHORIZATION_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** A Google OAuth card: its MCP URL host ends in `.googleapis.com`. */
export function isGoogleMcpServiceUrl(
  url: string | null | undefined,
): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).hostname.toLowerCase().endsWith('.googleapis.com');
  } catch {
    return false;
  }
}

export function googleOAuthUrlsMissing(service: {
  url: string;
  oauthAuthorizationUrl?: string | null;
  oauthTokenUrl?: string | null;
}): boolean {
  return (
    isGoogleMcpServiceUrl(service.url) &&
    (!service.oauthAuthorizationUrl?.trim() ||
      !service.oauthTokenUrl?.trim())
  );
}

export function googleOAuthClientIdMissing(service: {
  url: string;
  oauthClientId?: string | null;
}): boolean {
  return (
    isGoogleMcpServiceUrl(service.url) && !service.oauthClientId?.trim()
  );
}

type GoogleDonor = { clientId: string; donorId: string; secret: string };

/**
 * Another Google card on this host that can lend its client ID: it names a
 * client and that client's secret is in this host's vault. When the target
 * already holds a secret, prefer a donor whose secret matches it, so the
 * borrowed client ID pairs with the secret the target already has.
 */
async function findGoogleDonor(
  db: DatabaseManager,
  clientSecrets: OAuthClientSecretVault,
  targetId: string,
  targetSecret: string | null,
): Promise<GoogleDonor | null> {
  const services = await db.getAllServices();
  const candidates: GoogleDonor[] = [];
  for (const candidate of services) {
    if (candidate.id === targetId) {
      continue;
    }
    if (!isGoogleMcpServiceUrl(candidate.url)) {
      continue;
    }
    const clientId = candidate.oauthClientId?.trim();
    if (!clientId) {
      continue;
    }
    let secret: string | null = null;
    try {
      secret = await clientSecrets.get(candidate.id, candidate.oauthClientSecret);
    } catch {
      continue;
    }
    if (!secret) {
      continue;
    }
    candidates.push({ clientId, donorId: candidate.id, secret });
  }
  if (candidates.length === 0) {
    return null;
  }
  if (targetSecret) {
    const exact = candidates.find((c) => c.secret === targetSecret);
    if (exact) {
      return exact;
    }
  }
  return candidates[0] ?? null;
}

/**
 * NOT-653: self-heal for Google cards that lost their OAuth client config
 * (Connect wrote it to SQLite only, so a restart/reindex wiped it). Fills the
 * Google authorization/token URLs and, when the client ID is missing, borrows
 * one from a sibling Google card whose secret is in this host's vault.
 *
 * Persists to SQLite and the store file. Never logs secret values; secrets
 * stay per-service in the vault (a donor secret is copied vault-to-vault only
 * when the target has none of its own).
 */
export async function healGoogleOAuthConfigForService(
  db: DatabaseManager,
  clientSecrets: OAuthClientSecretVault,
  serviceId: string,
  opts: { storeWriter?: GoogleOAuthStoreWriter } = {},
): Promise<{ healed: boolean; service: Service | null }> {
  const service = await db.getService(serviceId);
  if (!service || !isGoogleMcpServiceUrl(service.url)) {
    return { healed: false, service };
  }

  const needsUrls = googleOAuthUrlsMissing(service);
  let needsClientId = googleOAuthClientIdMissing(service);
  if (needsClientId) {
    // A host-registered client already covers this host: leave the card alone.
    try {
      const host = await clientSecrets.getHostClient(serviceId);
      if (
        host?.clientId?.trim() &&
        host.redirectUri === getOAuthRedirectUri()
      ) {
        needsClientId = false;
      }
    } catch {
      // Unreadable host record: fall through to borrowing.
    }
  }
  if (!needsUrls && !needsClientId) {
    return { healed: false, service };
  }

  const patch: {
    oauthAuthorizationUrl?: string;
    oauthTokenUrl?: string;
    oauthClientId?: string;
  } = {};
  if (needsUrls) {
    patch.oauthAuthorizationUrl = GOOGLE_OAUTH_AUTHORIZATION_URL;
    patch.oauthTokenUrl = GOOGLE_OAUTH_TOKEN_URL;
  }

  if (needsClientId) {
    let targetSecret: string | null = null;
    try {
      targetSecret = await clientSecrets.get(
        serviceId,
        service.oauthClientSecret,
      );
    } catch {
      targetSecret = null;
    }
    const donor = await findGoogleDonor(
      db,
      clientSecrets,
      serviceId,
      targetSecret,
    );
    if (!donor) {
      // No donor: still heal the URLs so a later Connect/secret can finish.
      if (!needsUrls) {
        return { healed: false, service };
      }
    } else {
      patch.oauthClientId = donor.clientId;
      if (!targetSecret) {
        // Pair the borrowed client ID with the donor's secret, vault-to-vault.
        await clientSecrets.set(serviceId, donor.secret);
      }
    }
  }

  if (Object.keys(patch).length === 0) {
    return { healed: false, service };
  }
  const updated = await db.updateService(serviceId, patch);
  if (updated && opts.storeWriter) {
    try {
      await opts.storeWriter.writeService(storeServiceFromDb(updated));
    } catch (error) {
      console.error(
        `Failed to write healed Google OAuth config for service ${serviceId} to file store:`,
        error,
      );
    }
  }
  return { healed: true, service: updated };
}

/** Startup pass: heal every Google card missing URLs or a client ID. */
export async function healMissingGoogleOAuthConfigs(
  db: DatabaseManager,
  clientSecrets: OAuthClientSecretVault,
  opts: { storeWriter?: GoogleOAuthStoreWriter } = {},
): Promise<{ healed: number; ids: string[] }> {
  const ids: string[] = [];
  let services: Service[];
  try {
    services = await db.getAllServices();
  } catch {
    return { healed: 0, ids };
  }
  for (const service of services) {
    if (
      !googleOAuthUrlsMissing(service) &&
      !googleOAuthClientIdMissing(service)
    ) {
      continue;
    }
    try {
      const result = await healGoogleOAuthConfigForService(
        db,
        clientSecrets,
        service.id,
        opts,
      );
      if (result.healed) {
        ids.push(service.id);
      }
    } catch (error) {
      console.error(
        `Failed to heal Google OAuth config for service ${service.id}:`,
        error,
      );
    }
  }
  return { healed: ids.length, ids };
}
