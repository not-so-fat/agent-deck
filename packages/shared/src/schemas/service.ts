import { z } from 'zod';

export const ServiceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1, 'Name is required'),
  type: z.enum(['mcp', 'a2a', 'local-mcp']),
  url: z.string().url('Valid URL is required'),
  health: z.enum(['unknown', 'healthy', 'unhealthy']).default('unknown'),
  description: z.string().optional(),
  cardColor: z.string().regex(/^#[0-9A-F]{6}$/i, 'Valid hex color required').default('#92E4DD'),
  iconUrl: z.string().optional(),
  disabledToolNames: z.array(z.string()).default([]),
  isConnected: z.boolean().default(false),
  lastPing: z.string().datetime().optional(),
  registeredAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  headers: z.record(z.string()).optional(),
  credentialId: z.string().optional(),
  
  // OAuth fields
  oauthClientId: z.string().optional(),
  oauthClientSecret: z.string().optional(),
  oauthAuthorizationUrl: z.string().url().optional(),
  oauthTokenUrl: z.string().url().optional(),
  oauthRedirectUri: z.string().url().optional(),
  oauthScope: z.string().optional(),
  oauthAccessToken: z.string().optional(),
  oauthRefreshToken: z.string().optional(),
  oauthTokenExpiresAt: z.string().datetime().optional(),
  oauthHasToken: z.boolean().optional(),
  oauthRefreshRejected: z.boolean().optional(),
  oauthState: z.string().optional(),
  
  // Local MCP server fields
  localCommand: z.string().optional(),
  localArgs: z.array(z.string()).optional(),
  localWorkingDir: z.string().optional(),
  localEnv: z.record(z.string()).optional(),
});

export const CreateServiceSchema = ServiceSchema.omit({
  id: true,
  health: true,
  isConnected: true,
  lastPing: true,
  registeredAt: true,
  updatedAt: true,
  oauthAccessToken: true,
  oauthRefreshToken: true,
  oauthTokenExpiresAt: true,
  oauthRefreshRejected: true,
  oauthState: true,
  disabledToolNames: true,
});

export const UpdateServiceSchema = CreateServiceSchema.partial();

export const ServiceCallSchema = z.object({
  serviceId: z.string().uuid('Valid service ID required'),
  toolName: z.string().min(1, 'Tool name is required'),
  arguments: z.record(z.any()).optional(),
});

export const ServiceToolSchema = z.object({
  name: z.string().min(1, 'Tool name is required'),
  title: z.string().optional(),
  description: z.string().min(1, 'Tool description is required'),
  inputSchema: z.record(z.any()),
  enabled: z.boolean().optional(),
  /** NOT-669: MCP tool annotations as advertised by the service (readOnlyHint gates readonly workers). */
  annotations: z.record(z.any()).optional(),
});

export const UpdateServiceToolSettingsSchema = z.object({
  disabledTools: z.array(z.string()),
});

export const ServiceToolErrorDetailsSchema = z.object({
  service_id: z.string(),
  service_name: z.string(),
  remote_url: z.string(),
  tool_name: z.string().optional(),
  cause: z.string(),
  phase: z.enum(['connect', 'discoverTools', 'callTool']),
  hint: z.string().optional(),
});

export const ServiceCallResultSchema = z.object({
  success: z.boolean(),
  result: z.any().optional(),
  error: z.string().optional(),
  error_code: z.enum([
    'MCP_TRANSPORT_ERROR',
    'MCP_AUTH_ERROR',
    'MCP_TOOL_ERROR',
    'MCP_CONNECTION_ERROR',
  ]).optional(),
  details: ServiceToolErrorDetailsSchema.optional(),
  serviceName: z.string().optional(),
  toolName: z.string().optional(),
});

export type Service = z.infer<typeof ServiceSchema>;
export type CreateServiceInput = z.infer<typeof CreateServiceSchema>;
export type UpdateServiceInput = z.infer<typeof UpdateServiceSchema>;
export type ServiceCallInput = z.infer<typeof ServiceCallSchema>;
export type ServiceTool = z.infer<typeof ServiceToolSchema>;
export type UpdateServiceToolSettingsInput = z.infer<typeof UpdateServiceToolSettingsSchema>;
export type ServiceCallResult = z.infer<typeof ServiceCallResultSchema>;

// Local MCP server schemas
export const LocalMCPServerConfigSchema = z.object({
  command: z.string().min(1, 'Command is required'),
  args: z.array(z.string()).optional().default([]),
  workingDir: z.string().optional(),
  env: z.record(z.string()).optional(),
});

export const MCPServersManifestSchema = z.object({
  mcpServers: z.record(z.string(), LocalMCPServerConfigSchema),
});

export const LocalMCPServerProcessSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  process: z.any(), // Node.js ChildProcess
  isRunning: z.boolean(),
  startTime: z.date(),
  lastActivity: z.date(),
  capabilities: z.object({
    tools: z.array(ServiceToolSchema),
    resources: z.array(z.any()),
    prompts: z.array(z.string()),
  }).optional(),
});

export type LocalMCPServerConfig = z.infer<typeof LocalMCPServerConfigSchema>;
export type MCPServersManifest = z.infer<typeof MCPServersManifestSchema>;
export type LocalMCPServerProcess = z.infer<typeof LocalMCPServerProcessSchema>;
