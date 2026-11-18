
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Service, LocalMCPServerProcess } from '@agent-deck/shared';
import { generateId } from '@agent-deck/shared';

export class LocalMCPServerManager {
  private processes = new Map<string, LocalMCPServerProcess>();
  private clients = new Map<string, Client>();

  /**
   * Start a local MCP server process
   */
  async startLocalServer(service: Service): Promise<LocalMCPServerProcess> {
    if (!service.localCommand) {
      throw new Error('Local command not configured for service');
    }

    const processId = generateId();
    console.log(`🚀 Starting local MCP server: ${service.name} (${service.localCommand} ${service.localArgs?.join(' ')})`);

    try {
      // Prepare environment variables
      const env: Record<string, string> = {};
      
      // Copy process.env, filtering out undefined values
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      
      // Add service-specific environment variables
      if (service.localEnv) {
        Object.assign(env, service.localEnv);
      }

      // Create MCP client with stdio transport
      const client = new Client({
        name: 'agent-deck-local-mcp-client',
        version: '1.0.0'
      });

      const transport = new StdioClientTransport({
        command: service.localCommand,
        args: service.localArgs || [],
        cwd: service.localWorkingDir,
        env: env,
      });
      
      // Connect to the local server
      await client.connect(transport);

      // Discover capabilities
      const capabilities = await this.discoverCapabilities(client);

      // Create process record
      const processRecord: LocalMCPServerProcess = {
        id: processId,
        serviceId: service.id,
        process: null, // The transport manages the process internally
        isRunning: true,
        startTime: new Date(),
        lastActivity: new Date(),
        capabilities,
      };

      // Store references
      this.processes.set(processId, processRecord);
      this.clients.set(service.id, client);

      console.log(`✅ Local MCP server started: ${service.name}`);
      console.log(`📋 Discovered ${capabilities.tools.length} tools, ${capabilities.resources.length} resources, ${capabilities.prompts.length} prompts`);

      return processRecord;
    } catch (error) {
      console.error(`❌ Failed to start local MCP server ${service.name}:`, error);
      throw error;
    }
  }

  /**
   * Stop a local MCP server process
   */
  async stopLocalServer(serviceId: string): Promise<void> {
    const processRecord = Array.from(this.processes.values()).find(p => p.serviceId === serviceId);
    if (!processRecord) {
      console.log(`⚠️ No local server found for service ${serviceId}`);
      return;
    }

    console.log(`🛑 Stopping local MCP server: ${processRecord.serviceId}`);

    try {
      // Close the MCP client connection (this will also stop the process)
      const client = this.clients.get(serviceId);
      if (client) {
        await client.close();
        this.clients.delete(serviceId);
      }

      // Remove from tracking
      this.processes.delete(processRecord.id);
      
      console.log(`✅ Local MCP server stopped: ${serviceId}`);
    } catch (error) {
      console.error(`❌ Error stopping local MCP server ${serviceId}:`, error);
      throw error;
    }
  }

  /**
   * Get a local MCP server process
   */
  getLocalServer(serviceId: string): LocalMCPServerProcess | undefined {
    return Array.from(this.processes.values()).find(p => p.serviceId === serviceId);
  }

  /**
   * Get the MCP client for a local server
   */
  getClient(serviceId: string): Client | undefined {
    return this.clients.get(serviceId);
  }

  /**
   * Check if a local server is running
   */
  isLocalServerRunning(serviceId: string): boolean {
    const processRecord = this.getLocalServer(serviceId);
    return processRecord?.isRunning || false;
  }

  /**
   * Discover capabilities of a local MCP server
   */
  private async discoverCapabilities(client: Client) {
    try {
      const [toolsResponse, resources, prompts] = await Promise.all([
        client.listTools().catch(() => ({ tools: [] })),
        client.listResources().catch(() => []),
        client.listPrompts().catch(() => []),
      ]);

      // Handle tools response - it might be an object with a tools property or a direct array
      const tools = Array.isArray(toolsResponse) ? toolsResponse : (toolsResponse as any)?.tools || [];

      return {
        tools: tools.map((tool: any) => ({
          name: tool.name || 'Unknown Tool',
          title: typeof tool.title === 'string' && tool.title.trim() ? tool.title.trim() : undefined,
          description: tool.description || '',
          inputSchema: tool.inputSchema || {},
        })),
        resources: resources as any[] || [],
        prompts: (prompts as any[] || []).map((prompt: any) => prompt.name || 'Unknown Prompt'),
      };
    } catch (error) {
      console.error('❌ Failed to discover capabilities:', error);
      return {
        tools: [],
        resources: [],
        prompts: [],
      };
    }
  }



  /**
   * Call a tool on a local MCP server
   */
  async callTool(serviceId: string, toolName: string, arguments_: any): Promise<any> {
    const client = this.clients.get(serviceId);
    if (!client) {
      throw new Error(`No local MCP client found for service ${serviceId}`);
    }

    const processRecord = this.getLocalServer(serviceId);
    if (!processRecord?.isRunning) {
      throw new Error(`Local MCP server ${serviceId} is not running`);
    }

    try {
      console.log(`🔧 Calling tool ${toolName} on local MCP server ${serviceId}`);
      
      // Update last activity
      processRecord.lastActivity = new Date();

      // Call the tool
      const result = await client.callTool({
        name: toolName,
        arguments: arguments_ || {},
      });

      console.log(`✅ Successfully called tool ${toolName} on local server ${serviceId}`);
      return result;
    } catch (error) {
      console.error(`❌ Failed to call tool ${toolName} on local server ${serviceId}:`, error);
      throw error;
    }
  }

  /**
   * Get a resource from a local MCP server
   */
  async getResource(serviceId: string, resourceUri: string): Promise<any> {
    const client = this.clients.get(serviceId);
    if (!client) {
      throw new Error(`No local MCP client found for service ${serviceId}`);
    }

    const processRecord = this.getLocalServer(serviceId);
    if (!processRecord?.isRunning) {
      throw new Error(`Local MCP server ${serviceId} is not running`);
    }

    try {
      console.log(`📖 Getting resource ${resourceUri} from local MCP server ${serviceId}`);
      
      // Update last activity
      processRecord.lastActivity = new Date();

      // Get the resource
      const result = await client.readResource({
        uri: resourceUri,
      });

      return result;
    } catch (error) {
      console.error(`❌ Failed to get resource ${resourceUri} from local server ${serviceId}:`, error);
      throw error;
    }
  }

  /**
   * Get a prompt from a local MCP server
   */
  async getPrompt(serviceId: string, promptName: string, arguments_?: Record<string, any>): Promise<any> {
    const client = this.clients.get(serviceId);
    if (!client) {
      throw new Error(`No local MCP client found for service ${serviceId}`);
    }

    const processRecord = this.getLocalServer(serviceId);
    if (!processRecord?.isRunning) {
      throw new Error(`Local MCP server ${serviceId} is not running`);
    }

    try {
      console.log(`📝 Getting prompt ${promptName} from local MCP server ${serviceId}`);
      
      // Update last activity
      processRecord.lastActivity = new Date();

      // Get the prompt
      const result = await client.getPrompt({
        name: promptName,
        arguments: arguments_ || {},
      });

      return result;
    } catch (error) {
      console.error(`❌ Failed to get prompt ${promptName} from local server ${serviceId}:`, error);
      throw error;
    }
  }

  /**
   * Get all running local servers
   */
  getAllRunningServers(): LocalMCPServerProcess[] {
    return Array.from(this.processes.values()).filter(p => p.isRunning);
  }

  /**
   * Cleanup all local servers
   */
  async cleanup(): Promise<void> {
    console.log(`🧹 Cleaning up ${this.processes.size} local MCP server processes`);
    
    const stopPromises = Array.from(this.processes.values()).map(processRecord => 
      this.stopLocalServer(processRecord.serviceId)
    );
    
    await Promise.all(stopPromises);
    console.log(`✅ Cleanup completed`);
  }
}
