import {
  inferOAuthProvider,
  resolveOAuthSetupMode,
  type OAuthSetupMode,
} from '../data/oauth-provider-guides';
import { DestinationGuardError, guardedFetch } from './destination-guard';

interface ProtectedResourceMetadata {
  resource?: string;
  resource_name?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes_supported?: string[];
  registration_endpoint?: string;
}

export type McpOAuthDiscovery = {
  required: boolean;
  resourceName?: string;
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopesSupported?: string[];
  bearerMethodsSupported?: string[];
  provider?: string;
  setupMode?: OAuthSetupMode;
  supportsDynamicRegistration?: boolean;
  error?: string;
};

function finalizeOAuthDiscovery(
  serviceUrl: string,
  oauth: McpOAuthDiscovery,
  authServers: string[] = [],
): McpOAuthDiscovery {
  const provider = oauth.provider ?? inferOAuthProvider(serviceUrl, authServers);
  const setupMode = resolveOAuthSetupMode(provider, oauth.supportsDynamicRegistration);
  return {
    ...oauth,
    provider,
    setupMode,
    supportsDynamicRegistration:
      setupMode === 'dynamic' ? true : oauth.supportsDynamicRegistration ?? false,
  };
}

function protectedResourceCandidates(serviceUrl: string): string[] {
  const parsed = new URL(serviceUrl);
  const path = parsed.pathname.replace(/\/$/, '');
  const candidates = new Set<string>([
    `${parsed.origin}/.well-known/oauth-protected-resource`,
  ]);

  if (path && path !== '/') {
    candidates.add(`${parsed.origin}/.well-known/oauth-protected-resource${path}`);
    candidates.add(`${parsed.origin}/.well-known/oauth-protected-resource${path}/`);
  }

  return [...candidates];
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await guardedFetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch (error) {
    if (error instanceof DestinationGuardError) throw error;
    return null;
  }
}

async function fetchAuthorizationServerMetadata(
  issuerOrAsUrl: string,
): Promise<AuthorizationServerMetadata | null> {
  const trimmed = issuerOrAsUrl.replace(/\/$/, '');
  const candidates = trimmed.includes('/.well-known/')
    ? [trimmed]
    : [
        `${trimmed}/.well-known/oauth-authorization-server`,
        `${trimmed}/.well-known/openid-configuration`,
      ];

  for (const candidate of candidates) {
    const data = await fetchJson(candidate);
    if (data && typeof data === 'object') {
      return data as AuthorizationServerMetadata;
    }
  }

  return null;
}

function applyKnownProviderFallbacks(
  serviceUrl: string,
  authServers: string[],
  oauth: McpOAuthDiscovery,
): McpOAuthDiscovery {
  if (authServers.some((server) => server.includes('github.com/login/oauth'))) {
    return finalizeOAuthDiscovery(serviceUrl, {
      ...oauth,
      required: true,
      provider: 'github',
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      supportsDynamicRegistration: false,
    }, authServers);
  }

  return finalizeOAuthDiscovery(serviceUrl, oauth, authServers);
}

async function resolveFromProtectedResource(
  serviceUrl: string,
  metadata: ProtectedResourceMetadata,
): Promise<McpOAuthDiscovery> {
  const oauth: McpOAuthDiscovery = {
    required: true,
    resourceName: metadata.resource_name ?? metadata.resource,
    scopesSupported: metadata.scopes_supported ?? [],
    bearerMethodsSupported: metadata.bearer_methods_supported ?? [],
  };

  const authServers = metadata.authorization_servers ?? [];
  if (authServers.length === 0) {
    return finalizeOAuthDiscovery(serviceUrl, oauth, authServers);
  }

  const asMeta = await fetchAuthorizationServerMetadata(authServers[0]!);
  if (asMeta) {
    oauth.issuer = asMeta.issuer;
    oauth.authorizationUrl = asMeta.authorization_endpoint;
    oauth.tokenUrl = asMeta.token_endpoint;
    oauth.scopesSupported = asMeta.scopes_supported ?? oauth.scopesSupported;
    oauth.supportsDynamicRegistration = Boolean(asMeta.registration_endpoint);
  }

  return applyKnownProviderFallbacks(serviceUrl, authServers, oauth);
}

async function probeWwwAuthenticate(serviceUrl: string): Promise<string | null> {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };

  for (const method of ['GET', 'POST'] as const) {
    try {
      const init: RequestInit =
        method === 'GET'
          ? { method, headers: { Accept: headers.Accept } }
          : {
              method,
              headers,
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
            };
      const response = await guardedFetch(serviceUrl, init);
      const wwwAuth = response.headers.get('www-authenticate');
      if (wwwAuth) {
        return wwwAuth;
      }
    } catch (error) {
      if (error instanceof DestinationGuardError) throw error;
      // try next method
    }
  }

  return null;
}

function parseResourceMetadataUrl(wwwAuthenticate: string): string | null {
  const match = wwwAuthenticate.match(/resource_metadata="([^"]+)"/i);
  return match?.[1] ?? null;
}

export async function discoverMcpOAuthRequirements(serviceUrl: string): Promise<McpOAuthDiscovery> {
  const oauth: McpOAuthDiscovery = { required: false };

  try {
    for (const candidate of protectedResourceCandidates(serviceUrl)) {
      const data = await fetchJson(candidate);
      if (data && typeof data === 'object') {
        return resolveFromProtectedResource(serviceUrl, data as ProtectedResourceMetadata);
      }
    }

    const parsed = new URL(serviceUrl);
    const asData = await fetchAuthorizationServerMetadata(parsed.origin);
    if (asData?.authorization_endpoint) {
      return finalizeOAuthDiscovery(serviceUrl, {
        required: true,
        issuer: asData.issuer,
        authorizationUrl: asData.authorization_endpoint,
        tokenUrl: asData.token_endpoint,
        scopesSupported: asData.scopes_supported ?? [],
        supportsDynamicRegistration: Boolean(asData.registration_endpoint),
      });
    }

    const wwwAuth = await probeWwwAuthenticate(serviceUrl);
    if (wwwAuth) {
      const resourceMetadataUrl = parseResourceMetadataUrl(wwwAuth);
      if (resourceMetadataUrl) {
        const data = await fetchJson(resourceMetadataUrl);
        if (data && typeof data === 'object') {
          return resolveFromProtectedResource(serviceUrl, data as ProtectedResourceMetadata);
        }
      }

      if (wwwAuth.toLowerCase().includes('oauth') || wwwAuth.toLowerCase().includes('bearer')) {
        return finalizeOAuthDiscovery(serviceUrl, { required: true });
      }
    }
  } catch (error) {
    oauth.error = error instanceof Error ? error.message : 'OAuth detection failed';
  }

  return oauth;
}
