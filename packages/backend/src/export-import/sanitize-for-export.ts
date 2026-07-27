import type { BundleService } from '@agent-deck/shared';
import type { Service } from '@agent-deck/shared';

export function stripAuthorizationHeader(
  headers?: Record<string, string> | null,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization') {
      continue;
    }
    next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function presentString(value: string | null | undefined): string | undefined {
  return value == null || value === '' ? undefined : value;
}

/** Create-safe service snapshot for export bundles (no secrets, no runtime state). */
export function sanitizeServiceForExport(service: Service): BundleService {
  const headers = stripAuthorizationHeader(service.headers);
  const description = presentString(service.description);
  const iconUrl = presentString(service.iconUrl);
  const oauthClientId = presentString(service.oauthClientId);
  const oauthAuthorizationUrl = presentString(service.oauthAuthorizationUrl);
  const oauthTokenUrl = presentString(service.oauthTokenUrl);
  const oauthRedirectUri = presentString(service.oauthRedirectUri);
  const oauthScope = presentString(service.oauthScope);
  const localCommand = presentString(service.localCommand);
  const localWorkingDir = presentString(service.localWorkingDir);

  return {
    id: service.id,
    name: service.name,
    type: service.type,
    url: service.url,
    ...(description ? { description } : {}),
    ...(service.cardColor ? { cardColor: service.cardColor } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    disabledToolNames: service.disabledToolNames ?? [],
    ...(headers ? { headers } : {}),
    ...(oauthClientId ? { oauthClientId } : {}),
    ...(oauthAuthorizationUrl ? { oauthAuthorizationUrl } : {}),
    ...(oauthTokenUrl ? { oauthTokenUrl } : {}),
    ...(oauthRedirectUri ? { oauthRedirectUri } : {}),
    ...(oauthScope ? { oauthScope } : {}),
    ...(localCommand ? { localCommand } : {}),
    ...(service.localArgs?.length ? { localArgs: service.localArgs } : {}),
    ...(localWorkingDir ? { localWorkingDir } : {}),
  };
}

export function serviceNeedsOauthReconnect(service: BundleService): boolean {
  return Boolean(
    service.oauthClientId ||
      service.oauthAuthorizationUrl ||
      service.oauthTokenUrl,
  );
}

/** Keys that must never appear on an exported service object. */
export const FORBIDDEN_EXPORT_SERVICE_KEYS = [
  'oauthClientSecret',
  'oauthAccessToken',
  'oauthRefreshToken',
  'oauthTokenExpiresAt',
  'oauthState',
  'oauthHasToken',
  'localEnv',
  'credentialId',
  'health',
  'isConnected',
  'lastPing',
  'registeredAt',
  'updatedAt',
] as const;
