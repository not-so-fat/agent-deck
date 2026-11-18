import { FastifyInstance } from 'fastify';
import { ApiResponse } from '@agent-deck/shared';

interface ImportConfigRequest {
  Body: {
    config: string;
  };
}

interface StartLocalServerRequest {
  Params: {
    serviceId: string;
  };
}

interface StopLocalServerRequest {
  Params: {
    serviceId: string;
  };
}

export async function registerLocalMCPRoutes(fastify: FastifyInstance) {
  // Import local MCP servers from JSON configuration
  fastify.post<ImportConfigRequest>('/import', async (request, reply) => {
    try {
      const { config } = request.body;
      
      if (!config) {
        return reply.status(400).send({
          success: false,
          error: 'Configuration JSON is required',
        } as ApiResponse);
      }

      const serviceManager = fastify.serviceManager;
      const services = await serviceManager.importLocalServersFromConfig(config);

      return {
        success: true,
        data: {
          imported: services.length,
          services: services,
        },
        message: `Successfully imported ${services.length} local MCP servers`,
      } as ApiResponse;
    } catch (error) {
      console.error('Failed to import local MCP servers:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to import local MCP servers',
      } as ApiResponse);
    }
  });

  // Get sample configuration
  fastify.get('/sample-config', async (request, reply) => {
    try {
      const serviceManager = fastify.serviceManager;
      const sampleConfig = serviceManager.getSampleConfig();

      return {
        success: true,
        data: {
          config: sampleConfig,
        },
      } as ApiResponse;
    } catch (error) {
      console.error('Failed to get sample config:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get sample configuration',
      } as ApiResponse);
    }
  });

  // Start a local MCP server
  fastify.post<StartLocalServerRequest>('/:serviceId/start', async (request, reply) => {
    try {
      const { serviceId } = request.params;
      
      const serviceManager = fastify.serviceManager;
      await serviceManager.startLocalServer(serviceId);

      return {
        success: true,
        message: `Local MCP server ${serviceId} started successfully`,
      } as ApiResponse;
    } catch (error) {
      console.error(`Failed to start local MCP server ${request.params.serviceId}:`, error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start local MCP server',
      } as ApiResponse);
    }
  });

  // Stop a local MCP server
  fastify.post<StopLocalServerRequest>('/:serviceId/stop', async (request, reply) => {
    try {
      const { serviceId } = request.params;
      
      const serviceManager = fastify.serviceManager;
      await serviceManager.stopLocalServer(serviceId);

      return {
        success: true,
        message: `Local MCP server ${serviceId} stopped successfully`,
      } as ApiResponse;
    } catch (error) {
      console.error(`Failed to stop local MCP server ${request.params.serviceId}:`, error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop local MCP server',
      } as ApiResponse);
    }
  });

  // Get local MCP server status
  fastify.get<{ Params: { serviceId: string } }>('/:serviceId/status', async (request, reply) => {
    try {
      const { serviceId } = request.params;
      
      const service = await fastify.serviceManager.getService(serviceId);
      if (!service) {
        return reply.status(404).send({
          success: false,
          error: 'Service not found',
        } as ApiResponse);
      }

      if (service.type !== 'local-mcp') {
        return reply.status(400).send({
          success: false,
          error: 'Service is not a local MCP server',
        } as ApiResponse);
      }

      // Get the local server manager from the MCP client manager
      const mcpClientManager = fastify.serviceManager.mcpClientManager;
      const localManager = (mcpClientManager as any).localServerManager;
      
      let isRunning = false;
      let processInfo = null;
      
      if (localManager) {
        isRunning = localManager.isLocalServerRunning(serviceId);
        const processRecord = localManager.getLocalServer(serviceId);
        if (processRecord) {
          processInfo = {
            id: processRecord.id,
            startTime: processRecord.startTime,
            lastActivity: processRecord.lastActivity,
            capabilities: processRecord.capabilities,
          };
        }
      }

      return {
        success: true,
        data: {
          serviceId,
          isRunning,
          processInfo,
        },
      } as ApiResponse;
    } catch (error) {
      console.error(`Failed to get local MCP server status ${request.params.serviceId}:`, error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get local MCP server status',
      } as ApiResponse);
    }
  });

  // List all local MCP servers
  fastify.get('/list', async (request, reply) => {
    try {
      const services = await fastify.serviceManager.getAllServices();
      const localServices = services.filter(s => s.type === 'local-mcp');

      // Get running status for each local service
      const mcpClientManager = fastify.serviceManager.mcpClientManager;
      const localManager = (mcpClientManager as any).localServerManager;
      
      const localServicesWithStatus = localServices.map(service => {
        let isRunning = false;
        let processInfo = null;
        
        if (localManager) {
          isRunning = localManager.isLocalServerRunning(service.id);
          const processRecord = localManager.getLocalServer(service.id);
          if (processRecord) {
            processInfo = {
              id: processRecord.id,
              startTime: processRecord.startTime,
              lastActivity: processRecord.lastActivity,
              capabilities: processRecord.capabilities,
            };
          }
        }
        
        return {
          ...service,
          isRunning,
          processInfo,
        };
      });

      return {
        success: true,
        data: {
          services: localServicesWithStatus,
          count: localServicesWithStatus.length,
        },
      } as ApiResponse;
    } catch (error) {
      console.error('Failed to list local MCP servers:', error);
      return reply.status(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list local MCP servers',
      } as ApiResponse);
    }
  });
}
