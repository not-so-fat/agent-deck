import { Service, ServiceTool } from '@agent-deck/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LocalMCPServerManager } from './local-mcp-server-manager';
import {
  formatMcpConnectionError,
  extractMcpErrorMessage,
  shouldAttemptLegacySseFallback,
} from '../lib/mcp-connection-error';
import { guardedFetch } from '../lib/destination-guard';

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

interface MCPResource {
  uri: string;
  mimeType: string;
  name: string;
  description: string;
}

export class MCPClientManager {
  private clients = new Map<string, Client>();
  private localServerManager: LocalMCPServerManager;

  constructor(
    private resolveAccessToken?: (serviceId: string) => Promise<string | null>,
  ) {
    this.localServerManager = new LocalMCPServerManager();
  }

  invalidateClient(serviceId: string): void {
    const client = this.clients.get(serviceId);
    if (client) {
      void client.close().catch(() => undefined);
      this.clients.delete(serviceId);
    }
  }

  private async buildRequestHeaders(service: Service): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
    };

    if (service.headers) {
      try {
        const customHeaders = typeof service.headers === 'string'
          ? JSON.parse(service.headers) as Record<string, string>
          : { ...service.headers };
        Object.assign(headers, customHeaders);
      } catch (error) {
        console.warn(`⚠️ Failed to parse custom headers for service ${service.id}:`, error);
      }
    }

    const accessToken = this.resolveAccessToken
      ? await this.resolveAccessToken(service.id)
      : service.oauthAccessToken;
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    return headers;
  }

  private async getClient(service: Service): Promise<Client> {
    const clientKey = service.id;
    
    // Check if this is a local MCP server
    if (service.type === 'local-mcp') {
      // For local servers, we need to start them and get the client from the local manager
      if (!this.localServerManager.isLocalServerRunning(service.id)) {
        await this.localServerManager.startLocalServer(service);
      }
      const client = this.localServerManager.getClient(service.id);
      if (!client) {
        throw new Error(`Failed to get client for local MCP server ${service.id}`);
      }
      return client;
    }
    
    if (this.clients.has(clientKey)) {
      return this.clients.get(clientKey)!;
    }

    const baseUrl = new URL(service.url);
    const headers = await this.buildRequestHeaders(service);
    
    const client = await this.connectRemoteClient(baseUrl, headers, service.url);
    this.clients.set(clientKey, client);
    return client;
  }

  private async connectRemoteClient(
    baseUrl: URL,
    headers: Record<string, string>,
    serviceUrl: string,
  ): Promise<Client> {
    const streamableClient = new Client({
      name: 'agent-deck-mcp-client',
      version: '1.0.0',
    });

    try {
      console.log(`🔗 Attempting StreamableHTTP transport for ${serviceUrl}`);
      const streamableTransport = new StreamableHTTPClientTransport(baseUrl, {
        requestInit: { headers },
        fetch: guardedFetch,
      });
      await streamableClient.connect(streamableTransport);
      console.log(`✅ Connected to MCP service ${serviceUrl} using StreamableHTTP transport`);
      return streamableClient;
    } catch (streamableError) {
      const streamableMessage = extractMcpErrorMessage(streamableError);
      if (streamableMessage) {
        throw new Error(
          streamableMessage.toLowerCase().includes('unauthorized')
            ? `${streamableMessage} — link a credential on the service or add Authorization in service headers`
            : streamableMessage,
        );
      }

      if (!shouldAttemptLegacySseFallback(streamableError)) {
        console.error(`❌ StreamableHTTP failed for ${serviceUrl}:`, streamableError);
        throw new Error(formatMcpConnectionError(streamableError, null));
      }

      console.log(`⚠️ StreamableHTTP failed for ${serviceUrl}, trying legacy SSE transport:`, streamableError);

      const sseClient = new Client({
        name: 'agent-deck-mcp-client',
        version: '1.0.0',
      });

      try {
        const sseTransport = new SSEClientTransport(baseUrl, {
          requestInit: { headers },
          fetch: guardedFetch,
        });
        await sseClient.connect(sseTransport);
        console.log(`✅ Connected to MCP service ${serviceUrl} using SSE transport`);
        return sseClient;
      } catch (sseError) {
        console.error(`❌ Both StreamableHTTP and SSE failed for ${serviceUrl}`);
        console.error(`StreamableHTTP error:`, streamableError);
        console.error(`SSE error:`, sseError);
        throw new Error(formatMcpConnectionError(streamableError, sseError));
      }
    }
  }

  async discoverTools(service: Service): Promise<ServiceTool[]> {
    try {
      console.log(`🔍 Discovering tools for MCP service: ${service.url}`);
      
      const client = await this.getClient(service);
      
      // List available tools using the MCP protocol
      const tools = await client.listTools();
      console.log(`📋 Raw tools result from MCP service ${service.url}:`, tools);
      console.log(`📋 Tools type:`, typeof tools);
      console.log(`📋 Tools is array:`, Array.isArray(tools));
      console.log(`📋 Tools structure:`, JSON.stringify(tools, null, 2));
      
      // Handle different response formats from MCP SDK
      let toolsArray: any[] = [];
      
      if (Array.isArray(tools)) {
        toolsArray = tools;
      } else if (tools && typeof tools === 'object' && tools.tools) {
        // MCP SDK might return { tools: [...] }
        toolsArray = Array.isArray(tools.tools) ? tools.tools : [];
      } else if (tools && typeof tools === 'object') {
        // Try to extract tools from object structure
        console.log(`🔍 Attempting to extract tools from object structure`);
        toolsArray = [];
      }
      
      console.log(`📋 Final tools array length:`, toolsArray.length);
      
      // Convert MCP tools to our ServiceTool format
      const serviceTools: ServiceTool[] = toolsArray.map((tool: any) => ({
        name: tool.name || 'Unknown Tool',
        title: typeof tool.title === 'string' && tool.title.trim() ? tool.title.trim() : undefined,
        description: tool.description || '',
        inputSchema: tool.inputSchema || {},
      }));

      console.log(`✅ Successfully discovered ${serviceTools.length} tools for ${service.url}`);
      return serviceTools;
    } catch (error) {
      console.error(`❌ Failed to discover tools for service ${service.id}:`, error);
      throw error;
    }
  }



  async callTool(service: Service, toolName: string, arguments_: any): Promise<any> {
    try {
      console.log(`🔧 Calling tool ${toolName} on MCP service: ${service.url}`);
      
      // For local servers, use the local manager
      if (service.type === 'local-mcp') {
        return await this.localServerManager.callTool(service.id, toolName, arguments_);
      }
      
      const client = await this.getClient(service);
      
      // Call the tool using the MCP protocol
      const result = await client.callTool({
        name: toolName,
        arguments: arguments_ || {},
      });

      console.log(`✅ Successfully called tool ${toolName} on ${service.url}`);
      return result;
    } catch (error) {
      console.error(`❌ Failed to call tool ${toolName} for service ${service.id}:`, error);
      throw error;
    }
  }

  async discoverResources(service: Service): Promise<MCPResource[]> {
    try {
      console.log(`🔍 Discovering resources for MCP service: ${service.url}`);
      
      // For local servers, get capabilities from the local manager
      if (service.type === 'local-mcp') {
        const processRecord = this.localServerManager.getLocalServer(service.id);
        if (processRecord?.capabilities?.resources) {
          return processRecord.capabilities.resources.map((resource: any) => ({
            uri: resource.uri,
            mimeType: resource.mimeType || 'application/json',
            name: resource.name || resource.uri,
            description: resource.description || '',
          }));
        }
        return [];
      }
      
      const client = await this.getClient(service);
      
      // List available resources using the MCP protocol
      const resources = await client.listResources();
      console.log(`📋 Found ${resources.length} resources from MCP service ${service.url}`);
      
      // Convert MCP resources to our format
      const mcpResources: MCPResource[] = (resources as unknown as any[]).map((resource: any) => ({
        uri: resource.uri,
        mimeType: resource.mimeType || 'application/json',
        name: resource.name || resource.uri,
        description: resource.description || '',
      }));

      return mcpResources;
    } catch (error) {
      console.error(`❌ Failed to discover resources for service ${service.id}:`, error);
      throw error;
    }
  }

  async getResource(service: Service, resourceUri: string): Promise<any> {
    try {
      console.log(`📖 Getting resource ${resourceUri} from MCP service: ${service.url}`);
      
      // For local servers, use the local manager
      if (service.type === 'local-mcp') {
        return await this.localServerManager.getResource(service.id, resourceUri);
      }
      
      const client = await this.getClient(service);
      
      // Read the resource using the MCP protocol
      const resource = await client.readResource({
        uri: resourceUri,
      });

      return resource;
    } catch (error) {
      console.error(`❌ Failed to get resource ${resourceUri} for service ${service.id}:`, error);
      throw error;
    }
  }

  async listPrompts(service: Service): Promise<string[]> {
    try {
      console.log(`🔍 Listing prompts for MCP service: ${service.url}`);
      
      // For local servers, get capabilities from the local manager
      if (service.type === 'local-mcp') {
        const processRecord = this.localServerManager.getLocalServer(service.id);
        return processRecord?.capabilities?.prompts || [];
      }
      
      const client = await this.getClient(service);
      
      // List available prompts using the MCP protocol
      const prompts = await client.listPrompts();
      console.log(`📋 Found ${prompts.length} prompts from MCP service ${service.url}`);
      
      return (prompts as unknown as any[]).map((prompt: any) => prompt.name);
    } catch (error) {
      console.error(`❌ Failed to list prompts for service ${service.id}:`, error);
      throw error;
    }
  }

  async getPrompt(service: Service, promptName: string, arguments_?: Record<string, any>): Promise<any> {
    try {
      console.log(`📝 Getting prompt ${promptName} from MCP service: ${service.url}`);
      
      // For local servers, use the local manager
      if (service.type === 'local-mcp') {
        return await this.localServerManager.getPrompt(service.id, promptName, arguments_);
      }
      
      const client = await this.getClient(service);
      
      // Get the prompt using the MCP protocol
      const prompt = await client.getPrompt({
        name: promptName,
        arguments: arguments_ || {},
      });

      return prompt;
    } catch (error) {
      console.error(`❌ Failed to get prompt ${promptName} for service ${service.id}:`, error);
      throw error;
    }
  }

  // Cleanup method to close connections
  async cleanup(): Promise<void> {
    console.log(`🧹 Cleaning up ${this.clients.size} MCP client connections`);
    for (const [key, client] of this.clients.entries()) {
      try {
        await client.close();
        console.log(`✅ Closed connection for ${key}`);
      } catch (error) {
        console.error(`❌ Error closing client for ${key}:`, error);
      }
    }
    this.clients.clear();
    
    // Clean up local servers
    await this.localServerManager.cleanup();
  }
}
