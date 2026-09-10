import fs from 'node:fs';
import path from 'node:path';

import {
  isLegacyBareHttpAgentDeckEntry,
  isMcpLaunchEntry,
  readCursorWorkspaceRoot,
  readJsonFile,
  resolveConfigPath,
  type McpEndpoint,
} from './mcp-config';

export type CursorMcpConfigSource = 'global' | 'project';

export type CursorMcpEntryShape = 'missing' | 'legacy-bare-url' | 'mcp-launch' | 'custom';

export type CursorMcpTransport = 'none' | 'stdio' | 'http' | 'unknown';

export type CursorMcpIssueCode =
  | 'missing'
  | 'bare-url'
  | 'mcp_auth_dead_end'
  | 'missing-workspace-pin'
  | 'stale-endpoint'
  | 'custom-entry'
  | 'grant-missing';

export interface CursorMcpIssue {
  code: CursorMcpIssueCode;
  message: string;
}

export interface CursorMcpEndpointSummary {
  host?: string;
  mcpPort?: string;
  url?: string;
}

export interface CursorMcpEntryReport {
  source: CursorMcpConfigSource;
  path: string;
  fileExists: boolean;
  shape: CursorMcpEntryShape;
  transport: CursorMcpTransport;
  endpoint: CursorMcpEndpointSummary;
  workspacePin: string | null;
  issues: CursorMcpIssue[];
}

export interface CursorMcpGrantSummary {
  checkedRoot: string;
  present: boolean;
  deckId?: string;
  deckName?: string;
  grantId?: string;
}

export interface CursorMcpInspection {
  cwd: string;
  expectedPrecedence: 'project-over-global';
  /** Which agent-deck entry Cursor would prefer when both define the server. */
  preferredSource: 'project' | 'global' | 'none';
  global: CursorMcpEntryReport;
  project: CursorMcpEntryReport;
  grant: CursorMcpGrantSummary;
  issues: CursorMcpIssue[];
}

function readAgentDeckEntry(configPath: string): {
  fileExists: boolean;
  entry: unknown;
} {
  if (!fs.existsSync(configPath)) {
    return { fileExists: false, entry: undefined };
  }
  const config = readJsonFile(configPath);
  const servers =
    config.mcpServers && typeof config.mcpServers === 'object'
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  return { fileExists: true, entry: servers['agent-deck'] };
}

function summarizeEndpoint(entry: unknown): CursorMcpEndpointSummary {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return {};
  }
  const record = entry as Record<string, unknown>;
  const summary: CursorMcpEndpointSummary = {};
  if (typeof record.url === 'string') {
    summary.url = record.url;
  }
  const env = record.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const envRecord = env as Record<string, unknown>;
    if (typeof envRecord.AGENT_DECK_HOST === 'string') {
      summary.host = envRecord.AGENT_DECK_HOST;
    }
    if (typeof envRecord.AGENT_DECK_MCP_PORT === 'string') {
      summary.mcpPort = envRecord.AGENT_DECK_MCP_PORT;
    }
  }
  return summary;
}

function classifyEntry(
  source: CursorMcpConfigSource,
  configPath: string,
  endpoint: McpEndpoint,
): CursorMcpEntryReport {
  const { fileExists, entry } = readAgentDeckEntry(configPath);
  if (entry === undefined) {
    return {
      source,
      path: configPath,
      fileExists,
      shape: 'missing',
      transport: 'none',
      endpoint: {},
      workspacePin: null,
      issues: [
        {
          code: 'missing',
          message: `No agent-deck entry in ${configPath}.`,
        },
      ],
    };
  }

  if (isLegacyBareHttpAgentDeckEntry(entry)) {
    return {
      source,
      path: configPath,
      fileExists,
      shape: 'legacy-bare-url',
      transport: 'http',
      endpoint: summarizeEndpoint(entry),
      workspacePin: null,
      issues: [
        {
          code: 'bare-url',
          message: `Legacy bare URL in ${configPath} has no workspace-grant launcher.`,
        },
        {
          code: 'mcp_auth_dead_end',
          message:
            'Bare HTTP MCP entries fail discovery/auth in Cursor and surface mcp_auth — that is not the Agent Deck workspace-grant flow. Run `agent-deck use <deck> --client cursor`.',
        },
      ],
    };
  }

  if (!isMcpLaunchEntry(entry)) {
    return {
      source,
      path: configPath,
      fileExists,
      shape: 'custom',
      transport: 'unknown',
      endpoint: summarizeEndpoint(entry),
      workspacePin: null,
      issues: [
        {
          code: 'custom-entry',
          message: `Custom agent-deck wrapper in ${configPath} is left unchanged; configure it to run \`agent-deck mcp-launch\` with AGENT_DECK_WORKSPACE.`,
        },
      ],
    };
  }

  const workspacePin = readCursorWorkspaceRoot(entry) ?? null;
  const endpointSummary = summarizeEndpoint(entry);
  const issues: CursorMcpIssue[] = [];
  if (!workspacePin) {
    issues.push({
      code: 'missing-workspace-pin',
      message: `mcp-launch in ${configPath} has no AGENT_DECK_WORKSPACE pin; Cursor may start the launcher outside the bound workspace.`,
    });
  }
  if (
    endpointSummary.host !== endpoint.host ||
    endpointSummary.mcpPort !== String(endpoint.mcpPort)
  ) {
    issues.push({
      code: 'stale-endpoint',
      message: `Configured endpoint ${endpointSummary.host ?? '?'}:${endpointSummary.mcpPort ?? '?'} does not match running Agent Deck ${endpoint.host}:${endpoint.mcpPort}.`,
    });
  }

  return {
    source,
    path: configPath,
    fileExists,
    shape: 'mcp-launch',
    transport: 'stdio',
    endpoint: endpointSummary,
    workspacePin,
    issues,
  };
}

/**
 * Read grant metadata from `.agent-deck/use.json` without returning secrets.
 * Keychain-only installs still keep non-secret fields in the file after activate.
 */
export function readGrantSummarySync(workspaceRoot: string): CursorMcpGrantSummary {
  const checkedRoot = path.resolve(workspaceRoot);
  const manifestPath = path.join(checkedRoot, '.agent-deck', 'use.json');
  if (!fs.existsSync(manifestPath)) {
    return { checkedRoot, present: false };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const deckId = typeof raw.deckId === 'string' ? raw.deckId : undefined;
    const deckName = typeof raw.deckName === 'string' ? raw.deckName : undefined;
    const grantId = typeof raw.grantId === 'string' ? raw.grantId : undefined;
    const present = Boolean(grantId || deckId);
    return {
      checkedRoot,
      present,
      ...(deckId ? { deckId } : {}),
      ...(deckName ? { deckName } : {}),
      ...(grantId ? { grantId } : {}),
    };
  } catch {
    return { checkedRoot, present: false };
  }
}

export function inspectCursorMcpConfig(options: {
  cwd?: string;
  endpoint: McpEndpoint;
}): CursorMcpInspection {
  const cwd = path.resolve(options.cwd ?? process.cwd());

  const globalPath = resolveConfigPath('cursor', 'global');
  const projectPath = resolveConfigPath('cursor', 'project', cwd);
  const global = classifyEntry('global', globalPath, options.endpoint);
  const project = classifyEntry('project', projectPath, options.endpoint);

  const preferredSource: CursorMcpInspection['preferredSource'] =
    project.shape !== 'missing' ? 'project' : global.shape !== 'missing' ? 'global' : 'none';

  const preferred = preferredSource === 'project' ? project : preferredSource === 'global' ? global : null;
  const grantRoot = preferred?.workspacePin ?? cwd;
  const grant = readGrantSummarySync(grantRoot);

  const issues: CursorMcpIssue[] = [...global.issues, ...project.issues];
  if (!grant.present) {
    issues.push({
      code: 'grant-missing',
      message: `No workspace grant at ${grant.checkedRoot} — run \`agent-deck use <deck>\`.`,
    });
  }

  return {
    cwd,
    expectedPrecedence: 'project-over-global',
    preferredSource,
    global,
    project,
    grant,
    issues,
  };
}

export function formatCursorMcpInspection(report: CursorMcpInspection): string {
  const lines: string[] = [
    'Cursor MCP inspection (read-only):',
    `  Expected precedence: project over global`,
    `  Preferred source: ${report.preferredSource}`,
    `  Global  ${report.global.path}`,
    `    shape=${report.global.shape} transport=${report.global.transport}` +
      (report.global.workspacePin ? ` pin=${report.global.workspacePin}` : ''),
    `  Project ${report.project.path}`,
    `    shape=${report.project.shape} transport=${report.project.transport}` +
      (report.project.workspacePin ? ` pin=${report.project.workspacePin}` : ''),
    `  Grant   ${report.grant.present ? 'present' : 'missing'} @ ${report.grant.checkedRoot}` +
      (report.grant.deckName || report.grant.deckId
        ? ` (${report.grant.deckName ?? report.grant.deckId})`
        : ''),
  ];

  const uniqueMessages = new Map<string, CursorMcpIssue>();
  for (const issue of report.issues) {
    uniqueMessages.set(`${issue.code}:${issue.message}`, issue);
  }
  if (uniqueMessages.size > 0) {
    lines.push('  Issues:');
    for (const issue of uniqueMessages.values()) {
      lines.push(`    - [${issue.code}] ${issue.message}`);
    }
  } else {
    lines.push('  Issues: none');
  }

  return lines.join('\n');
}
