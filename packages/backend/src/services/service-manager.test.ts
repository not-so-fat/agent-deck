import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ServiceManager } from './service-manager';
import { DatabaseManager } from '../models/database';
import { MCPClientManager } from './mcp-client-manager';
import { OAuthManager } from './oauth-manager';
import { CreateServiceInput, ServiceCallInput } from '@agent-deck/shared';
import { FileStoreWriter } from '../store/writer';

// Mock the managers
vi.mock('../models/database');
vi.mock('./mcp-client-manager');
vi.mock('./oauth-manager');

describe('ServiceManager', () => {
  let serviceManager: ServiceManager;
  let mockDbManager: any;
  let mockMCPClientManager: any;
  let mockOAuthManager: any;
  let mockStoreWriter: FileStoreWriter;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Create mock instances
    mockDbManager = {
      createService: vi.fn(),
      getService: vi.fn(),
      getAllServices: vi.fn().mockResolvedValue([]),
      updateService: vi.fn(),
      deleteService: vi.fn(),
      updateServiceStatus: vi.fn().mockResolvedValue(undefined),
      getPlaybooksDependingOnService: vi.fn().mockResolvedValue([]),
    };

    mockMCPClientManager = {
      discoverTools: vi.fn(),
      callTool: vi.fn(),
      invalidateClient: vi.fn(),
    };

    mockOAuthManager = {
      discoverOAuth: vi.fn(),
      initiateOAuthFlow: vi.fn(),
      handleOAuthCallback: vi.fn(),
      refreshOAuthToken: vi.fn(),
    };
    mockStoreWriter = {
      writeService: vi.fn(),
      deleteService: vi.fn(),
      touchHash: vi.fn(),
    } as unknown as FileStoreWriter;

    // Mock the constructors
    vi.mocked(DatabaseManager).mockImplementation(() => mockDbManager);
    vi.mocked(MCPClientManager).mockImplementation(() => mockMCPClientManager);
    vi.mocked(OAuthManager).mockImplementation(() => mockOAuthManager);

    serviceManager = new ServiceManager(
      mockDbManager,
      mockMCPClientManager,
      mockOAuthManager,
      {
        set: vi.fn(),
        get: vi.fn(),
        has: vi.fn(),
        delete: vi.fn(),
      } as unknown as import('../vault/oauth-client-secret-vault').OAuthClientSecretVault,
      undefined,
      mockStoreWriter,
    );
  });

  describe('Service CRUD Operations', () => {
    it('should create a service', async () => {
      const serviceInput: CreateServiceInput = {
        name: 'Test Service',
        type: 'mcp',
        url: 'https://example.com',
        description: 'A test service',
        cardColor: '#ff0000',
      };

      const expectedService = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        ...serviceInput,
        health: 'unknown',
        isConnected: false,
        registeredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      mockDbManager.createService.mockResolvedValue(expectedService);
      mockOAuthManager.discoverOAuth.mockResolvedValue({ hasOAuth: false });

      const result = await serviceManager.createService(serviceInput);

      expect(mockDbManager.createService).toHaveBeenCalledWith(serviceInput);
      expect(result).toEqual(expectedService);
    });

    it('should get a service by ID', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const expectedService = {
        id: serviceId,
        name: 'Test Service',
        type: 'mcp',
        url: 'https://example.com',
      };

      mockDbManager.getService.mockResolvedValue(expectedService);

      const result = await serviceManager.getService(serviceId);

      expect(mockDbManager.getService).toHaveBeenCalledWith(serviceId);
      expect(result).toEqual(expectedService);
    });

    it('should get all services', async () => {
      const expectedServices = [
        {
          id: '123e4567-e89b-12d3-a456-426614174001',
          name: 'Service 1',
          type: 'mcp',
          url: 'https://service1.com',
          iconUrl: '/api/services/123e4567-e89b-12d3-a456-426614174001/icon',
        },
        {
          id: '123e4567-e89b-12d3-a456-426614174002',
          name: 'Service 2',
          type: 'a2a',
          url: 'https://service2.com',
          iconUrl: '/api/services/123e4567-e89b-12d3-a456-426614174002/icon',
        },
      ];

      mockDbManager.getAllServices.mockResolvedValue(expectedServices);

      const result = await serviceManager.getAllServices();

      expect(mockDbManager.getAllServices).toHaveBeenCalled();
      expect(result).toEqual(expectedServices);
    });

    it('backfills icons for remote services missing iconUrl', async () => {
      const service = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        name: 'Linear',
        type: 'mcp',
        url: 'https://mcp.linear.app/mcp',
      };
      const withIcon = {
        ...service,
        iconUrl: '/api/services/123e4567-e89b-12d3-a456-426614174001/icon',
      };

      mockDbManager.getAllServices.mockResolvedValue([service]);
      const refreshSpy = vi
        .spyOn(serviceManager, 'refreshServiceIcon')
        .mockResolvedValue(withIcon);

      const result = await serviceManager.getAllServices();

      expect(refreshSpy).toHaveBeenCalledWith(service.id);
      expect(result).toEqual([withIcon]);
    });

    it('should update a service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const updateInput = {
        name: 'Updated Service',
        description: 'Updated description',
      };

      const expectedService = {
        id: serviceId,
        ...updateInput,
        type: 'mcp',
        url: 'https://example.com',
      };

      mockDbManager.updateService.mockResolvedValue(expectedService);

      const result = await serviceManager.updateService(serviceId, updateInput);

      expect(mockDbManager.updateService).toHaveBeenCalledWith(serviceId, updateInput);
      expect(result).toEqual(expectedService);
    });

    it('should delete a service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      mockDbManager.getService.mockResolvedValue({
        id: serviceId,
        name: 'Test Service',
        type: 'mcp',
        url: 'https://example.com',
      });
      mockDbManager.deleteService.mockResolvedValue(true);

      const result = await serviceManager.deleteService(serviceId);

      expect(mockDbManager.deleteService).toHaveBeenCalledWith(serviceId);
      expect(result).toBe(true);
    });
  });

  describe('Service Discovery', () => {
    it('should discover tools for MCP service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Test Service',
        type: 'mcp',
        url: 'https://example.com',
      };

      const expectedTools = [
        {
          name: 'testTool',
          description: 'A test tool',
          inputSchema: { type: 'object' },
          enabled: true,
        },
      ];

      mockDbManager.getService.mockResolvedValue(service);
      mockMCPClientManager.discoverTools.mockResolvedValue([
        {
          name: 'testTool',
          description: 'A test tool',
          inputSchema: { type: 'object' },
        },
      ]);

      const result = await serviceManager.discoverServiceTools(serviceId);

      expect(mockDbManager.getService).toHaveBeenCalledWith(serviceId);
      expect(mockMCPClientManager.discoverTools).toHaveBeenCalledWith({ ...service, headers: {} });
      expect(result).toEqual(expectedTools);
    });

    it('invalidates cached MCP client when discovery fails', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Test Service',
        type: 'mcp',
        url: 'https://example.com',
      };

      mockDbManager.getService.mockResolvedValue(service);
      mockMCPClientManager.discoverTools.mockRejectedValue(new Error('Connection failed'));
      mockDbManager.updateServiceStatus.mockResolvedValue(true);

      const result = await serviceManager.discoverServiceTools(serviceId);

      expect(mockMCPClientManager.invalidateClient).toHaveBeenCalledWith(serviceId);
      expect(mockDbManager.updateServiceStatus).toHaveBeenCalledWith(serviceId, false, 'unhealthy');
      expect(result).toEqual({ success: false, error: 'Connection failed' });
    });

    it('should discover tools for A2A service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Test Service',
        type: 'a2a',
        url: 'https://example.com',
      };

      const expectedTools = [
        {
          name: 'testTool',
          description: 'A test tool',
          inputSchema: { type: 'object' },
          enabled: true,
        },
      ];

      mockDbManager.getService.mockResolvedValue(service);
      // Mock fetch for A2A manifest
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ endpoints: { testTool: { description: 'A test tool', inputSchema: { type: 'object' } } } }),
      });

      const result = await serviceManager.discoverServiceTools(serviceId);

      expect(mockDbManager.getService).toHaveBeenCalledWith(serviceId);
      expect(result).toEqual(expectedTools);
    });

    it('should return error for non-existent service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      mockDbManager.getService.mockResolvedValue(null);

      const result = await serviceManager.discoverServiceTools(serviceId);

      expect(result).toEqual({
        success: false,
        error: 'Service not found',
      });
    });
  });

  describe('Service Call', () => {
    it('should call tool for MCP service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Test Service',
        type: 'mcp',
        url: 'https://example.com',
      };

      const callInput: ServiceCallInput = {
        serviceId,
        toolName: 'testTool',
        arguments: { param1: 'value1' },
      };

      const expectedResult = {
        success: true,
        result: { result: 'success' },
      };

      mockDbManager.getService.mockResolvedValue(service);
      mockMCPClientManager.callTool.mockResolvedValue({ result: 'success' });

      const result = await serviceManager.callServiceTool(callInput);

      expect(mockDbManager.getService).toHaveBeenCalledWith(serviceId);
      expect(mockMCPClientManager.callTool).toHaveBeenCalledWith(
        { ...service, headers: {} },
        callInput.toolName,
        callInput.arguments
      );
      expect(result).toEqual(expectedResult);
    });

    it('should call tool for A2A service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Test Service',
        type: 'a2a',
        url: 'https://example.com',
      };

      const callInput: ServiceCallInput = {
        serviceId,
        toolName: 'testTool',
        arguments: { param1: 'value1' },
      };

      const expectedResult = {
        success: true,
        result: { result: 'success' },
      };

      mockDbManager.getService.mockResolvedValue(service);
      // Mock fetch for A2A tool call
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ result: 'success' }),
      });

      const result = await serviceManager.callServiceTool(callInput);

      expect(mockDbManager.getService).toHaveBeenCalledWith(serviceId);
      expect(result).toEqual(expectedResult);
    });

    it('should return error for non-existent service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const callInput: ServiceCallInput = {
        serviceId,
        toolName: 'testTool',
        arguments: {},
      };

      mockDbManager.getService.mockResolvedValue(null);

      const result = await serviceManager.callServiceTool(callInput);

      expect(result).toEqual({
        success: false,
        error: 'Service not found',
      });
    });

    it('should return error for unsupported service type', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Test Service',
        type: 'unsupported' as any,
        url: 'https://example.com',
      };

      const callInput: ServiceCallInput = {
        serviceId,
        toolName: 'testTool',
        arguments: {},
      };

      mockDbManager.getService.mockResolvedValue(service);

      const result = await serviceManager.callServiceTool(callInput);

      expect(result).toEqual({
        success: false,
        error: 'Unsupported service type: unsupported',
      });
    });

    it('should surface in-band Slack file_not_found with Connect hint', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Slack',
        type: 'mcp',
        url: 'https://mcp.slack.com/mcp',
      };

      const callInput: ServiceCallInput = {
        serviceId,
        toolName: 'slack_read_file',
        arguments: { file_id: 'F123' },
      };

      mockDbManager.getService.mockResolvedValue(service);
      mockMCPClientManager.callTool.mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'execution_failed: file_not_found' }],
      });

      const result = await serviceManager.callServiceTool(callInput);

      expect(result.success).toBe(false);
      expect(result.error_code).toBe('MCP_TOOL_ERROR');
      expect(result.error).toBe('file_not_found');
      expect(result.details?.hint).toMatch(/Slack Connect/i);
      expect(mockMCPClientManager.invalidateClient).not.toHaveBeenCalled();
      expect(mockDbManager.updateServiceStatus).not.toHaveBeenCalled();
    });

    it('should propagate MCP tool errors with structured details', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Docmost',
        type: 'mcp',
        url: 'https://docmost.example.com/mcp',
      };

      const callInput: ServiceCallInput = {
        serviceId,
        toolName: 'get_page',
        arguments: {},
      };

      mockDbManager.getService.mockResolvedValue(service);
      mockMCPClientManager.callTool.mockRejectedValue(
        new Error('Failed to connect to MCP service: SSE error: Invalid content type, expected "text/event-stream"'),
      );

      const result = await serviceManager.callServiceTool(callInput);

      expect(mockMCPClientManager.invalidateClient).toHaveBeenCalledWith(serviceId);
      expect(mockDbManager.updateServiceStatus).toHaveBeenCalledWith(serviceId, false, 'unhealthy');
      expect(result).toEqual({
        success: false,
        error: 'Failed to call tool',
        error_code: 'MCP_TRANSPORT_ERROR',
        details: {
          service_id: serviceId,
          service_name: 'Docmost',
          remote_url: 'https://docmost.example.com/mcp',
          tool_name: 'get_page',
          cause: 'Failed to connect to MCP service: SSE error: Invalid content type, expected "text/event-stream"',
          phase: 'callTool',
        },
        serviceName: 'Docmost',
        toolName: 'get_page',
      });
    });
  });

  describe('Service Health Check', () => {
    it('should check health for MCP service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Test Service',
        type: 'mcp',
        url: 'https://example.com',
      };

      const expectedHealth = {
        success: true,
        health: 'healthy',
        isConnected: true,
      };

      mockDbManager.getService.mockResolvedValue(service);
      mockMCPClientManager.discoverTools.mockResolvedValue([]);
      mockDbManager.updateServiceStatus.mockResolvedValue(true);

      const result = await serviceManager.checkServiceHealth(serviceId);

      expect(mockDbManager.getService).toHaveBeenCalledWith(serviceId);
      expect(mockMCPClientManager.discoverTools).toHaveBeenCalledWith({ ...service, headers: {} });
      expect(mockDbManager.updateServiceStatus).toHaveBeenCalledWith(serviceId, true, 'healthy');
      expect(result).toEqual(expectedHealth);
    });

    it('should check health for A2A service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Test Service',
        type: 'a2a',
        url: 'https://example.com',
      };

      const expectedHealth = {
        success: true,
        health: 'healthy',
        isConnected: true,
      };

      mockDbManager.getService.mockResolvedValue(service);
      mockDbManager.updateServiceStatus.mockResolvedValue(true);
      // Mock fetch for A2A manifest
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ endpoints: {} }),
      });

      const result = await serviceManager.checkServiceHealth(serviceId);

      expect(mockDbManager.getService).toHaveBeenCalledWith(serviceId);
      expect(mockDbManager.updateServiceStatus).toHaveBeenCalledWith(serviceId, true, 'healthy');
      expect(result).toEqual(expectedHealth);
    });

    it('should return error for non-existent service', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      mockDbManager.getService.mockResolvedValue(null);

      const result = await serviceManager.checkServiceHealth(serviceId);

      expect(result).toEqual({
        success: false,
        error: 'Service not found',
      });
    });

    it('should handle service discovery failure', async () => {
      const serviceId = '123e4567-e89b-12d3-a456-426614174000';
      const service = {
        id: serviceId,
        name: 'Test Service',
        type: 'mcp',
        url: 'https://example.com',
      };

      mockDbManager.getService.mockResolvedValue(service);
      mockMCPClientManager.discoverTools.mockRejectedValue(new Error('Connection failed'));
      mockDbManager.updateServiceStatus.mockResolvedValue(true);

      const result = await serviceManager.checkServiceHealth(serviceId);

      expect(mockDbManager.updateServiceStatus).toHaveBeenCalledWith(serviceId, false, 'unhealthy');
      expect(result).toEqual({
        success: true,
        health: 'unhealthy',
        isConnected: false,
      });
    });
  });
});
