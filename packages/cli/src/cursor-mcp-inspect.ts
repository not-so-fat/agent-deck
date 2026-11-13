import fs from 'node:fs';
import path from 'node:path';

import { canonicalFolder } from './host-connection';
import {
  CURSOR_MCP_RECOVERY_HINT,
  buildMcpUrl,
  isHttpAgentDeckEntry,
  isMcpLaunchEntry,
  readHttpWorkspaceHeader,
  readJsonFile,
  resolveConfigPath,
  type McpEndpoint,
} from './mcp-config';

export type CursorMcpConfigSource = 'global' | 'project';

export type CursorMcpEntryShape = 'missing' | 'http' | 'mcp-launch' | 'custom';

export type CursorMcpTransport = 'none' | 'stdio' | 'http' | 'unknown';

export type CursorMcpIssueCode =
  | 'missing'
  | 'missing-workspace-header'
  | 'missing-workspace-pin'
  | 'unresolved-workspace-pin'
  | 'stale-endpoint'
  | 'custom-entry'
  | 'assignment-missing';

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

export interface CursorMcpAssignmentSummary {
  checkedRoot: string;
  present: boolean;
  deckId?: string;
  deckName?: string;
}

export interface CursorMcpInspection {
  cwd: string;
  expectedPrecedence: 'project-over-global';
  /** Which agent-deck entry Cursor would prefer when both define the server. */
  preferredSource: 'project' | 'global' | 'none';
  global: CursorMcpEntryReport;
  project: CursorMcpEntryReport;
  assignment: CursorMcpAssignmentSummary;
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

function readRawWorkspacePin(entry: unknown): string | undefined {
  if (!isMcpLaunchEntry(entry)) {
    return undefined;
  }
  const env = (entry as Record<string, unknown>).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return undefined;
  }
  const workspaceRoot = (env as Record<string, unknown>).AGENT_DECK_WORKSPACE;
  return typeof workspaceRoot === 'string' && workspaceRoot.length > 0 ? workspaceRoot : undefined;
}

/**
 * Resolve AGENT_DECK_WORKSPACE for diagnostics.
 * Cursor's `${workspaceFolder}` is the folder that owns `.cursor/mcp.json` (project root).
 */
export function resolveWorkspacePinValue(
  raw: string | undefined,
  options?: { projectRoot?: string },
): { pin: string | null; unresolved: boolean } {
  if (!raw?.trim()) {
    return { pin: null, unresolved: false };
  }
  const trimmed = raw.trim();
  if (trimmed.includes('${workspaceFolder}')) {
    if (!options?.projectRoot) {
      return { pin: null, unresolved: true };
    }
    const projectRoot = path.resolve(options.projectRoot);
    const replaced = trimmed.replaceAll('${workspaceFolder}', projectRoot);
    if (replaced.includes('${')) {
      return { pin: null, unresolved: true };
    }
    return { pin: path.resolve(replaced), unresolved: false };
  }
  if (trimmed.includes('${')) {
    return { pin: null, unresolved: true };
  }
  return { pin: path.resolve(trimmed), unresolved: false };
}

/**
 * Pure-MCP HTTP entry (NOT-567): the per-folder `{ url, headers }` entry
 * or the headerless global fallback. A project entry without the
 * workspace header still connects but cannot select a deck; a headerless
 * global entry is the healthy fallback.
 */
function classifyHttpEntry(
  source: CursorMcpConfigSource,
  configPath: string,
  fileExists: boolean,
  entry: unknown,
  endpoint: McpEndpoint,
): CursorMcpEntryReport {
  const record = entry as Record<string, unknown>;
  const url = record.url as string;
  const rawHeader = readHttpWorkspaceHeader(entry);
  // Cursor sends header values literally — `${...}` is never interpolated,
  // so an interpolated header cannot resolve and is flagged, not expanded.
  const unresolved = rawHeader !== undefined && rawHeader.includes('${');
  const workspacePin = rawHeader && !unresolved ? path.resolve(rawHeader) : null;
  const issues: CursorMcpIssue[] = [];
  if (source === 'project' && !rawHeader) {
    issues.push({
      code: 'missing-workspace-header',
      message: `Headerless HTTP entry in ${configPath} cannot select a deck — the folder lands in the unassigned session.`,
    });
  } else if (unresolved) {
    issues.push({
      code: 'unresolved-workspace-pin',
      message: `x-agent-deck-workspace in ${configPath} contains unresolved interpolation (${rawHeader}); Cursor sends header values literally.`,
    });
  }
  const expectedUrl = buildMcpUrl(endpoint);
  if (url !== expectedUrl) {
    issues.push({
      code: 'stale-endpoint',
      message: `Configured endpoint ${url} does not match running Agent Deck ${expectedUrl}.`,
    });
  }

  return {
    source,
    path: configPath,
    fileExists,
    shape: 'http',
    transport: 'http',
    endpoint: summarizeEndpoint(entry),
    workspacePin,
    issues,
  };
}

function classifyEntry(
  source: CursorMcpConfigSource,
  configPath: string,
  endpoint: McpEndpoint,
  options?: { projectRoot?: string },
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

  if (isHttpAgentDeckEntry(entry)) {
    return classifyHttpEntry(source, configPath, fileExists, entry, endpoint);
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
          message: `Custom agent-deck wrapper in ${configPath} is left unchanged; point it at the Agent Deck MCP endpoint with the x-agent-deck-workspace header for this folder.`,
        },
      ],
    };
  }

  const rawPin = readRawWorkspacePin(entry);
  const { pin: workspacePin, unresolved } = resolveWorkspacePinValue(rawPin, {
    projectRoot: source === 'project' ? options?.projectRoot : undefined,
  });
  const endpointSummary = summarizeEndpoint(entry);
  const issues: CursorMcpIssue[] = [];
  if (!rawPin) {
    issues.push({
      code: 'missing-workspace-pin',
      message: `mcp-launch in ${configPath} has no AGENT_DECK_WORKSPACE pin; Cursor may start the launcher outside the bound workspace.`,
    });
  } else if (unresolved) {
    issues.push({
      code: 'unresolved-workspace-pin',
      message: `AGENT_DECK_WORKSPACE in ${configPath} contains unresolved interpolation (${rawPin}); cannot locate the assignment root.`,
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
 * Read usable assignment metadata from `.agent-deck/use.json` without returning secrets.
 * Accepts v3 assignments and legacy v2 manifests (deckId only for display).
 * Legacy v1 manifests are not assignments — they still require `agent-deck use`.
 */
export function readAssignmentSummarySync(workspaceRoot: string): CursorMcpAssignmentSummary {
  const checkedRoot = path.resolve(workspaceRoot);
  const manifestPath = path.join(checkedRoot, '.agent-deck', 'use.json');
  if (!fs.existsSync(manifestPath)) {
    return { checkedRoot, present: false };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const deckId = typeof raw.deckId === 'string' ? raw.deckId : undefined;
    const deckName = typeof raw.deckName === 'string' ? raw.deckName : undefined;
    const version = raw.version;
    const present =
      (version === 3 && typeof deckId === 'string' && deckId.length > 0) ||
      (version === 2 && typeof deckId === 'string' && deckId.length > 0);
    return {
      checkedRoot,
      present,
      ...(deckId ? { deckId } : {}),
      ...(deckName ? { deckName } : {}),
    };
  } catch {
    return { checkedRoot, present: false };
  }
}

function collectOverallIssues(
  preferredSource: CursorMcpInspection['preferredSource'],
  global: CursorMcpEntryReport,
  project: CursorMcpEntryReport,
  assignment: CursorMcpAssignmentSummary,
): CursorMcpIssue[] {
  const issues: CursorMcpIssue[] = [];
  for (const report of [global, project]) {
    for (const issue of report.issues) {
      // Keep shape=missing on the per-source report, but do not alarm on a
      // healthy single-source setup: the global fallback covers folders
      // with no project entry, and a project entry stands alone.
      if (issue.code === 'missing' && preferredSource !== 'none') {
        continue;
      }
      issues.push(issue);
    }
  }
  if (!assignment.present) {
    issues.push({
      code: 'assignment-missing',
      message: `No deck assignment at ${assignment.checkedRoot} — run \`agent-deck use <deck>\`.`,
    });
  }
  return issues;
}

export function inspectCursorMcpConfig(options: {
  cwd?: string;
  endpoint: McpEndpoint;
}): CursorMcpInspection {
  const cwd = path.resolve(options.cwd ?? process.cwd());

  const globalPath = resolveConfigPath('cursor', 'global');
  const projectPath = resolveConfigPath('cursor', 'project', cwd);
  // NOT-602: from the home folder the project path IS the global path,
  // so classifying the same file twice prints it as both Global and
  // Project and misreads the healthy headerless global fallback as a
  // project entry missing its workspace header. There is no project
  // config here — suppress the project side entirely. Compared
  // canonically: process.cwd() is physical while os.homedir() may name
  // the same folder through a symlink (`/tmp` vs `/private/tmp`).
  const projectIsGlobal = canonicalFolder(projectPath) === canonicalFolder(globalPath);
  const global = classifyEntry('global', globalPath, options.endpoint);
  const project: CursorMcpEntryReport = projectIsGlobal
    ? {
        source: 'project',
        path: projectPath,
        fileExists: false,
        shape: 'missing',
        transport: 'none',
        endpoint: {},
        workspacePin: null,
        issues: [],
      }
    : classifyEntry('project', projectPath, options.endpoint, { projectRoot: cwd });

  const preferredSource: CursorMcpInspection['preferredSource'] =
    project.shape !== 'missing' ? 'project' : global.shape !== 'missing' ? 'global' : 'none';

  const preferred = preferredSource === 'project' ? project : preferredSource === 'global' ? global : null;
  const assignmentRoot = preferred?.workspacePin ?? cwd;
  const assignment = readAssignmentSummarySync(assignmentRoot);
  const issues = collectOverallIssues(preferredSource, global, project, assignment);

  return {
    cwd,
    expectedPrecedence: 'project-over-global',
    preferredSource,
    global,
    project,
    assignment,
    issues,
  };
}

/**
 * Distinct recoveries for status/doctor: per-folder entry repair (agent
 * sandbox OK when assignment exists) vs missing assignment / home-store
 * write (unsandboxed). Bracket labels match issue `code` values for grep
 * parity.
 */
export function formatCursorMcpRecoveryLines(report: CursorMcpInspection): string[] {
  const codes = new Set(report.issues.map((issue) => issue.code));
  const lines: string[] = [];

  if (codes.has('assignment-missing')) {
    lines.push(
      '  Recovery [assignment-missing]: run `agent-deck use <deck>` in an unsandboxed terminal (needs ~/.agent-deck). Host agent sandboxes often cannot create a new assignment.',
    );
  }
  if (
    (codes.has('missing-workspace-pin') || codes.has('unresolved-workspace-pin')) &&
    report.assignment.present
  ) {
    lines.push(
      '  Recovery [missing-workspace-pin]: assignment exists — run `agent-deck use <deck> --client cursor` in this project to rewrite the per-folder entry (workspace-writable; works under host agent sandboxes).',
    );
  }
  if (codes.has('missing-workspace-header')) {
    lines.push(
      '  Recovery [missing-workspace-header]: run `agent-deck use <deck> --client cursor` in this project to write the per-folder entry with the workspace header, then reload MCP.',
    );
  }
  if (lines.length === 0) {
    lines.push(`  Recovery: ${CURSOR_MCP_RECOVERY_HINT}`);
  }
  return lines;
}

export function formatCursorMcpInspection(report: CursorMcpInspection): string {
  // NOT-602: matches the suppression in inspectCursorMcpConfig — when the
  // project path equals the global path (cwd is the home folder), print
  // the path once as Global and point at a project folder for Project.
  const projectIsGlobal =
    canonicalFolder(report.project.path) === canonicalFolder(report.global.path);
  const lines: string[] = [
    'Cursor MCP inspection (read-only):',
    `  Expected precedence: project over global`,
    `  Preferred source: ${report.preferredSource}`,
    `  Global  ${report.global.path}`,
    `    shape=${report.global.shape} transport=${report.global.transport}` +
      (report.global.workspacePin ? ` pin=${report.global.workspacePin}` : ''),
    ...(projectIsGlobal
      ? ['  Project: none (run doctor inside a project folder)']
      : [
          `  Project ${report.project.path}`,
          `    shape=${report.project.shape} transport=${report.project.transport}` +
            (report.project.workspacePin ? ` pin=${report.project.workspacePin}` : ''),
        ]),
    `  Assignment ${report.assignment.present ? 'present' : 'missing'} @ ${report.assignment.checkedRoot}` +
      (report.assignment.deckName || report.assignment.deckId
        ? ` (${report.assignment.deckName ?? report.assignment.deckId})`
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

  lines.push(...formatCursorMcpRecoveryLines(report));

  return lines.join('\n');
}
