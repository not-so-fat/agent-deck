import { spawn } from 'node:child_process';

import { installAgentHarness } from './agent-harness';
import {
  buildAgentDeckEntry,
  buildMcpUrl,
  mergeMcpServerConfig,
  readCursorWorkspaceRoot,
  readJsonFile,
  resolveConfigPath,
  writeJsonFile,
  type McpClient,
  type McpEndpoint,
  type SetupScope,
} from './mcp-config';
import { formatLegacyStubCleanupMessage, removeLegacyPlaybookStubs } from './playbook-stubs';
import { installStatusline, type StatuslineClient } from './statusline-setup';
import { isDarwinPlatform, setupMenubar } from './menubar-setup';
import { CLI_DEFAULT_MCP_PORT, parseCliMcpPort } from './defaults';

export type SetupClient = McpClient | 'codex';

export interface SetupOptions {
  client: SetupClient | null;
  scope?: SetupScope;
  host?: string;
  mcpPort?: number;
  start?: boolean;
  statusline: boolean;
  menubar: boolean;
}

function parseClient(value: string | undefined): SetupClient | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();
  if (normalized === 'claude-code' || normalized === 'claude_code') {
    return 'claude';
  }

  if (normalized === 'cursor' || normalized === 'claude' || normalized === 'claude-desktop' || normalized === 'codex') {
    return normalized;
  }

  return null;
}

function parseSetupArgs(args: string[]): SetupOptions | { error: string } {
  let client: SetupClient | null = null;
  let scope: SetupScope = 'global';
  let host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  let mcpPort = parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  let start = false;
  let statusline: boolean | undefined;
  let menubar: boolean | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--client') {
      client = parseClient(args[++i]);
    } else if (arg === '--scope') {
      const value = args[++i];
      if (value === 'global' || value === 'project') {
        scope = value;
      } else {
        return { error: '--scope must be global or project' };
      }
    } else if (arg === '--host') {
      host = args[++i] ?? host;
    } else if (arg === '--mcp-port') {
      mcpPort = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '--start') {
      start = true;
    } else if (arg === '--statusline') {
      statusline = true;
    } else if (arg === '--no-statusline') {
      statusline = false;
    } else if (arg === '--menubar') {
      menubar = true;
    } else if (arg === '--no-menubar') {
      menubar = false;
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'help' };
    } else {
      return { error: `Unknown setup option: ${arg}` };
    }
  }

  if (!client) {
    if (menubar === true) {
      return { client: null, scope, host, mcpPort, start, statusline: false, menubar: true };
    }
    return { error: '--client is required (codex, cursor, claude, or claude-desktop)' };
  }

  if (client !== 'cursor' && client !== 'claude' && client !== 'codex' && scope === 'project') {
    return { error: '--scope project is only supported for codex, cursor, and claude' };
  }

  if (!Number.isFinite(mcpPort)) {
    return { error: '--mcp-port must be a number' };
  }

  return {
    client,
    scope,
    host,
    mcpPort,
    start,
    statusline: resolveSetupStatusline(client, statusline),
    menubar: resolveSetupMenubar(client, menubar),
  };
}

/** Menu bar plugin on by default on macOS (SwiftBar); opt out with --no-menubar. */
export function resolveSetupMenubar(client: SetupClient, explicit?: boolean): boolean {
  if (explicit === false) {
    return false;
  }
  if (explicit === true) {
    return true;
  }
  return isDarwinPlatform();
}

/** Status line is on by default for Claude Code and Cursor CLI; optional for Claude Desktop. */
export function resolveSetupStatusline(client: SetupClient, explicit?: boolean): boolean {
  if (explicit === false) {
    return false;
  }
  if (explicit === true) {
    return true;
  }
  return client === 'cursor' || client === 'claude';
}

export function buildClaudeCliAddArgs(scope: SetupScope, endpoint: McpEndpoint): string[] {
  return [
    'mcp',
    'add',
    '--scope',
    scope === 'global' ? 'user' : 'project',
    'agent-deck',
    '-e',
    `AGENT_DECK_MCP_PORT=${endpoint.mcpPort}`,
    '-e',
    `AGENT_DECK_HOST=${endpoint.host}`,
    '--',
    'agent-deck',
    'mcp-launch',
  ];
}

async function tryClaudeCliAdd(
  scope: SetupScope,
  endpoint: McpEndpoint,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      buildClaudeCliAddArgs(scope, endpoint),
      { stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
    );

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, error: stderr.trim() || `claude mcp add exited with code ${code}` });
    });
  });
}

export function printSetupUsage(): void {
  console.log(`Usage:
  agent-deck setup --client codex|cursor|claude|claude-desktop [--scope global|project] [--mcp-port PORT] [--start]
  agent-deck setup --menubar

Recommended (macOS, both terminal agents + menu bar):
  agent-deck setup --client codex --start
  agent-deck setup --client cursor --start
  agent-deck setup --client claude

Options:
  --client          Agent host to configure (required unless --menubar alone)
  --scope           global (default) or project — project for codex/cursor/claude
  --host            MCP host (default 127.0.0.1 or AGENT_DECK_HOST)
  --mcp-port        MCP port (default ${CLI_DEFAULT_MCP_PORT} or AGENT_DECK_MCP_PORT)
  --start           Start Agent Deck after writing config
  --no-statusline   Skip prompt status line (default: on for cursor and claude)
  --statusline      Same as default for cursor/claude (kept for compatibility)
  --no-menubar      Skip SwiftBar menu bar plugin (default: on for macOS)
  --menubar         Force menu bar plugin (also works alone, without --client)

Setup installs host guidance, MCP config where the host owns it, terminal status line, and on macOS: SwiftBar plugin.
Codex MCP transport is supplied by the separately installed Agent Deck plugin; Codex setup merges AGENTS.md only.
(+ Homebrew SwiftBar install when run interactively in a terminal).`);
}

async function finishSetup(
  client: SetupClient,
  scope: SetupScope,
  endpoint: McpEndpoint,
  shouldStart: boolean,
  withStatusline: boolean,
  withMenubar: boolean,
): Promise<number> {
  // NOT-208 one-time migration: drop Agent Deck-managed legacy playbook
  // stubs from the current workspace (both hosts — the stubs are stale no
  // matter which client is being configured). Only marker-carrying files
  // are removed; user-authored skills/rules are never touched.
  try {
    const cleanup = removeLegacyPlaybookStubs(process.cwd());
    const message = formatLegacyStubCleanupMessage(cleanup);
    if (message) {
      console.log(message);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const harness = installAgentHarness(client, scope);
  console.log(harness.message);
  if (!harness.installed && client === 'claude-desktop') {
    console.log('  See docs/AGENT_HARNESS.md if you also use Claude Code or Cursor.');
  }


  if (withStatusline) {
    if (client === 'cursor' || client === 'claude') {
      const statusline = installStatusline(client as StatuslineClient);
      console.log(statusline.message);
      if (client === 'claude') {
        console.log('  Restart Claude Code after setup. If the status line stays blank, accept workspace trust for this project.');
      } else {
        console.log('  Restart Cursor CLI after setup.');
      }
    } else {
      console.log('  --statusline applies to Cursor CLI and Claude Code only.');
    }
  }

  if (withMenubar) {
    const plugin = setupMenubar();
    console.log(plugin.message);
    for (const hint of plugin.hints) {
      console.log(`  ${hint}`);
    }
  }

  printNextSteps(endpoint, shouldStart, client, withStatusline, withMenubar);
  return shouldStart ? 2 : 0;
}

export async function runSetup(args: string[]): Promise<number> {
  const parsed = parseSetupArgs(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      printSetupUsage();
      return 0;
    }
    console.error(parsed.error);
    printSetupUsage();
    return 1;
  }

  if (parsed.menubar && !parsed.client) {
    const plugin = setupMenubar();
    console.log(plugin.message);
    for (const hint of plugin.hints) {
      console.log(`  ${hint}`);
    }
    return 0;
  }

  const client = parsed.client!;
  const endpoint: McpEndpoint = {
    host: parsed.host ?? '127.0.0.1',
    mcpPort: parsed.mcpPort ?? CLI_DEFAULT_MCP_PORT,
  };
  const scope = parsed.scope ?? 'global';

  if (client === 'codex') {
    console.log('Codex MCP transport is supplied by the installed Agent Deck plugin (`agent-deck mcp-launch`).');
    console.log('Setup will install or refresh Agent Deck guidance in AGENTS.md without replacing other instructions.');
    return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
  }

  if (client === 'claude') {
    const added = await tryClaudeCliAdd(scope, endpoint);
    if (added.ok) {
      const target = scope === 'project' ? '.mcp.json' : '~/.claude.json';
      console.log(`Configured Claude Code via \`claude mcp add\` → ${target}`);
      console.log('Verify: claude mcp list');
      return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
    }
    console.warn(`Claude CLI failed (${added.error ?? 'unknown error'}) — writing ~/.claude.json instead`);
  }

  const configPath = resolveConfigPath(client, scope);
  const existingConfig = readJsonFile(configPath);
  const existingServers = existingConfig.mcpServers;
  const existingEntry =
    existingServers && typeof existingServers === 'object' && !Array.isArray(existingServers)
      ? (existingServers as Record<string, unknown>)['agent-deck']
      : undefined;
  // Project launchers always know their workspace. Global setup preserves a pin
  // written by `agent-deck use` so re-running setup cannot drop the deck header.
  const workspaceRoot =
    client === 'cursor'
      ? scope === 'project'
        ? process.cwd()
        : readCursorWorkspaceRoot(existingEntry)
      : undefined;
  const entry = buildAgentDeckEntry(client, endpoint, { workspaceRoot });
  const merged = mergeMcpServerConfig(existingConfig, entry);
  writeJsonFile(configPath, merged);

  console.log(`Wrote agent-deck MCP config → ${configPath}`);
  if (client === 'claude-desktop') {
    console.log("Claude Desktop uses Agent Deck's stdio bridge because JSON config is stdio-only.");
    console.log('Start Agent Deck before opening Claude Desktop.');
  }

  return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
}

function printNextSteps(
  endpoint: McpEndpoint,
  shouldStart: boolean,
  client: SetupClient,
  withStatusline = false,
  withMenubar = false,
): void {
  console.log('');
  console.log('Next steps:');
  let step = 1;
  if (shouldStart) {
    console.log(`  ${step}. Agent Deck will start in the background and open the dashboard (\`agent-deck start --daemon\`)`);
  } else {
    console.log(`  ${step}. agent-deck start  (opens dashboard; use --no-open or --daemon as needed)`);
  }
  step += 1;
  if (client === 'codex') {
    console.log(`  ${step}. Verify the Agent Deck Codex plugin is installed, enabled, and current`);
    step += 1;
    console.log(`  ${step}. Run \`agent-deck use <deck>\` in each IDE folder that needs a persistent assignment`);
    step += 1;
    console.log(`  ${step}. Start a new Codex task so MCP + AGENTS.md guidance reload`);
  } else {
    console.log(`  ${step}. MCP endpoint → ${buildMcpUrl(endpoint)}`);
    step += 1;
    console.log(`  ${step}. Restart Claude Code / Cursor so MCP + harness rules load`);
  }
  step += 1;
  if (client === 'claude') {
    console.log(`  ${step}. Claude Code: \`claude mcp list\` — agent-deck should show Connected when the backend is running`);
    step += 1;
  }
  if (client === 'cursor' || client === 'claude') {
    console.log(`  ${step}. Set up the other terminal agent: agent-deck setup --client ${client === 'cursor' ? 'claude' : 'cursor'}`);
    step += 1;
  }
  if (withStatusline && (client === 'cursor' || client === 'claude')) {
    console.log(
      `  ${step}. Terminal footer shows deck after bind_workspace (debug: agent-deck statusline --workspace <path>)`,
    );
    step += 1;
  }
  if (withMenubar && isDarwinPlatform()) {
    console.log(`  ${step}. Menu bar shows ⌘badges after bind_workspace (matches chat opener + dashboard)`);
    step += 1;
  }
  console.log('');
  console.log('Updates: managed install auto-updates by default (agent-deck install). Opt out: AGENT_DECK_DISABLE_AUTOUPDATER=1');
}

export function shouldStartAfterSetup(exitCode: number): boolean {
  return exitCode === 2;
}
