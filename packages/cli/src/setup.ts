import { spawn } from 'node:child_process';

import { installAgentHarness } from './agent-harness';
import {
  buildAgentDeckEntry,
  buildMcpUrl,
  mergeMcpServerConfig,
  readJsonFile,
  resolveConfigPath,
  writeJsonFile,
  type McpClient,
  type McpEndpoint,
  type SetupScope,
} from './mcp-config';
import { readUseManifest } from './playbook-stubs';
import { installStatusline, type StatuslineClient } from './statusline-setup';
import { isDarwinPlatform, setupMenubar } from './menubar-setup';
import { CLI_DEFAULT_MCP_PORT, parseCliMcpPort } from './defaults';

export interface SetupOptions {
  client: McpClient | null;
  scope?: SetupScope;
  host?: string;
  mcpPort?: number;
  start?: boolean;
  statusline: boolean;
  menubar: boolean;
}

function parseClient(value: string | undefined): McpClient | null {
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase();
  if (normalized === 'claude-code' || normalized === 'claude_code') {
    return 'claude';
  }

  if (normalized === 'cursor' || normalized === 'claude' || normalized === 'claude-desktop') {
    return normalized;
  }

  return null;
}

function parseSetupArgs(args: string[]): SetupOptions | { error: string } {
  let client: McpClient | null = null;
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
    return { error: '--client is required (cursor, claude, or claude-desktop)' };
  }

  if (client !== 'cursor' && client !== 'claude' && scope === 'project') {
    return { error: '--scope project is only supported for cursor and claude' };
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
export function resolveSetupMenubar(client: McpClient, explicit?: boolean): boolean {
  if (explicit === false) {
    return false;
  }
  if (explicit === true) {
    return true;
  }
  return isDarwinPlatform();
}

/** Status line is on by default for Claude Code and Cursor CLI; optional for Claude Desktop. */
export function resolveSetupStatusline(client: McpClient, explicit?: boolean): boolean {
  if (explicit === false) {
    return false;
  }
  if (explicit === true) {
    return true;
  }
  return client === 'cursor' || client === 'claude';
}

async function tryClaudeCliAdd(endpoint: McpEndpoint): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        'mcp',
        'add',
        '--scope',
        'user',
        '--transport',
        'http',
        'agent-deck',
        buildMcpUrl(endpoint),
      ],
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
  agent-deck setup --client cursor|claude|claude-desktop [--scope global|project] [--mcp-port PORT] [--start]
  agent-deck setup --menubar

Recommended (macOS, both terminal agents + menu bar):
  agent-deck setup --client cursor --start
  agent-deck setup --client claude

Options:
  --client          MCP client to configure (required unless --menubar alone)
  --scope           global (default) or project — project only for cursor/claude
  --host            MCP host (default 127.0.0.1 or AGENT_DECK_HOST)
  --mcp-port        MCP port (default ${CLI_DEFAULT_MCP_PORT} or AGENT_DECK_MCP_PORT)
  --start           Start Agent Deck after writing config
  --no-statusline   Skip prompt status line (default: on for cursor and claude)
  --statusline      Same as default for cursor/claude (kept for compatibility)
  --no-menubar      Skip SwiftBar menu bar plugin (default: on for macOS)
  --menubar         Force menu bar plugin (also works alone, without --client)

Setup installs MCP config, agent harness, terminal status line, and on macOS: SwiftBar plugin
(+ Homebrew SwiftBar install when run interactively in a terminal).`);
}

async function finishSetup(
  client: McpClient,
  scope: SetupScope,
  endpoint: McpEndpoint,
  shouldStart: boolean,
  withStatusline: boolean,
  withMenubar: boolean,
): Promise<number> {
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
      console.log('  --statusline applies to Cursor CLI and Claude Code only (not Claude Desktop).');
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

  if (client === 'claude') {
    const added = await tryClaudeCliAdd(endpoint);
    if (added.ok) {
      console.log('Configured Claude Code via `claude mcp add` → ~/.claude.json');
      console.log('Verify: claude mcp list');
      return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
    }
    console.warn(`Claude CLI failed (${added.error ?? 'unknown error'}) — writing ~/.claude.json instead`);
  }

  const configPath = resolveConfigPath(client, scope);
  // Don't clobber an existing project deck bind: if this folder ran `agent-deck
  // use`, keep its auto-bind header instead of writing a bare entry.
  const deckId =
    scope === 'project' ? readUseManifest(process.cwd())?.deckId : undefined;
  const entry = buildAgentDeckEntry(client, endpoint, deckId);
  const merged = mergeMcpServerConfig(readJsonFile(configPath), entry);
  writeJsonFile(configPath, merged);

  console.log(`Wrote agent-deck MCP config → ${configPath}`);
  if (client === 'claude-desktop') {
    console.log('Claude Desktop uses a stdio bridge (supergateway) because JSON config is stdio-only.');
    console.log('Start Agent Deck before opening Claude Desktop.');
  }

  return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
}

function printNextSteps(
  endpoint: McpEndpoint,
  shouldStart: boolean,
  client: McpClient,
  withStatusline = false,
  withMenubar = false,
): void {
  console.log('');
  console.log('Next steps:');
  let step = 1;
  if (shouldStart) {
    console.log(`  ${step}. Agent Deck will start in the background (\`agent-deck start --daemon\`)`);
  } else {
    console.log(`  ${step}. agent-deck start --daemon  (or \`agent-deck stop\` first if ports are busy)`);
  }
  step += 1;
  console.log(`  ${step}. MCP endpoint → ${buildMcpUrl(endpoint)}`);
  step += 1;
  console.log(`  ${step}. Restart Claude Code / Cursor so MCP + harness rules load`);
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
