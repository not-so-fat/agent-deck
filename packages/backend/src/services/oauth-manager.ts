import { 
  OAuthDiscoveryResult, 
  OAuthConfig, 
  OAuthToken,
  OAuthFlowInput,
  OAuthCallbackInput,
  OAuthRefreshInput,
  isOAuthAccessTokenExpired,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { OAuthTokenVault } from '../vault/oauth-token-vault';
import { randomBytes } from 'crypto';
import { generatePkcePair } from '../lib/pkce';
import { getOAuthRedirectUri } from '../config/oauth-redirect';
import {
  oauthTokenRequestHeaders,
  parseOAuthTokenResponse,
} from '../lib/oauth-token-response';





interface OAuthMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes_supported?: string[];
  authorizationUrl?: string;
  tokenUrl?: string;
  scope?: string;
}

interface OAuthStateEntry {
  serviceId: string;
  codeVerifier: string;
}

export class OAuthManager {
  private oauthStates = new Map<string, OAuthStateEntry>();
  private refreshInFlight = new Map<string, Promise<OAuthToken>>();

  getOAuthState(state: string): string | undefined {
    return this.oauthStates.get(state)?.serviceId;
  }

  constructor(
    private db: DatabaseManager,
    private clientSecrets: OAuthClientSecretVault,
    private tokens: OAuthTokenVault,
  ) {}

  async discoverOAuth(serviceUrl: string): Promise<OAuthDiscoveryResult> {
    try {
      // Try to get OAuth metadata from the service
      const response = await fetch(`${serviceUrl}/.well-known/oauth-authorization-server`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (response.ok) {
        const metadata = await response.json() as OAuthMetadata;
        
        const config: OAuthConfig = {
          clientId: '', // Will be provided by user
          clientSecret: '', // Will be provided by user
          authorizationUrl: metadata.authorization_endpoint || '',
          tokenUrl: metadata.token_endpoint || '',
          redirectUri: '', // Will be set during OAuth flow
          scope: metadata.scopes_supported?.[0] || 'read write',
        };

        return {
          hasOAuth: true,
          config,
        };
      }

      // Try alternative discovery methods
      const alternativeResponse = await fetch(`${serviceUrl}/oauth/metadata`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (alternativeResponse.ok) {
        const metadata = await alternativeResponse.json() as OAuthMetadata;
        
        const config: OAuthConfig = {
          clientId: '',
          clientSecret: '',
          authorizationUrl: metadata.authorizationUrl || metadata.authorization_endpoint || '',
          tokenUrl: metadata.tokenUrl || metadata.token_endpoint || '',
          redirectUri: '',
          scope: metadata.scope || 'read write',
        };

        return {
          hasOAuth: true,
          config,
        };
      }

      return {
        hasOAuth: false,
      };
    } catch (error) {
      console.warn('OAuth discovery failed:', error);
      return {
        hasOAuth: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async initiateOAuthFlow(input: OAuthFlowInput): Promise<{ authorizationUrl: string; state: string }> {
    const service = await this.db.getService(input.serviceId);
    if (!service) {
      throw new Error(`Service ${input.serviceId} not found`);
    }

    if (!service.oauthAuthorizationUrl) {
      throw new Error('Service does not have OAuth configuration');
    }

    const state = randomBytes(32).toString('hex');
    const { codeVerifier, codeChallenge } = generatePkcePair();

    this.oauthStates.set(state, {
      serviceId: input.serviceId,
      codeVerifier,
    });

    const url = new URL(service.oauthAuthorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', service.oauthClientId || '');
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', service.oauthScope || 'read write');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return {
      authorizationUrl: url.toString(),
      state,
    };
  }

  async handleOAuthCallback(input: OAuthCallbackInput): Promise<OAuthToken> {
    const stateEntry = this.oauthStates.get(input.state);
    if (!stateEntry) {
      throw new Error('Invalid or expired OAuth state parameter');
    }

    this.oauthStates.delete(input.state);

    const { serviceId, codeVerifier } = stateEntry;
    const service = await this.db.getService(serviceId);
    if (!service) {
      throw new Error(`Service ${serviceId} not found`);
    }

    if (!service.oauthTokenUrl) {
      throw new Error('Service does not have OAuth token URL configured');
    }

    // Use the exact same redirect URI that was used in the authorization request
    // This should match the redirect URI stored in the service configuration
    const redirectUri = service.oauthRedirectUri || 'http://localhost:3000/oauth/callback';
    
    console.log('OAuth callback debug:', {
      serviceId: input.serviceId,
      clientId: service.oauthClientId,
      redirectUri,
      tokenUrl: service.oauthTokenUrl,
    });

    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: service.oauthClientId || '',
      code: input.code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    const clientSecret = await this.clientSecrets.get(input.serviceId, service.oauthClientSecret);
    if (clientSecret) {
      tokenBody.set('client_secret', clientSecret);
    }

    const tokenResponse = await fetch(service.oauthTokenUrl, {
      method: 'POST',
      headers: oauthTokenRequestHeaders(),
      body: tokenBody,
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`OAuth token exchange failed: ${tokenResponse.status} ${errorText}`);
    }

    const tokenData = await parseOAuthTokenResponse(tokenResponse);
    
    const token: OAuthToken = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: tokenData.expires_in ? 
        new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : 
        undefined,
      tokenType: tokenData.token_type || 'Bearer',
      scope: tokenData.scope,
    };

    // Store tokens in Keychain; expiry + has-token flag in SQLite
    await this.tokens.set(
      serviceId,
      token.accessToken,
      token.refreshToken,
      token.expiresAt,
    );

    // Clear state - we'll need to implement this properly
    // await this.db.updateService(input.serviceId, {
    //   oauthState: undefined,
    // });

    return token;
  }

  async refreshOAuthToken(input: OAuthRefreshInput): Promise<OAuthToken> {
    const inFlight = this.refreshInFlight.get(input.serviceId);
    if (inFlight) {
      return inFlight;
    }

    const refreshPromise = this.performRefreshOAuthToken(input).finally(() => {
      this.refreshInFlight.delete(input.serviceId);
    });
    this.refreshInFlight.set(input.serviceId, refreshPromise);
    return refreshPromise;
  }

  private async performRefreshOAuthToken(input: OAuthRefreshInput): Promise<OAuthToken> {
    const service = await this.db.getService(input.serviceId);
    if (!service) {
      throw new Error(`Service ${input.serviceId} not found`);
    }

    if (!service.oauthTokenUrl) {
      throw new Error('Service does not have OAuth token URL configured');
    }

    const refreshBody = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: service.oauthClientId || '',
      refresh_token: input.refreshToken,
    });
    const clientSecret = await this.clientSecrets.get(input.serviceId, service.oauthClientSecret);
    if (clientSecret) {
      refreshBody.set('client_secret', clientSecret);
    }

    const tokenResponse = await fetch(service.oauthTokenUrl, {
      method: 'POST',
      headers: oauthTokenRequestHeaders(),
      body: refreshBody,
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(`OAuth token refresh failed: ${tokenResponse.status} ${errorText}`);
    }

    const tokenData = await parseOAuthTokenResponse(tokenResponse);
    
    const token: OAuthToken = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || input.refreshToken,
      expiresAt: tokenData.expires_in ? 
        new Date(Date.now() + tokenData.expires_in * 1000).toISOString() : 
        undefined,
      tokenType: tokenData.token_type || 'Bearer',
      scope: tokenData.scope,
    };

    // Store new tokens in Keychain
    await this.tokens.set(
      input.serviceId,
      token.accessToken,
      token.refreshToken,
      token.expiresAt,
    );

    return token;
  }

  async isTokenExpired(serviceId: string): Promise<boolean> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      return true;
    }
    const hasToken = await this.tokens.has(
      serviceId,
      service.oauthAccessToken,
      service.oauthRefreshToken,
    );
    if (!hasToken) {
      return true;
    }
    return isOAuthAccessTokenExpired(service);
  }

  async getValidAccessToken(serviceId: string): Promise<string | null> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      return null;
    }

    const bundle = await this.tokens.get(
      serviceId,
      service.oauthAccessToken,
      service.oauthRefreshToken,
    );
    if (!bundle?.accessToken) {
      return null;
    }

    // Check if token is expired (missing expiry means still valid)
    if (isOAuthAccessTokenExpired(service)) {
      // Try to refresh the token
      if (bundle.refreshToken) {
        try {
          const newToken = await this.refreshOAuthToken({
            serviceId,
            refreshToken: bundle.refreshToken,
          });
          return newToken.accessToken;
        } catch (error) {
          console.error(`Failed to refresh OAuth token for service ${serviceId}:`, error);
          return null;
        }
      } else {
        return null;
      }
    }

    return bundle.accessToken;
  }

  async hasOAuthTokens(serviceId: string): Promise<boolean> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      return false;
    }
    return this.tokens.has(serviceId, service.oauthAccessToken, service.oauthRefreshToken);
  }

  async hasRefreshToken(serviceId: string): Promise<boolean> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      return false;
    }
    const bundle = await this.tokens.get(
      serviceId,
      service.oauthAccessToken,
      service.oauthRefreshToken,
    );
    return Boolean(bundle?.refreshToken);
  }

  async autoRegisterOAuthApp(serviceUrl: string, config: OAuthConfig): Promise<{
    success: boolean;
    clientId?: string;
    clientSecret?: string;
    error?: string;
    registrationUrl?: string;
  }> {
    try {
      const baseUrl = new URL(serviceUrl);
      console.log('Attempting OAuth auto-registration for:', serviceUrl);
      
      // Step 1: Try to get OAuth information from the MCP service itself
      console.log('Step 1: Checking MCP service OAuth capabilities');
      
      try {
        // Try to get OAuth metadata from the MCP service
        const oauthMetadataUrl = `${baseUrl.origin}/.well-known/oauth-authorization-server`;
        console.log('Trying OAuth metadata at:', oauthMetadataUrl);
        
        const metadataResponse = await fetch(oauthMetadataUrl);
        if (metadataResponse.ok) {
          const metadata = await metadataResponse.json() as any;
          console.log('OAuth metadata found:', metadata);
          
          if (metadata.registration_endpoint) {
            console.log('Found registration endpoint:', metadata.registration_endpoint);
            
            const oauthRedirectUri = getOAuthRedirectUri();
            const registrationPayloads = [
              {
                client_name: 'AgentDeck',
                redirect_uris: [oauthRedirectUri],
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: 'none',
                scope: config.scope || 'read write',
              },
              {
                client_name: 'AgentDeck',
                redirect_uris: [oauthRedirectUri],
                grant_types: ['authorization_code', 'refresh_token'],
                response_types: ['code'],
                token_endpoint_auth_method: 'client_secret_basic',
                scope: config.scope || 'read write',
              },
            ];

            for (const payload of registrationPayloads) {
              const registrationResponse = await fetch(metadata.registration_endpoint, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                },
                body: JSON.stringify(payload),
              });

              if (!registrationResponse.ok) {
                console.log(
                  'MCP service registration failed:',
                  payload.token_endpoint_auth_method,
                  await registrationResponse.text(),
                );
                continue;
              }

              const data = await registrationResponse.json() as {
                client_id?: string;
                client_secret?: string;
              };
              console.log('Dynamic client registration successful:', data);

              if (data.client_id && typeof data.client_id === 'string' && data.client_id.length > 0) {
                return {
                  success: true,
                  clientId: data.client_id,
                  clientSecret: data.client_secret,
                };
              }

              console.log('Invalid client credentials received from MCP service');
            }
          } else {
            console.log('No registration endpoint found in MCP service OAuth metadata');
          }
        } else {
          console.log('MCP service OAuth metadata not found at:', oauthMetadataUrl);
        }
      } catch (error) {
        console.log('Failed to get OAuth metadata from MCP service:', error);
      }

      // Step 2: Try MCP service-specific OAuth registration endpoints
      console.log('Step 2: Trying MCP service-specific OAuth registration');
      
      const mcpOAuthEndpoints = [
        `${serviceUrl}/oauth/register`,
        `${serviceUrl}/oauth/credentials`,
        `${baseUrl.origin}/oauth/register`,
        `${baseUrl.origin}/oauth/credentials`,
      ];

      for (const endpoint of mcpOAuthEndpoints) {
        try {
          console.log('Trying MCP OAuth endpoint:', endpoint);
          
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              client_name: 'AgentDeck',
              redirect_uri: getOAuthRedirectUri(),
              scope: config.scope || 'read write',
            }),
          });

          if (response.ok) {
            const data = await response.json() as any;
            console.log('MCP OAuth registration successful at:', endpoint, data);
            
            if (data.client_id && typeof data.client_id === 'string' && data.client_id.length > 0) {
              return {
                success: true,
                clientId: data.client_id,
                clientSecret: data.client_secret,
              };
            } else {
              console.log('Invalid client credentials received from MCP endpoint:', endpoint);
            }
          } else {
            console.log('MCP OAuth endpoint failed:', endpoint, await response.text());
          }
        } catch (error) {
          console.log('MCP OAuth endpoint error:', endpoint, error);
        }
      }

      // Step 3: If all automated methods fail, provide generic manual registration instructions
      console.log('Step 3: All automated registration methods failed, providing manual instructions');
      
      return {
        success: false,
        error: 'This OAuth provider requires manual registration. Please create an OAuth application and add your credentials.',
      };
    } catch (error) {
      console.log('OAuth auto-registration failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Auto-registration failed',
      };
    }
  }
}
