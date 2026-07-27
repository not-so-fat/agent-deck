import { 
  Service, 
  CreateServiceInput, 
  UpdateServiceInput,
  ServiceTool,
  ServiceCallInput,
  ServiceCallResult,
  CreateServiceSchema,
  UpdateServiceSchema,
  ServiceCallSchema,
  UpdateServiceToolSettingsInput,
  ServiceStatusUpdate,
} from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { MCPClientManager } from './mcp-client-manager';
import { OAuthManager } from './oauth-manager';
import { OAuthClientSecretVault } from '../vault/oauth-client-secret-vault';
import { CredentialManager } from '../vault/credential-manager';
import { ConfigManager } from './config-manager';
import {
  cacheIconForService,
  getServiceIconPath,
  serviceIconApiPath,
  serviceIconFileExists,
} from './icon-resolver';
import {
  classifyMcpErrorCode,
  resolveMcpErrorMessage,
} from '../lib/mcp-connection-error';
import { normalizeServiceToolResult } from '../lib/normalize-service-tool-result';
import { storeServiceFromDb } from '../store/service-codec';
import { FileStoreWriter } from '../store/writer';

interface A2AManifest {
  endpoints?: Record<string, A2AEndpoint>;
}

interface A2AEndpoint {
  path: string;
  method?: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export class ServiceManager {
  private configManager: ConfigManager;

  constructor(
    private db: DatabaseManager,
    private mcpClient: MCPClientManager,
    private oauthManager: OAuthManager,
    private clientSecrets: OAuthClientSecretVault,
    private credentialManager?: CredentialManager,
    private storeWriter?: FileStoreWriter,
  ) {
    this.configManager = new ConfigManager();
  }

  private async writeToStore(service: Service): Promise<void> {
    if (!this.storeWriter) {
      return;
    }

    try {
      await this.storeWriter.writeService(storeServiceFromDb(service));
      await this.storeWriter.touchHash(this.db);
    } catch (error) {
      console.error(`Failed to write service ${service.id} to file store:`, error);
      throw error;
    }
  }

  private async deleteFromStore(id: string): Promise<void> {
    if (!this.storeWriter) {
      return;
    }

    try {
      await this.storeWriter.deleteService(id);
      await this.storeWriter.touchHash(this.db);
    } catch (error) {
      console.error(`Failed to delete service ${id} from file store:`, error);
      throw error;
    }
  }

  get mcpClientManager(): MCPClientManager {
    return this.mcpClient;
  }

  async createService(input: CreateServiceInput): Promise<Service> {
    // Validate input
    const validatedInput = CreateServiceSchema.parse(input);
    
    // Check for name conflicts
    const existingServices = await this.db.getAllServices();
    const nameConflict = existingServices.find(s => s.name === validatedInput.name);
    if (nameConflict) {
      throw new Error(`Service with name "${validatedInput.name}" already exists`);
    }
    
    // Create service in database
    const service = await this.db.createService(validatedInput);
    
    // Try to discover OAuth configuration if it's an MCP service
    if (service.type === 'mcp' && !service.oauthClientId) {
      try {
        const oauthDiscovery = await this.oauthManager.discoverOAuth(service.url);
        if (oauthDiscovery.hasOAuth && oauthDiscovery.config) {
          if (oauthDiscovery.config.clientSecret) {
            await this.clientSecrets.set(service.id, oauthDiscovery.config.clientSecret);
          }
          await this.db.updateService(service.id, {
            oauthClientId: oauthDiscovery.config.clientId,
            oauthClientSecret: '',
            oauthAuthorizationUrl: oauthDiscovery.config.authorizationUrl,
            oauthTokenUrl: oauthDiscovery.config.tokenUrl,
            oauthRedirectUri: oauthDiscovery.config.redirectUri,
            oauthScope: oauthDiscovery.config.scope,
          });
        }
      } catch (error) {
        console.warn(`Failed to discover OAuth for service ${service.id}:`, error);
      }
    }
    
    void this.refreshServiceIcon(service.id).catch((error) => {
      console.warn(`Failed to resolve icon for service ${service.name}:`, error);
    });

    void this.probeInitialHealth(service.id);

    await this.writeToStore((await this.db.getService(service.id)) ?? service);
    return service;
  }

  private probeInitialHealth(serviceId: string): void {
    void this.discoverServiceTools(serviceId).catch((error) => {
      console.warn(`Initial health probe failed for service ${serviceId}:`, error);
    });
  }

  async refreshUnknownServiceHealth(
    onUpdate?: (update: ServiceStatusUpdate) => void,
  ): Promise<void> {
    const services = await this.db.getAllServices();

    await Promise.all(
      services.map(async (service) => {
        if (!this.shouldBackgroundProbe(service)) {
          return;
        }

        const result = await this.checkServiceHealth(service.id);
        if (!onUpdate || !('health' in result) || !result.success) {
          return;
        }

        const health = result.health as ServiceStatusUpdate['health'];
        if (service.health === health && service.isConnected === result.isConnected) {
          return;
        }

        onUpdate({
          serviceId: service.id,
          health: result.health as ServiceStatusUpdate['health'],
          isConnected: result.isConnected,
          lastPing: new Date().toISOString(),
        });
      }),
    );
  }

  private shouldBackgroundProbe(service: Service): boolean {
    if (service.health !== 'unknown') {
      return false;
    }

    if (service.type === 'local-mcp' || service.type === 'a2a') {
      return true;
    }

    if (service.type !== 'mcp') {
      return false;
    }

    const hasOAuthConfig = Boolean(
      service.oauthClientId ||
        service.oauthAuthorizationUrl ||
        service.oauthTokenUrl,
    );
    const hasAuth = Boolean(
      service.oauthHasToken ||
        service.oauthAccessToken ||
        service.headers?.Authorization,
    );
    if (hasOAuthConfig && !hasAuth) {
      return false;
    }

    return true;
  }

  async refreshServiceIcon(serviceId: string): Promise<Service | null> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      return null;
    }

    if (!this.shouldResolveIcon(service)) {
      return service;
    }

    const result = await cacheIconForService(serviceId, service.url);
    if (!result.iconPath) {
      return service;
    }

    return await this.db.updateService(serviceId, {
      iconUrl: serviceIconApiPath(serviceId),
    });
  }

  private shouldResolveIcon(service: Service): boolean {
    return service.type !== 'local-mcp' && !service.url.startsWith('local://');
  }

  async backfillMissingIcons(): Promise<void> {
    const services = await this.db.getAllServices();
    const needsRefresh: Service[] = [];
    for (const service of services) {
      if (!this.shouldResolveIcon(service)) {
        continue;
      }
      if (!service.iconUrl) {
        needsRefresh.push(service);
        continue;
      }
      if (!(await serviceIconFileExists(service.id))) {
        needsRefresh.push(service);
      }
    }

    await Promise.all(
      needsRefresh.map((service) =>
        this.refreshServiceIcon(service.id).catch((error) => {
          console.warn(`Failed to resolve icon for service ${service.name}:`, error);
        }),
      ),
    );
  }

  async getService(id: string): Promise<Service | null> {
    return await this.db.getService(id);
  }

  async getAllServices(): Promise<Service[]> {
    const services = await this.db.getAllServices();
    return Promise.all(
      services.map(async (service) => {
        if (!this.shouldResolveIcon(service)) {
          return service;
        }

        const missingIconUrl = !service.iconUrl;
        const missingCacheFile = service.iconUrl && !(await serviceIconFileExists(service.id));
        if (missingIconUrl || missingCacheFile) {
          const updated = await this.refreshServiceIcon(service.id);
          return updated ?? service;
        }
        return service;
      }),
    );
  }

  async updateService(id: string, input: UpdateServiceInput): Promise<Service | null> {
    // Validate input
    const validatedInput = UpdateServiceSchema.parse(input);
    
    const service = await this.db.updateService(id, validatedInput);
    if (service) {
      await this.writeToStore(service);
    }
    return service;
  }

  async deleteService(id: string): Promise<boolean> {
    // First, get the service to check if it's a local MCP server
    const service = await this.db.getService(id);
    if (!service) {
      return false; // Service doesn't exist
    }
    
    // If it's a local MCP server, stop it first
    if (service.type === 'local-mcp') {
      try {
        console.log(`🛑 Stopping local MCP server before deletion: ${service.name}`);
        await this.stopLocalServer(id);
      } catch (error) {
        console.warn(`⚠️ Failed to stop local MCP server ${service.name}:`, error);
      }
    }

    const dependents = await this.db.getPlaybooksDependingOnService(id);
    if (dependents.length > 0) {
      const { PlaybookDependencyError } = await import('../playbooks/playbook-manager');
      throw new PlaybookDependencyError(
        `Cannot delete MCP "${service.name}": referenced by playbook(s): ${dependents.map((p) => p.title).join(', ')}`,
        dependents.map(({ id: playbookId, title }) => ({ id: playbookId, title })),
      );
    }
    
    const deleted = await this.db.deleteService(id);
    if (deleted) {
      await this.deleteFromStore(id);
    }
    return deleted;
  }

  private async prepareServiceForRemoteCall(service: Service): Promise<Service> {
    const headers =
      typeof service.headers === 'string'
        ? (JSON.parse(service.headers) as Record<string, string>)
        : { ...(service.headers ?? {}) };

    if (service.credentialId && this.credentialManager) {
      const credentialHeaders = await this.credentialManager.resolveHttpHeaders(service.credentialId);
      Object.assign(headers, credentialHeaders);
    }

    return { ...service, headers };
  }

  async discoverServiceTools(
    serviceId: string,
    options?: { forAgent?: boolean },
  ): Promise<ServiceTool[] | { success: false; error: string }> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      return { success: false, error: 'Service not found' };
    }

    try {
      let tools: ServiceTool[];
      const prepared = await this.prepareServiceForRemoteCall(service);

      if (service.type === 'mcp' || service.type === 'local-mcp') {
        tools = await this.mcpClient.discoverTools(prepared);
      } else if (service.type === 'a2a') {
        tools = await this.discoverA2ATools(service);
      } else {
        return { success: false, error: `Unsupported service type: ${service.type}` };
      }

      const annotated = this.annotateToolEnabledState(tools, service.disabledToolNames ?? []);
      await this.db.updateServiceStatus(serviceId, true, 'healthy');

      if (options?.forAgent) {
        return annotated.filter((tool) => tool.enabled !== false);
      }

      return annotated;
    } catch (error) {
      console.error(`Failed to discover tools for service ${serviceId}:`, error);
      if (service.type === 'mcp' || service.type === 'local-mcp') {
        this.mcpClient.invalidateClient(serviceId);
      }
      await this.db.updateServiceStatus(serviceId, false, 'unhealthy');
      const message = error instanceof Error ? error.message : 'Failed to discover tools';
      return { success: false, error: message };
    }
  }

  async updateToolSettings(
    serviceId: string,
    input: UpdateServiceToolSettingsInput,
  ): Promise<Service | null> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      return null;
    }

    const discovered = await this.discoverServiceTools(serviceId);
    if (!Array.isArray(discovered)) {
      return this.db.updateServiceDisabledTools(serviceId, input.disabledTools);
    }

    const knownNames = new Set(discovered.map((tool) => tool.name));
    const pruned = input.disabledTools.filter((name) => knownNames.has(name));
    return this.db.updateServiceDisabledTools(serviceId, pruned);
  }

  private annotateToolEnabledState(
    tools: ServiceTool[],
    disabledToolNames: string[],
  ): ServiceTool[] {
    const disabled = new Set(disabledToolNames);
    return tools.map((tool) => ({
      ...tool,
      enabled: !disabled.has(tool.name),
    }));
  }

  async callServiceTool(input: ServiceCallInput): Promise<ServiceCallResult> {
    // Validate input
    const validatedInput = ServiceCallSchema.parse(input);
    
    const service = await this.db.getService(validatedInput.serviceId);
    if (!service) {
      return {
        success: false,
        error: 'Service not found',
      };
    }

    if ((service.disabledToolNames ?? []).includes(validatedInput.toolName)) {
      return {
        success: false,
        error: `Tool "${validatedInput.toolName}" is disabled for this service`,
      };
    }

    try {
      const prepared = await this.prepareServiceForRemoteCall(service);

      if (service.type === 'mcp' || service.type === 'local-mcp') {
        const result = await this.mcpClient.callTool(
          prepared,
          validatedInput.toolName,
          validatedInput.arguments
        );
        return normalizeServiceToolResult({
          result,
          service,
          toolName: validatedInput.toolName,
        });
      } else if (service.type === 'a2a') {
        const result = await this.callA2ATool(service, validatedInput.toolName, validatedInput.arguments || {});
        return {
          success: true,
          result: result,
        };
      } else {
        return {
          success: false,
          error: `Unsupported service type: ${service.type}`,
        };
      }
    } catch (error) {
      console.error(`Failed to call tool for service ${validatedInput.serviceId}:`, error);

      if (service.type === 'mcp' || service.type === 'local-mcp') {
        this.mcpClient.invalidateClient(validatedInput.serviceId);
      }
      await this.db.updateServiceStatus(validatedInput.serviceId, false, 'unhealthy');

      const cause = resolveMcpErrorMessage(error);
      return {
        success: false,
        error: 'Failed to call tool',
        error_code: classifyMcpErrorCode(cause),
        details: {
          service_id: service.id,
          service_name: service.name,
          remote_url: service.url,
          tool_name: validatedInput.toolName,
          cause,
          phase: 'callTool',
        },
        serviceName: service.name,
        toolName: validatedInput.toolName,
      };
    }
  }

  async checkServiceHealth(serviceId: string): Promise<{ success: boolean; health: string; isConnected: boolean } | { success: false; error: string }> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      return { success: false, error: 'Service not found' };
    }

    const result = await this.discoverServiceTools(serviceId);
    if (!Array.isArray(result)) {
      return {
        success: true,
        health: 'unhealthy',
        isConnected: false,
      };
    }

    return {
      success: true,
      health: 'healthy',
      isConnected: true,
    };
  }

  private async discoverA2ATools(service: Service): Promise<ServiceTool[]> {
    try {
      const response = await fetch(`${service.url}/manifest`);
      if (!response.ok) {
        throw new Error(`Failed to fetch A2A manifest: ${response.statusText}`);
      }

      const manifest: A2AManifest = await response.json() as A2AManifest;
      const tools: ServiceTool[] = [];

      if (manifest.endpoints) {
        for (const [name, endpoint] of Object.entries(manifest.endpoints)) {
          tools.push({
            name,
            description: endpoint.description || `A2A endpoint: ${name}`,
            inputSchema: endpoint.inputSchema || {},
          });
        }
      }

      return tools;
    } catch (error) {
      console.error(`Failed to discover A2A tools for service ${service.id}:`, error);
      throw error;
    }
  }

  private async callA2ATool(service: Service, toolName: string, arguments_: Record<string, any>): Promise<any> {
    try {
      const response = await fetch(`${service.url}/${toolName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...service.headers,
        },
        body: JSON.stringify(arguments_),
      });

      if (!response.ok) {
        throw new Error(`A2A tool call failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to call A2A tool ${toolName} for service ${service.id}:`, error);
      throw error;
    }
  }

  /**
   * Import local MCP servers from JSON configuration
   */
  async importLocalServersFromConfig(jsonContent: string): Promise<Service[]> {
    try {
      const manifest = this.configManager.parseManifest(jsonContent);
      const services = this.configManager.manifestToServices(manifest);
      
      const createdServices: Service[] = [];
      
      for (const serviceInput of services) {
        // Check if service already exists (any type with same name)
        const existingServices = await this.db.getAllServices();
        const existingService = existingServices.find(s => s.name === serviceInput.name);
        
        if (existingService) {
          console.log(`⚠️ Service with name "${serviceInput.name}" already exists (type: ${existingService.type}), skipping`);
          throw new Error(`Service with name "${serviceInput.name}" already exists`);
        }
        
        // Validate command safety
        if (!this.configManager.isCommandSafe(serviceInput.localCommand!)) {
          console.warn(`⚠️ Skipping potentially unsafe command: ${serviceInput.localCommand}`);
          continue;
        }
        
        // Sanitize environment variables
        if (serviceInput.localEnv) {
          serviceInput.localEnv = this.configManager.sanitizeEnvironment(serviceInput.localEnv);
        }
        
        const service = await this.createService(serviceInput);
        createdServices.push(service);
        console.log(`✅ Created local MCP server: ${service.name}`);
      }
      
      return createdServices;
    } catch (error) {
      console.error('❌ Failed to import local servers from config:', error);
      throw error;
    }
  }

  /**
   * Get sample configuration
   */
  getSampleConfig(): string {
    const sampleManifest = this.configManager.generateSampleManifest();
    return this.configManager.manifestToJson(sampleManifest);
  }

  /**
   * Start a local MCP server
   */
  async startLocalServer(serviceId: string): Promise<void> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      throw new Error('Service not found');
    }
    
    if (service.type !== 'local-mcp') {
      throw new Error('Service is not a local MCP server');
    }
    
    // The MCP client manager will handle starting the server when needed
    await this.mcpClient.discoverTools(service);
  }

  /**
   * Stop a local MCP server
   */
  async stopLocalServer(serviceId: string): Promise<void> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      throw new Error('Service not found');
    }
    
    if (service.type !== 'local-mcp') {
      throw new Error('Service is not a local MCP server');
    }
    
    // Get the local server manager from the MCP client manager
    const localManager = (this.mcpClient as any).localServerManager;
    if (localManager) {
      await localManager.stopLocalServer(serviceId);
    }
  }

  /**
   * Get local MCP server status
   */
  async getLocalServerStatus(serviceId: string): Promise<any> {
    const service = await this.db.getService(serviceId);
    if (!service) {
      throw new Error('Service not found');
    }
    
    if (service.type !== 'local-mcp') {
      throw new Error('Service is not a local MCP server');
    }
    
    // Get the local server manager from the MCP client manager
    const localManager = (this.mcpClient as any).localServerManager;
    if (localManager) {
      const processRecord = localManager.getLocalServer(serviceId);
      if (processRecord) {
        return {
          isRunning: processRecord.isRunning,
          startTime: processRecord.startTime,
          lastActivity: processRecord.lastActivity,
          capabilities: processRecord.capabilities
        };
      }
    }
    
    return {
      isRunning: false,
      startTime: null,
      lastActivity: null,
      capabilities: null
    };
  }
}
