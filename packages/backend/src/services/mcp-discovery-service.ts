import { discoverMcpOAuthRequirements } from '../lib/mcp-oauth-discovery';
import { guardedFetch } from '../lib/destination-guard';

interface MCPDiscoveryResult {
  success: boolean;
  transport_type: string;
  url: string;
  tools_count: number;
  tools: any[];
  capabilities: {
    supports_tool_discovery: boolean;
    supports_tool_calling: boolean;
  };
  oauth: {
    required: boolean;
    resourceName?: string;
    issuer?: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    scopesSupported?: string[];
    bearerMethodsSupported?: string[];
    provider?: string;
    supportsDynamicRegistration?: boolean;
    error?: string;
  };
  health: string;
  error: string | null;
}

export class MCPDiscoveryService {
  async discoverService(url: string): Promise<MCPDiscoveryResult> {
    const result: MCPDiscoveryResult = {
      success: false,
      transport_type: 'http',
      url,
      tools_count: 0,
      tools: [],
      capabilities: {
        supports_tool_discovery: false,
        supports_tool_calling: false,
      },
      oauth: {
        required: false,
      },
      health: 'unknown',
      error: null,
    };

    try {
      // First, check for OAuth requirements
      const oauthInfo = await this.detectOAuthRequirements(url);
      result.oauth = oauthInfo;
      
      if (oauthInfo.required) {
        // Service requires OAuth, mark as successful discovery
        result.success = true;
        result.health = 'oauth_required';
        return result;
      }

      // Try basic MCP discovery without OAuth
      const basicResult = await this.tryBasicDiscovery(url);
      return basicResult;
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Unknown error';
      return result;
    }
  }

  private async tryBasicDiscovery(url: string): Promise<MCPDiscoveryResult> {
    const result: MCPDiscoveryResult = {
      success: false,
      transport_type: 'http',
      url,
      tools_count: 0,
      tools: [],
      capabilities: {
        supports_tool_discovery: false,
        supports_tool_calling: false,
      },
      oauth: {
        required: false,
      },
      health: 'unknown',
      error: null,
    };

    try {
      // Try a simple HTTP request to check if the service is reachable
      const response = await guardedFetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json, text/event-stream',
        },
      });

      if (response.ok) {
        result.success = true;
        result.health = 'healthy';
        result.capabilities.supports_tool_discovery = true;
        result.capabilities.supports_tool_calling = true;
      } else {
        result.error = `HTTP ${response.status}: ${response.statusText}`;
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : 'Connection failed';
    }

    return result;
  }

  private async detectOAuthRequirements(url: string): Promise<MCPDiscoveryResult['oauth']> {
    return discoverMcpOAuthRequirements(url);
  }
}
