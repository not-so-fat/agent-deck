#!/usr/bin/env node
/**
 * Trusted MCP launcher — reads the workspace grant and proxies MCP with Bearer auth.
 * Referenced from project MCP config instead of embedding deck ids in tracked files.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { buildMcpUrl, type McpEndpoint } from './mcp-config';
import { readWorkspaceGrant } from './grant-store';

export async function runMcpLaunch(): Promise<number> {
  const workspaceRoot = process.env.AGENT_DECK_WORKSPACE?.trim() || process.cwd();
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const mcpPort = Number(process.env.AGENT_DECK_MCP_PORT ?? '1110');
  const endpoint: McpEndpoint = { host, mcpPort };

  const grant = await readWorkspaceGrant(workspaceRoot);
  if (!grant) {
    console.error(
      '[agent-deck] GRANT_REQUIRED — run `agent-deck use <deck>` in this workspace first.',
    );
    return 1;
  }

  const mcpUrl = grant.mcpUrl ?? buildMcpUrl(endpoint);
  const supergatewayArgs = [
    '-y',
    'supergateway',
    '--streamableHttp',
    mcpUrl,
    '--header',
    `Authorization: Bearer ${grant.secret}`,
  ];

  return await new Promise<number>((resolve) => {
    const child = spawn('npx', supergatewayArgs, {
      stdio: 'inherit',
      cwd: workspaceRoot,
      env: {
        ...process.env,
        AGENT_DECK_WORKSPACE: path.resolve(workspaceRoot),
      },
    });

    child.on('exit', (code) => {
      resolve(code ?? 0);
    });
  });
}

async function main(): Promise<void> {
  const code = await runMcpLaunch();
  process.exit(code);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[agent-deck] MCP launcher failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
