import { MCPServersManifest, LocalMCPServerConfig } from '../schemas/service';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isServerConfig(value: unknown): value is LocalMCPServerConfig {
  return isRecord(value) && typeof value.command === 'string';
}

function isServersMap(value: unknown): value is Record<string, LocalMCPServerConfig> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return false;
  }
  return Object.values(value).every(isServerConfig);
}

/** Strip ``` / ```json fences when users paste from markdown docs. */
export function stripJsonMarkdownFences(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('```')) {
    return text;
  }
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
}

/**
 * Accept common local MCP config shapes and normalize to { mcpServers: { ... } }.
 *
 * Supported:
 * - Standard Claude/Cursor manifest: { "mcpServers": { "name": { "command", "args" } } }
 * - API import wrapper: { "config": { "mcpServers": { ... } } }
 * - Bare server: { "command": "npx", "args": [...], "name"?: "my-server" }
 * - Unwrapped map: { "google-drive": { "command": "npx", "args": [...] } }
 */
export function normalizeLocalMcpManifestInput(parsed: unknown): MCPServersManifest {
  if (!isRecord(parsed)) {
    throw new Error('Configuration must be a JSON object');
  }

  if (isRecord(parsed.config) && isServersMap(parsed.config.mcpServers)) {
    return { mcpServers: parsed.config.mcpServers };
  }

  if (isServersMap(parsed.mcpServers)) {
    return { mcpServers: parsed.mcpServers };
  }

  if (isRecord(parsed) && typeof parsed.command === 'string') {
    const name =
      typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'local-server';
    const { name: _ignored, ...serverConfig } = parsed;
    if (!isServerConfig(serverConfig)) {
      throw new Error('Missing or invalid command');
    }
    return { mcpServers: { [name]: serverConfig } };
  }

  if (isServersMap(parsed)) {
    return { mcpServers: parsed };
  }

  throw new Error(
    'Invalid configuration: expected a top-level "mcpServers" object. Example:\n' +
      '{\n' +
      '  "mcpServers": {\n' +
      '    "google-drive": {\n' +
      '      "command": "npx",\n' +
      '      "args": ["-y", "@piotr-agier/google-drive-mcp"]\n' +
      '    }\n' +
      '  }\n' +
      '}'
  );
}

export function parseLocalMcpManifestJson(raw: string): MCPServersManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonMarkdownFences(raw));
  } catch (error) {
    throw new Error(
      `Failed to parse JSON: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
  return normalizeLocalMcpManifestInput(parsed);
}
