import { MCPDiscoveryService } from './mcp-discovery-service';
import { OAuthManager } from './oauth-manager';
import { DatabaseManager } from '../models/database';
import {
  getOAuthProviderGuide,
  getOAuthRedirectUri,
  inferOAuthProvider,
  resolveOAuthSetupMode,
  type OAuthProviderGuide,
} from '../data/oauth-provider-guides';
import { getSharedOAuthCredentials } from '../config/shared-oauth-apps';
import { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';

export type OAuthConnectInput = {
  clientId?: string;
  clientSecret?: string;
};

export type StoredOAuthCredentials = {
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
};

export function resolveOAuthClientCredentials(
  input: OAuthConnectInput,
  stored: StoredOAuthCredentials,
): { clientId?: string; clientSecret?: string; missingRequiredSecret: boolean } {
  const clientId = input.clientId?.trim() || stored.oauthClientId?.trim() || undefined;
  const clientSecret =
    input.clientSecret?.trim() || stored.oauthClientSecret?.trim() || undefined;

  return {
    clientId,
    clientSecret,
    missingRequiredSecret: Boolean(clientId && !clientSecret),
  };
}

/**
 * A dynamically registered client is bound to the redirect URI it was registered with. When the
 * card was registered on another host (the store is shared via git) and this host's redirect URI
 * differs, reusing that client makes the provider reject the authorization request. In that case
 * the caller re-registers for the current redirect URI. Manually entered or non-DCR clients are
 * always reused, as before.
 */
export function shouldReuseStoredOAuthClient(input: {
  enteredClientId?: string | null;
  storedClientId?: string | null;
  storedRedirectUri?: string | null;
  currentRedirectUri: string;
  supportsDynamicRegistration?: boolean | null;
}): boolean {
  const storedRedirectUri = input.storedRedirectUri?.trim();
  const redirectChanged = Boolean(storedRedirectUri) && storedRedirectUri !== input.currentRedirectUri;
  const reRegister =
    !input.enteredClientId?.trim() &&
    Boolean(input.storedClientId?.trim()) &&
    Boolean(input.supportsDynamicRegistration) &&
    redirectChanged;
  return !reRegister;
}

export function hasSavedOAuthCredentials(stored: StoredOAuthCredentials): boolean {
  return Boolean(stored.oauthClientId?.trim() && stored.oauthClientSecret?.trim());
}

export type OAuthConnectResult =
  | {
      success: true;
      authorizationUrl: string;
      state: string;
      mode: 'dynamic' | 'manual' | 'managed';
    }
  | {
      success: false;
      needsCredentials: boolean;
      setupMode: OAuthProviderGuide['setupMode'];
      guide: OAuthProviderGuide;
      error: string;
    };

export async function getOAuthSetupInfo(
  db: DatabaseManager,
  serviceId: string,
  clientSecrets: OAuthClientSecretVault,
): Promise<{
  guide: OAuthProviderGuide;
  discovery: Awaited<ReturnType<MCPDiscoveryService['discoverService']>>;
  savedOAuthClientId?: string;
  hasStoredClientSecret: boolean;
  hasSavedCredentials: boolean;
}> {
  const service = await db.getService(serviceId);
  if (!service) {
    throw new Error('Service not found');
  }

  const discoveryService = new MCPDiscoveryService();
  const discovery = await discoveryService.discoverService(service.url);
  const provider = discovery.oauth.provider
    ?? inferOAuthProvider(service.url, []);
  const setupMode = resolveOAuthSetupMode(provider, discovery.oauth.supportsDynamicRegistration);
  const guide = {
    ...getOAuthProviderGuide(provider, {
      serviceName: service.name,
      serviceUrl: service.url,
    }),
    setupMode,
  };

  const storedSecret = await clientSecrets.get(serviceId, service.oauthClientSecret);
  const hasStoredClientSecret = Boolean(storedSecret);
  const hasSavedCredentials = Boolean(service.oauthClientId?.trim() && storedSecret);

  return {
    guide,
    discovery,
    savedOAuthClientId: service.oauthClientId ?? undefined,
    hasStoredClientSecret,
    hasSavedCredentials,
  };
}

export async function startOAuthConnect(
  db: DatabaseManager,
  oauthManager: OAuthManager,
  clientSecrets: OAuthClientSecretVault,
  serviceId: string,
  input: OAuthConnectInput = {},
): Promise<OAuthConnectResult> {
  const service = await db.getService(serviceId);
  if (!service) {
    throw new Error('Service not found');
  }

  const discoveryService = new MCPDiscoveryService();
  const mcpDiscovery = await discoveryService.discoverService(service.url);

  if (!mcpDiscovery.oauth.required) {
    throw new Error('Service does not require OAuth authentication');
  }

  const provider =
    mcpDiscovery.oauth.provider ?? inferOAuthProvider(service.url, []);
  const setupMode = resolveOAuthSetupMode(provider, mcpDiscovery.oauth.supportsDynamicRegistration);
  const guide = {
    ...getOAuthProviderGuide(provider, {
      serviceName: service.name,
      serviceUrl: service.url,
    }),
    setupMode,
  };

  if (guide.setupMode === 'unavailable') {
    return {
      success: false,
      needsCredentials: false,
      setupMode: guide.setupMode,
      guide,
      error: guide.unavailableReason ?? 'OAuth is not available for this provider in Agent Deck.',
    };
  }

  const redirectUri = getOAuthRedirectUri();
  const scope = mcpDiscovery.oauth.scopesSupported?.length
    ? mcpDiscovery.oauth.scopesSupported.join(' ')
    : 'read write';

  const oauthConfig = {
    clientId: '',
    clientSecret: '',
    authorizationUrl: mcpDiscovery.oauth.authorizationUrl || '',
    tokenUrl: mcpDiscovery.oauth.tokenUrl || '',
    redirectUri,
    scope,
  };

  if (!oauthConfig.authorizationUrl || !oauthConfig.tokenUrl) {
    return {
      success: false,
      needsCredentials: false,
      setupMode: guide.setupMode,
      guide,
      error: 'Could not discover OAuth authorization and token URLs for this service.',
    };
  }

  const reuseStoredClient = shouldReuseStoredOAuthClient({
    enteredClientId: input.clientId,
    storedClientId: service.oauthClientId,
    storedRedirectUri: service.oauthRedirectUri,
    currentRedirectUri: redirectUri,
    supportsDynamicRegistration: mcpDiscovery.oauth.supportsDynamicRegistration,
  });
  const storedSecret = reuseStoredClient
    ? await clientSecrets.get(serviceId, service.oauthClientSecret)
    : undefined;
  const resolved = resolveOAuthClientCredentials(input, {
    oauthClientId: reuseStoredClient ? service.oauthClientId : null,
    oauthClientSecret: storedSecret,
  });
  let clientId = resolved.clientId;
  let clientSecret = resolved.clientSecret;
  let mode: 'dynamic' | 'manual' | 'managed' = clientId ? 'manual' : 'dynamic';

  const shared = !input.clientId?.trim() ? getSharedOAuthCredentials(provider) : null;
  if (shared) {
    clientId = shared.clientId;
    clientSecret = shared.clientSecret;
    mode = 'managed';
  } else if (!clientId) {
    const registration = await oauthManager.autoRegisterOAuthApp(service.url, oauthConfig);
    if (!registration.success || !registration.clientId) {
      return {
        success: false,
        needsCredentials: true,
        setupMode: 'manual',
        guide: {
          ...getOAuthProviderGuide(provider, {
            serviceName: service.name,
            serviceUrl: service.url,
          }),
          setupMode: 'manual',
        },
        error:
          guide.setupMode === 'manual'
            ? 'Add your OAuth Client ID and Client Secret below, then click Connect.'
            : registration.error ?? 'Failed to register OAuth application automatically.',
      };
    }
    clientId = registration.clientId;
    clientSecret = registration.clientSecret;
    mode = 'dynamic';
  } else if (guide.setupMode === 'manual' && resolved.missingRequiredSecret) {
    return {
      success: false,
      needsCredentials: true,
      setupMode: 'manual',
      guide: { ...guide, setupMode: 'manual' },
      error:
        'Client secret is missing. Paste it below, or leave the field blank if one is already saved for this service.',
    };
  }

  if (clientSecret) {
    await clientSecrets.set(serviceId, clientSecret);
  }

  await db.updateService(serviceId, {
    oauthClientId: clientId,
    oauthClientSecret: '',
    oauthAuthorizationUrl: oauthConfig.authorizationUrl,
    oauthTokenUrl: oauthConfig.tokenUrl,
    oauthRedirectUri: redirectUri,
    oauthScope: scope,
  });

  const { authorizationUrl, state } = await oauthManager.initiateOAuthFlow({
    serviceId,
    redirectUri,
  });

  return {
    success: true,
    authorizationUrl,
    state,
    mode,
  };
}
