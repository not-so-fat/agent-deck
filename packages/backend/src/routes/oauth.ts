import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { 
  OAuthFlowInput,
  OAuthCallbackInput,
  OAuthRefreshInput,
  ApiResponse,
  OAuthDiscoveryResult,
  OAuthToken
} from '@agent-deck/shared';
import { resolveDashboardOrigin } from '../lib/paths';
import { getOAuthSetupInfo, startOAuthConnect } from '../services/oauth-connect-service';

interface OAuthFlowRequest {
  Params: { serviceId: string };
  Querystring: { redirectUri: string };
}

interface OAuthCallbackRequest {
  Params: { serviceId: string };
  Querystring: { code: string; state: string };
}

interface OAuthRefreshRequest {
  Params: { serviceId: string };
  Body: { refreshToken: string };
}

interface ServiceIdRequest {
  Params: { serviceId: string };
}

interface OAuthConnectRequest {
  Params: { serviceId: string };
  Body: { clientId?: string; clientSecret?: string };
}

export async function registerOAuthRoutes(fastify: FastifyInstance) {
  // Discover OAuth configuration for a service
  fastify.get<ServiceIdRequest>('/:serviceId/discover', async (request, reply) => {
    try {
      const service = await fastify.db.getService(request.params.serviceId);
      if (!service) {
        const response: ApiResponse = {
          success: false,
          error: 'Service not found',
        };
        
        return reply.status(404).send(response);
      }

      const discovery = await fastify.oauthManager.discoverOAuth(service.url);
      
      const response: ApiResponse<OAuthDiscoveryResult> = {
        success: true,
        data: discovery,
      };
      
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      
      return reply.status(500).send(response);
    }
  });

  // OAuth setup guide + discovery for a service
  fastify.get<ServiceIdRequest>('/:serviceId/setup', async (request, reply) => {
    try {
      const { guide, discovery, savedOAuthClientId, hasStoredClientSecret, hasSavedCredentials } =
        await getOAuthSetupInfo(fastify.db, request.params.serviceId, fastify.oauthClientSecretVault);
      const response: ApiResponse = {
        success: true,
        data: {
          guide,
          oauth: discovery.oauth,
          savedOAuthClientId,
          hasStoredClientSecret,
          hasSavedCredentials,
        },
      };
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      return reply.status(400).send(response);
    }
  });

  // Connect OAuth (auto-register or manual client credentials)
  fastify.post<OAuthConnectRequest>('/:serviceId/connect', async (request, reply) => {
    try {
      const result = await startOAuthConnect(
        fastify.db,
        fastify.oauthManager,
        fastify.oauthClientSecretVault,
        request.params.serviceId,
        request.body ?? {},
      );

      if (!result.success) {
        const response: ApiResponse = {
          success: false,
          error: result.error,
          data: {
            needsCredentials: result.needsCredentials,
            setupMode: result.setupMode,
            guide: result.guide,
          },
        };
        return reply.status(result.needsCredentials || result.setupMode === 'unavailable' ? 400 : 400).send(response);
      }

      const response: ApiResponse = {
        success: true,
        data: {
          authorizationUrl: result.authorizationUrl,
          state: result.state,
          mode: result.mode,
        },
      };
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      return reply.status(400).send(response);
    }
  });

  // Auto-register OAuth application and initiate flow (legacy alias)
  fastify.post<OAuthConnectRequest>('/:serviceId/auto-setup', async (request, reply) => {
    try {
      const result = await startOAuthConnect(
        fastify.db,
        fastify.oauthManager,
        fastify.oauthClientSecretVault,
        request.params.serviceId,
        request.body ?? {},
      );

      if (!result.success) {
        const response: ApiResponse = {
          success: false,
          error: result.error,
          data: {
            needsCredentials: result.needsCredentials,
            setupMode: result.setupMode,
            guide: result.guide,
          },
        };
        return reply.status(400).send(response);
      }

      const response: ApiResponse = {
        success: true,
        data: {
          authorizationUrl: result.authorizationUrl,
          state: result.state,
          mode: result.mode,
          message: 'OAuth application registered and authorization flow initiated',
        },
      };
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      return reply.status(400).send(response);
    }
  });

  // Initiate OAuth flow (existing endpoint)
  fastify.get<OAuthFlowRequest>('/:serviceId/authorize', async (request, reply) => {
    try {
      const { authorizationUrl, state } = await fastify.oauthManager.initiateOAuthFlow({
        serviceId: request.params.serviceId,
        redirectUri: request.query.redirectUri,
      });
      
      const response: ApiResponse = {
        success: true,
        data: {
          authorizationUrl,
          state,
        },
      };
      
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      
      return reply.status(400).send(response);
    }
  });

  // Handle OAuth callback (generic endpoint for all services)
  fastify.get('/callback', async (request, reply) => {
    try {
      const { code, state } = request.query as { code: string; state: string };
      
      if (!code || !state) {
        const response: ApiResponse = {
          success: false,
          error: 'Missing authorization code or state parameter',
        };
        return reply.status(400).send(response);
      }

      // Extract service ID from state using OAuth manager's state mapping
      const serviceId = fastify.oauthManager.getOAuthState(state);
      
      if (!serviceId) {
        const response: ApiResponse = {
          success: false,
          error: 'Invalid or expired OAuth state',
        };
        return reply.status(400).send(response);
      }

      const token = await fastify.oauthManager.handleOAuthCallback({
        serviceId,
        code,
        state,
      });

      fastify.collectionWarningService.clearCache(serviceId);

      try {
        await fastify.serviceManager.discoverServiceTools(serviceId);
        fastify.broadcastServiceUpdate({
          serviceId,
          health: 'healthy',
          isConnected: true,
          lastPing: new Date().toISOString(),
        });
      } catch (error) {
        fastify.log.warn(`OAuth succeeded but post-auth tool discovery failed for ${serviceId}: ${error}`);
        fastify.broadcastServiceUpdate({
          serviceId,
          health: 'unknown',
          isConnected: false,
          lastPing: new Date().toISOString(),
        });
      }

      const dashboardOrigin = resolveDashboardOrigin();
      return reply.redirect(`${dashboardOrigin}/oauth/callback?success=true&serviceId=${serviceId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'OAuth callback failed';
      const dashboardOrigin = resolveDashboardOrigin();
      return reply.redirect(
        `${dashboardOrigin}/oauth/callback?success=false&error=${encodeURIComponent(errorMessage)}`,
      );
    }
  });

  // Handle OAuth callback (legacy endpoint with service ID)
  fastify.get<OAuthCallbackRequest>('/:serviceId/callback', async (request, reply) => {
    try {
      const token = await fastify.oauthManager.handleOAuthCallback({
        serviceId: request.params.serviceId,
        code: request.query.code,
        state: request.query.state,
      });
      
      const response: ApiResponse<OAuthToken> = {
        success: true,
        data: token,
        message: 'OAuth authentication successful',
      };
      
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      
      return reply.status(400).send(response);
    }
  });

  // Refresh OAuth token
  fastify.post<OAuthRefreshRequest>('/:serviceId/refresh', async (request, reply) => {
    try {
      const token = await fastify.oauthManager.refreshOAuthToken({
        serviceId: request.params.serviceId,
        refreshToken: request.body.refreshToken,
      });
      
      const response: ApiResponse<OAuthToken> = {
        success: true,
        data: token,
        message: 'OAuth token refreshed successfully',
      };
      
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      
      return reply.status(400).send(response);
    }
  });

  // Get OAuth status for a service
  fastify.get<ServiceIdRequest>('/:serviceId/status', async (request, reply) => {
    try {
      const service = await fastify.db.getService(request.params.serviceId);
      if (!service) {
        const response: ApiResponse = {
          success: false,
          error: 'Service not found',
        };
        
        return reply.status(404).send(response);
      }

      const serviceId = request.params.serviceId;
      const hasToken = await fastify.oauthManager.hasOAuthTokens(serviceId);
      const hasRefreshToken = await fastify.oauthManager.hasRefreshToken(serviceId);
      let refreshFailed = false;

      if (hasToken) {
        const accessToken = await fastify.oauthManager.getValidAccessToken(serviceId);
        if (!accessToken && hasRefreshToken) {
          refreshFailed = true;
        }
      }

      const refreshedService = await fastify.db.getService(serviceId);
      const isExpired = await fastify.oauthManager.isTokenExpired(serviceId);
      const authenticated = hasToken && !isExpired && !refreshFailed;

      const response: ApiResponse = {
        success: true,
        data: {
          hasToken,
          isExpired,
          authenticated,
          hasRefreshToken,
          refreshFailed,
          expiresAt: refreshedService?.oauthTokenExpiresAt ?? service.oauthTokenExpiresAt,
        },
      };
      
      return reply.send(response);
    } catch (error) {
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      
      return reply.status(500).send(response);
    }
  });
}
