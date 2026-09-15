import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs/promises';
import { getServiceIconPath } from '../services/icon-resolver';
import { 
  CreateServiceInput, 
  UpdateServiceInput,
  ServiceCallInput,
  ApiResponse,
  Service,
  ServiceTool,
  UpdateServiceToolSettingsSchema,
} from '@agent-deck/shared';
import {
  isDashboardClient,
  requireDashboardClient,
  sanitizeServiceForAgent,
  DashboardOnlyError,
} from '../lib/client-scope';
import {
  boundDeckScopeResponse,
  requireServiceOnBoundDeck,
} from '../lib/bound-deck-scope';
import {
  requireDashboard,
  RoutePolicyError,
  sendRoutePolicyError,
} from '../lib/route-policy';
import { resolveAgentDeckId } from '../lib/agent-deck-context';

let lastBackgroundHealthProbeAt = 0;
const BACKGROUND_HEALTH_PROBE_COOLDOWN_MS = 30_000;

interface CreateServiceRequest {
  Body: CreateServiceInput;
}

interface UpdateServiceRequest {
  Params: { id: string };
  Body: UpdateServiceInput;
}

interface ServiceCallRequest {
  Params: { id: string };
  Body: { toolName: string; arguments: any };
}

interface ServiceIdRequest {
  Params: { id: string };
}

function mimeFromIconBuffer(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00) {
    return 'image/x-icon';
  }
  return 'application/octet-stream';
}

export async function registerServiceRoutes(fastify: FastifyInstance) {
  // Create service
  fastify.post<CreateServiceRequest>('/', async (request, reply) => {
    try {
      requireDashboard(request);
      const service = await fastify.serviceManager.createService(request.body);

      const response: ApiResponse<Service> = {
        success: true,
        // createService now merges vault secret headers — strip them for agents.
        data: isDashboardClient(request) ? service : sanitizeServiceForAgent(service),
      };

      return reply.status(201).send(response);
    } catch (error) {
      if (error instanceof RoutePolicyError) {
        return sendRoutePolicyError(reply, error);
      }
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      
      return reply.status(400).send(response);
    }
  });

  // Get all services
  fastify.get('/', async (request, reply) => {
    try {
      const dashboard = isDashboardClient(request);

      if (!dashboard) {
        const deckId = await resolveAgentDeckId(request, fastify.db);
        const deck = await fastify.db.getDeck(deckId);
        const services = deck?.services ?? [];
        return reply.send({
          success: true,
          data: services.map(sanitizeServiceForAgent),
        } satisfies ApiResponse<Service[]>);
      }

      const services = await fastify.serviceManager.getAllServices();

      if (dashboard) {
        const now = Date.now();
        if (now - lastBackgroundHealthProbeAt >= BACKGROUND_HEALTH_PROBE_COOLDOWN_MS) {
          lastBackgroundHealthProbeAt = now;
          void fastify.serviceManager.refreshUnknownServiceHealth((update) => {
            fastify.broadcastServiceUpdate(update);
          });
        }
      }

      const response: ApiResponse<Service[]> = {
        success: true,
        // Secret headers (from the vault) are merged on read — strip them for agents.
        data: dashboard ? services : services.map(sanitizeServiceForAgent),
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

  // Cached service icon (must be registered before /:id)
  fastify.get<ServiceIdRequest>('/:id/icon', async (request, reply) => {
    const serviceId = request.params.id;
    const iconPath = getServiceIconPath(serviceId);

    const sendIcon = async (): Promise<boolean> => {
      try {
        const buffer = await fs.readFile(iconPath);
        await reply.type(mimeFromIconBuffer(buffer)).send(buffer);
        return true;
      } catch {
        return false;
      }
    };

    if (await sendIcon()) {
      return;
    }

    const service = await fastify.db.getService(serviceId);
    if (service && service.type !== 'local-mcp' && !service.url.startsWith('local://')) {
      await fastify.serviceManager.refreshServiceIcon(serviceId);
      if (await sendIcon()) {
        return;
      }
    }

    return reply.status(404).send({
      success: false,
      error: 'Icon not found',
    });
  });

  // Refresh favicon for a service
  fastify.post<ServiceIdRequest>('/:id/refresh-icon', async (request, reply) => {
    try {
      const service = await fastify.serviceManager.refreshServiceIcon(request.params.id);

      if (!service) {
        const response: ApiResponse = {
          success: false,
          error: 'Service not found',
        };
        return reply.status(404).send(response);
      }

      const response: ApiResponse<Service> = {
        success: true,
        // refreshServiceIcon merges vault secret headers — strip them for agents.
        data: isDashboardClient(request) ? service : sanitizeServiceForAgent(service),
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

  // Get service by ID
  fastify.get<ServiceIdRequest>('/:id', async (request, reply) => {
    try {
      if (!isDashboardClient(request)) {
        await requireServiceOnBoundDeck(request, fastify.db, request.params.id);
      }

      const service = await fastify.serviceManager.getService(request.params.id);
      
      if (!service) {
        const response: ApiResponse = {
          success: false,
          error: 'Service not found',
        };
        
        return reply.status(404).send(response);
      }
      
      const response: ApiResponse<Service> = {
        success: true,
        // Secret headers (from the vault) are merged on read — strip them for agents.
        data: isDashboardClient(request) ? service : sanitizeServiceForAgent(service),
      };

      return reply.send(response);
    } catch (error) {
      const scoped = boundDeckScopeResponse(error);
      if (scoped.error_code) {
        return reply.status(scoped.status).send({
          success: false,
          error: scoped.message,
          error_code: scoped.error_code,
        } satisfies ApiResponse);
      }
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };

      return reply.status(scoped.status).send(response);
    }
  });

  // Update service
  fastify.put<UpdateServiceRequest>('/:id', async (request, reply) => {
    try {
      requireDashboard(request);
      const service = await fastify.serviceManager.updateService(request.params.id, request.body);
      
      if (!service) {
        const response: ApiResponse = {
          success: false,
          error: 'Service not found',
        };
        
        return reply.status(404).send(response);
      }
      
      const response: ApiResponse<Service> = {
        success: true,
        // getService/updateService merge vault secret headers — strip for agents.
        data: isDashboardClient(request) ? service : sanitizeServiceForAgent(service),
      };

      return reply.send(response);
    } catch (error) {
      if (error instanceof RoutePolicyError) {
        return sendRoutePolicyError(reply, error);
      }
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };

      return reply.status(400).send(response);
    }
  });

  // Delete service
  fastify.delete<ServiceIdRequest>('/:id', async (request, reply) => {
    try {
      requireDashboard(request);
      const deleted = await fastify.serviceManager.deleteService(request.params.id);
      
      if (!deleted) {
        const response: ApiResponse = {
          success: false,
          error: 'Service not found',
        };
        
        return reply.status(404).send(response);
      }
      
      const response: ApiResponse = {
        success: true,
        message: 'Service deleted successfully',
      };
      
      return reply.send(response);
    } catch (error) {
      if (error instanceof Error && error.name === 'PlaybookDependencyError') {
        const dependencyError = error as import('../playbooks/playbook-manager').PlaybookDependencyError;
        return reply.status(409).send({
          success: false,
          error: dependencyError.message,
          data: dependencyError.dependents,
        } satisfies ApiResponse);
      }
      const response: ApiResponse = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      
      return reply.status(500).send(response);
    }
  });

  // Discover service tools
  fastify.get<ServiceIdRequest>('/:id/tools', async (request, reply) => {
    try {
      if (!isDashboardClient(request)) {
        await requireServiceOnBoundDeck(request, fastify.db, request.params.id);
      }

      const forAgent = !isDashboardClient(request);
      const tools = await fastify.serviceManager.discoverServiceTools(request.params.id, {
        forAgent,
      });
      
      if ('success' in tools && !tools.success) {
        return reply.status(400).send({
          success: false,
          error: tools.error,
        });
      }

      const response: ApiResponse<ServiceTool[]> = {
        success: true,
        data: tools as ServiceTool[],
      };
      
      return reply.send(response);
    } catch (error) {
      const scoped = boundDeckScopeResponse(error);
      return reply.status(scoped.status).send({
        success: false,
        error: scoped.message,
        error_code: scoped.error_code,
      } satisfies ApiResponse);
    }
  });

  fastify.put<ServiceIdRequest>('/:id/tool-settings', async (request, reply) => {
    try {
      requireDashboardClient(request);

      const input = UpdateServiceToolSettingsSchema.parse(request.body);
      const service = await fastify.serviceManager.updateToolSettings(request.params.id, input);

      if (!service) {
        return reply.status(404).send({
          success: false,
          error: 'Service not found',
        } satisfies ApiResponse);
      }

      return reply.send({
        success: true,
        data: service,
      } satisfies ApiResponse<Service>);
    } catch (error) {
      if (error instanceof DashboardOnlyError) {
        return reply.status(403).send({
          success: false,
          error: error.message,
        } satisfies ApiResponse);
      }
      const scoped = boundDeckScopeResponse(error);
      return reply.status(scoped.status).send({
        success: false,
        error: scoped.message,
      } satisfies ApiResponse);
    }
  });

  // Call service tool
  fastify.post<ServiceCallRequest>('/:id/call', async (request, reply) => {
    try {
      await requireServiceOnBoundDeck(request, fastify.db, request.params.id);

      const result = await fastify.serviceManager.callServiceTool({
        serviceId: request.params.id,
        toolName: request.body.toolName,
        arguments: request.body.arguments,
      });
      
      const response: ApiResponse = {
        success: result.success,
        data: result.result,
        error: result.error,
        error_code: result.error_code,
        details: result.details,
      };
      
      return reply.send(response);
    } catch (error) {
      const scoped = boundDeckScopeResponse(error);
      return reply.status(scoped.status).send({
        success: false,
        error: scoped.message,
        error_code: scoped.error_code,
      } satisfies ApiResponse);
    }
  });

  // Check service health
  fastify.get<ServiceIdRequest>('/:id/health', async (request, reply) => {
    try {
      const health = await fastify.serviceManager.checkServiceHealth(request.params.id);
      
      const response: ApiResponse = {
        success: true,
        data: health,
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
