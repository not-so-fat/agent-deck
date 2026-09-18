#!/usr/bin/env node
/**
 * Trusted MCP launcher — reads the folder assignment and connects with launch headers.
 * Referenced from project MCP config instead of embedding deck ids in tracked files.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  AGENT_DECK_DECK_ID_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
} from '@agent-deck/shared';
import { buildMcpUrl, type McpEndpoint } from './mcp-config';
import { clearKeychainAssignment, readAssignment, writeAssignment } from './assignment';
import { McpStdioHttpBridge } from './mcp-bridge';

export type McpLaunchPlan = {
  workspaceRoot: string;
  mcpUrl: string;
  deckId?: string;
  deckName?: string;
  headers: string[];
  /** True when the folder has no assignment — connect without a deck header (NOT-50). */
  unassigned?: boolean;
};

export type McpBridgeKind = 'builtin' | 'supergateway';

/**
 * The built-in bridge re-initializes when the MCP server restarts (NOT-101);
 * supergateway does not, and stays wedged until it is killed by hand. Keep it
 * reachable as an escape hatch, but never as the default.
 */
export function resolveBridgeKind(value = process.env.AGENT_DECK_MCP_BRIDGE): McpBridgeKind {
  return value?.trim().toLowerCase() === 'supergateway' ? 'supergateway' : 'builtin';
}

/** `Name: value` launch headers → the header map the bridge sends on every request. */
export function parseLaunchHeaders(headers: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const header of headers) {
    const separator = header.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const name = header.slice(0, separator).trim();
    const value = header.slice(separator + 1).trim();
    if (name && value) {
      parsed[name] = value;
    }
  }
  return parsed;
}

export const NO_ASSIGNMENT_MESSAGE =
  '[agent-deck] No deck assigned — run `agent-deck use <deck>` in this folder.';

/** Resolve launch headers from the folder assignment (migrating v2/Keychain → v3). */
export async function resolveMcpLaunchPlan(
  workspaceRoot = path.resolve(process.env.AGENT_DECK_WORKSPACE?.trim() || process.cwd()),
  endpoint: McpEndpoint = {
    host: process.env.AGENT_DECK_HOST ?? '127.0.0.1',
    mcpPort: Number(process.env.AGENT_DECK_MCP_PORT ?? '1110'),
  },
): Promise<McpLaunchPlan> {
  const assignment = await readAssignment(workspaceRoot);
  if (!assignment) {
    return {
      workspaceRoot,
      mcpUrl: buildMcpUrl(endpoint),
      headers: [`${AGENT_DECK_WORKSPACE_HEADER}: ${workspaceRoot}`],
      unassigned: true,
    };
  }

  if (assignment.needsMigration) {
    await writeAssignment(workspaceRoot, {
      deckId: assignment.deckId,
      deckName: assignment.deckName,
      ...(assignment.mcpUrl ? { mcpUrl: assignment.mcpUrl } : {}),
    });
    if (assignment.source === 'keychain') {
      await clearKeychainAssignment(workspaceRoot);
    }
  }

  const mcpUrl = assignment.mcpUrl ?? buildMcpUrl(endpoint);
  return {
    workspaceRoot,
    mcpUrl,
    deckId: assignment.deckId,
    deckName: assignment.deckName,
    headers: [
      `${AGENT_DECK_DECK_ID_HEADER}: ${assignment.deckId}`,
      `${AGENT_DECK_WORKSPACE_HEADER}: ${workspaceRoot}`,
    ],
  };
}

export async function runMcpLaunch(): Promise<number> {
  const workspaceRoot = path.resolve(process.env.AGENT_DECK_WORKSPACE?.trim() || process.cwd());
  const host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  const mcpPort = Number(process.env.AGENT_DECK_MCP_PORT ?? '1110');
  const endpoint: McpEndpoint = { host, mcpPort };

  const plan = await resolveMcpLaunchPlan(workspaceRoot, endpoint);
  if (plan.unassigned) {
    console.error(NO_ASSIGNMENT_MESSAGE);
  }

  if (resolveBridgeKind() === 'builtin') {
    const bridge = new McpStdioHttpBridge({
      url: plan.mcpUrl,
      headers: parseLaunchHeaders(plan.headers),
      // An elevated `switch_bound_deck` rewrites the folder assignment while we
      // are connected, and `agent-deck use` can point it at another endpoint.
      // Re-reading it before a replayed handshake is what keeps a restart from
      // reconnecting to the deck and server this process started on.
      resolveTarget: async () => {
        const current = await resolveMcpLaunchPlan(workspaceRoot, endpoint);
        return { url: current.mcpUrl, headers: parseLaunchHeaders(current.headers) };
      },
      stdin: process.stdin,
      stdout: process.stdout,
    });
    await bridge.run();
    return 0;
  }

  const headerArgs = plan.headers.flatMap((header) => ['--header', header]);
  const supergatewayArgs = [
    '-y',
    'supergateway',
    '--streamableHttp',
    plan.mcpUrl,
    ...headerArgs,
  ];

  return await new Promise<number>((resolve) => {
    const child = spawn('npx', supergatewayArgs, {
      stdio: 'inherit',
      cwd: workspaceRoot,
      env: {
        ...process.env,
        AGENT_DECK_WORKSPACE: workspaceRoot,
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
