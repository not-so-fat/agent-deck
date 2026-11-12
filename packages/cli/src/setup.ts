import { spawn } from 'node:child_process';

import { installAgentHarness } from './agent-harness';
import {
  buildAgentDeckEntry,
  buildGlobalFallbackHttpEntry,
  buildMcpUrl,
  formatCodexGlobalFallbackSection,
  isHttpAgentDeckEntry,
  isMcpLaunchEntry,
  mergeCodexTomlConfig,
  mergeMcpServerConfig,
  mergeMuseServerConfig,
  readJsonFile,
  readTextFile,
  resolveConfigPath,
  writeJsonFile,
  writeTextFile,
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

  if (
    normalized === 'cursor' ||
    normalized === 'claude' ||
    normalized === 'claude-desktop' ||
    normalized === 'codex' ||
    normalized === 'muse'
  ) {
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
    return { error: '--client is required (codex, cursor, claude, claude-desktop, or muse)' };
  }

  if (
    client !== 'cursor' &&
    client !== 'claude' &&
    client !== 'codex' &&
    client !== 'muse' &&
    scope === 'project'
  ) {
    return { error: '--scope project is only supported for codex, cursor, claude, and muse' };
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

export function buildClaudeCliAddArgs(
  scope: SetupScope,
  endpoint: McpEndpoint,
  options?: { workspaceRoot?: string },
): string[] {
  const args = [
    'mcp',
    'add',
    '--scope',
    scope === 'global' ? 'user' : 'project',
    '--transport',
    'http',
    'agent-deck',
    buildMcpUrl(endpoint),
  ];
  // Project scope carries the workspace header so the daemon can resolve
  // the folder assignment (NOT-563 shape); global stays headerless (NOT-565).
  if (options?.workspaceRoot) {
    args.push('--header', `x-agent-deck-workspace: ${options.workspaceRoot}`);
  }
  return args;
}

async function tryClaudeCliAdd(
  scope: SetupScope,
  endpoint: McpEndpoint,
  options?: { workspaceRoot?: string },
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      buildClaudeCliAddArgs(scope, endpoint, options),
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
  agent-deck setup --client codex|cursor|claude|claude-desktop|muse [--scope global|project] [--mcp-port PORT] [--start]
  agent-deck setup --menubar

Recommended (macOS, both terminal agents + menu bar):
  agent-deck setup --client codex --start
  agent-deck setup --client cursor --start
  agent-deck setup --client claude
  agent-deck setup --client muse

Options:
  --client          Agent host to configure (required unless --menubar alone)
  --scope           global (default) or project — project for codex/cursor/claude/muse
  --host            MCP host (default 127.0.0.1 or AGENT_DECK_HOST)
  --mcp-port        MCP port (default ${CLI_DEFAULT_MCP_PORT} or AGENT_DECK_MCP_PORT)
  --start           Start Agent Deck after writing config
  --no-statusline   Skip prompt status line (default: on for cursor and claude)
  --statusline      Same as default for cursor/claude (kept for compatibility)
  --no-menubar      Skip SwiftBar menu bar plugin (default: on for macOS)
  --menubar         Force menu bar plugin (also works alone, without --client)

Setup installs host guidance, MCP config where the host owns it, and on macOS: SwiftBar plugin.
Terminal status line only for Cursor CLI and Claude Code (--statusline/--no-statusline).
Codex connects over pure MCP: setup writes the global headerless HTTP fallback and merges AGENTS.md (the plugin supplies skills, not transport).
Cursor connects over pure MCP: setup writes the global headerless HTTP fallback and agent-deck use writes the per-folder entry (the plugin supplies skills, not transport).
Muse connects over pure MCP: setup writes the global headerless HTTP fallback (no executable lookup); trust the folder and reload MCP so the entry loads.
Muse global setup installs native bootstrap skills; --scope project merges root AGENTS.md (trust the workspace so Muse loads it). No Muse status line or plugin install.
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
  if (harness.error) {
    console.error(harness.error);
    return 1;
  }
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

  printNextSteps(endpoint, shouldStart, client, scope, withStatusline, withMenubar);
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
    if (scope === 'global') {
      const codexConfigPath = resolveConfigPath('codex', 'global');
      const section = formatCodexGlobalFallbackSection(endpoint);
      writeTextFile(codexConfigPath, mergeCodexTomlConfig(readTextFile(codexConfigPath), section));
      console.log(`Wrote global agent-deck fallback (headerless HTTP, no executable lookup) → ${codexConfigPath}`);
      console.log('Unassigned folders land in the explain-only session; `agent-deck use <deck>` writes the per-folder entry.');
    } else {
      console.log('Codex per-folder MCP entries come from `agent-deck use <deck>`; setup merges AGENTS.md guidance only.');
    }
    console.log('Setup will install or refresh Agent Deck guidance in AGENTS.md without replacing other instructions.');
    return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
  }

  if (client === 'claude') {
    // Project scope must keep the workspace header (same NOT-563 shape
    // `agent-deck use` writes); a headerless project entry would silently
    // drop the folder into the unassigned session.
    const claudeWorkspaceRoot = scope === 'project' ? process.cwd() : undefined;
    const added = await tryClaudeCliAdd(scope, endpoint, { workspaceRoot: claudeWorkspaceRoot });
    if (added.ok) {
      const target = scope === 'project' ? '.mcp.json' : '~/.claude.json';
      if (scope === 'project') {
        console.log(`Configured Claude Code via \`claude mcp add\` → ${target} (per-folder HTTP entry with workspace header)`);
        console.log('Approve the project agent-deck entry when prompted, then reload MCP.');
      } else {
        console.log(`Configured Claude Code via \`claude mcp add\` → ${target} (headerless HTTP fallback, no executable lookup)`);
        console.log('Unassigned folders land in the explain-only session; `agent-deck use <deck>` writes the per-folder entry.');
      }
      console.log('Verify: claude mcp list');
      return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
    }
    console.warn(`Claude CLI failed (${added.error ?? 'unknown error'}) — writing ${resolveConfigPath('claude', scope)} instead`);
  }

  if (client === 'cursor' && scope === 'global') {
    // NOT-567: the global entry is the headerless HTTP fallback — no
    // launcher, no workspace pin, no executable lookup. Agent Deck's own
    // legacy launcher entry is upgraded; a custom or wrapped entry is
    // never changed.
    const cursorGlobalPath = resolveConfigPath('cursor', 'global');
    const cursorGlobalConfig = readJsonFile(cursorGlobalPath);
    const cursorGlobalServers = cursorGlobalConfig.mcpServers;
    const cursorGlobalEntry =
      cursorGlobalServers &&
      typeof cursorGlobalServers === 'object' &&
      !Array.isArray(cursorGlobalServers)
        ? (cursorGlobalServers as Record<string, unknown>)['agent-deck']
        : undefined;
    if (
      cursorGlobalEntry !== undefined &&
      !isMcpLaunchEntry(cursorGlobalEntry) &&
      !isHttpAgentDeckEntry(cursorGlobalEntry)
    ) {
      console.warn(`Cursor MCP: left custom agent-deck entry unchanged in ${cursorGlobalPath}.`);
      console.warn(
        `  Point that wrapper at ${buildMcpUrl(endpoint)} (per-folder entries add the x-agent-deck-workspace header).`,
      );
      return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
    }
    writeJsonFile(
      cursorGlobalPath,
      mergeMcpServerConfig(cursorGlobalConfig, buildAgentDeckEntry('cursor', endpoint)),
    );
    console.log(
      `Wrote global agent-deck fallback (headerless HTTP, no executable lookup) → ${cursorGlobalPath}`,
    );
    console.log(
      'Unassigned folders land in the explain-only session; `agent-deck use <deck>` writes the per-folder entry.',
    );
    return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
  }

  if (client === 'muse' && scope === 'global') {
    // NOT-570: the global entry is the headerless HTTP fallback — no
    // launcher, no executable lookup. Agent Deck's own legacy launcher
    // entry is replaced outright: Muse merges a same-name project entry
    // with the user entry field by field, so a leftover stdio user entry
    // would reject the per-folder HTTP entry as
    // invalid_transport_combination. A custom or wrapped entry is never
    // changed.
    const museGlobalPath = resolveConfigPath('muse', 'global');
    const museGlobalConfig = readJsonFile(museGlobalPath);
    const museGlobalServers = museGlobalConfig.mcpServers;
    const museGlobalEntry =
      museGlobalServers &&
      typeof museGlobalServers === 'object' &&
      !Array.isArray(museGlobalServers)
        ? (museGlobalServers as Record<string, unknown>)['agent-deck']
        : undefined;
    if (
      museGlobalEntry !== undefined &&
      !isMcpLaunchEntry(museGlobalEntry) &&
      !isHttpAgentDeckEntry(museGlobalEntry)
    ) {
      console.warn(`Muse MCP: left custom agent-deck entry unchanged in ${museGlobalPath}.`);
      console.warn(
        `  Point that wrapper at ${buildMcpUrl(endpoint)} (per-folder entries add the x-agent-deck-workspace header).`,
      );
      return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
    }
    let museMerged: Record<string, unknown>;
    try {
      museMerged = mergeMuseServerConfig(
        museGlobalConfig,
        buildGlobalFallbackHttpEntry(endpoint),
        museGlobalPath,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    writeJsonFile(museGlobalPath, museMerged);
    console.log(
      `Wrote global agent-deck fallback (headerless HTTP, no executable lookup) → ${museGlobalPath}`,
    );
    console.log(
      'Unassigned folders land in the explain-only session; run `agent-deck use <deck>` in each folder that needs a persistent assignment, then reload MCP.',
    );
    // A same-name launcher project entry in this folder would now break
    // Muse here: Muse merges it with the HTTP user entry field by field
    // (url plus command → invalid_transport_combination) and omits the
    // server. Folders assigned with `use --client muse` or project-scope
    // setup still hold that entry — plain `use` rewrites .mcp.json with
    // the headered HTTP entry Muse accepts (the Muse-native per-folder
    // entry is the next ticket). A missing or unparsable file simply
    // skips the warning; global setup must not fail on it.
    const museProjectPath = resolveConfigPath('muse', 'project');
    let museProjectEntry: unknown;
    try {
      const museProjectServers = readJsonFile(museProjectPath).mcpServers;
      museProjectEntry =
        museProjectServers &&
        typeof museProjectServers === 'object' &&
        !Array.isArray(museProjectServers)
          ? (museProjectServers as Record<string, unknown>)['agent-deck']
          : undefined;
    } catch {
      museProjectEntry = undefined;
    }
    if (isMcpLaunchEntry(museProjectEntry)) {
      console.warn(
        `Muse MCP: ${museProjectPath} still holds a legacy agent-deck launcher entry, which Muse rejects against the new HTTP user entry (invalid_transport_combination) — agent-deck is omitted in this folder.`,
      );
      console.warn(
        '  Re-run plain `agent-deck use <deck>` here to rewrite .mcp.json with the headered HTTP entry Muse accepts, then reload MCP.',
      );
    }
    return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
  }

  const configPath = resolveConfigPath(client, scope);
  const existingConfig = readJsonFile(configPath);
  // Project scope writes the per-folder HTTP entry (workspace header);
  // only global setup writes the headerless fallback. (Cursor and Muse
  // global are handled above; Claude global prefers `claude mcp add`.)
  const workspaceRoot =
    (client === 'cursor' || client === 'claude') && scope === 'project' ? process.cwd() : undefined;
  const entry = buildAgentDeckEntry(client, endpoint, { workspaceRoot });
  const merged = mergeMcpServerConfig(existingConfig, entry);
  writeJsonFile(configPath, merged);

  console.log(`Wrote agent-deck MCP config → ${configPath}`);
  if (client === 'claude-desktop') {
    console.log("Claude Desktop uses Agent Deck's stdio bridge because JSON config is stdio-only.");
    console.log('Start Agent Deck before opening Claude Desktop.');
  }
  if (client === 'muse' && scope === 'project') {
    // NOT-570: project scope still writes the legacy launcher entry
    // (the per-folder HTTP entry is the next ticket; the write itself
    // stays until the ticket after that). Against the new HTTP user
    // entry Muse rejects it (invalid_transport_combination) and omits
    // the server in this folder — the durable part of project setup is
    // the root AGENTS.md merge.
    console.warn(
      'Muse MCP: .mcp.json now holds the legacy launcher entry, which Muse rejects against the HTTP user entry (invalid_transport_combination) — agent-deck is omitted in this folder.',
    );
    console.warn(
      '  For the folder connection, re-run plain `agent-deck use <deck>` here instead (it writes the headered HTTP entry Muse accepts), then reload MCP.',
    );
  }

  return await finishSetup(client, scope, endpoint, parsed.start === true, parsed.statusline, parsed.menubar);
}

function printNextSteps(
  endpoint: McpEndpoint,
  shouldStart: boolean,
  client: SetupClient,
  scope: SetupScope = 'global',
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
    console.log(`  ${step}. MCP endpoint → ${buildMcpUrl(endpoint)} (global headerless HTTP fallback; no executable lookup)`);
    step += 1;
    console.log(`  ${step}. Verify the Agent Deck Codex plugin (skills) is installed, enabled, and current`);
    step += 1;
    console.log(`  ${step}. Run \`agent-deck use <deck>\` in each IDE folder that needs a persistent assignment`);
    step += 1;
    console.log(`  ${step}. Trust the folder, approve the project entry, then start a new Codex task so MCP + AGENTS.md guidance reload`);
  } else if (client === 'muse') {
    console.log(`  ${step}. MCP endpoint → ${buildMcpUrl(endpoint)} (global headerless HTTP fallback; no executable lookup)`);
    step += 1;
    if (scope === 'project') {
      console.log(`  ${step}. Trust this workspace so Muse loads root AGENTS.md, then start a new Muse process so MCP + guidance reload`);
    } else {
      console.log(`  ${step}. Trust the folder, then start a new Muse process so the agent-deck MCP server + bootstrap skills load (restart Muse)`);
    }
    step += 1;
    console.log(`  ${step}. Run \`agent-deck use <deck>\` in each folder that needs a persistent assignment, then reload MCP`);
    step += 1;
    console.log(`  ${step}. In Muse, \`/mcp\` should show agent-deck; unassigned folders land in the explain-only session (no Agent Deck status line for Muse)`);
  } else if (client === 'cursor') {
    console.log(`  ${step}. MCP endpoint → ${buildMcpUrl(endpoint)} (global headerless HTTP fallback; no executable lookup)`);
    step += 1;
    console.log(`  ${step}. Verify the Agent Deck Cursor plugin (skills) is installed, enabled, and current`);
    step += 1;
    console.log(`  ${step}. Run \`agent-deck use <deck>\` in each IDE folder that needs a persistent assignment`);
    step += 1;
    console.log(`  ${step}. Approve the project agent-deck server, then reload MCP so the new entry loads`);
  } else {
    console.log(`  ${step}. MCP endpoint → ${buildMcpUrl(endpoint)}`);
    step += 1;
    console.log(`  ${step}. Restart Claude Code so MCP + harness rules load`);
  }
  step += 1;
  if (client === 'claude') {
    console.log(`  ${step}. Claude Code: \`claude mcp list\` — agent-deck should show Connected when the backend is running`);
    step += 1;
    console.log(`  ${step}. No tools? Trust the folder, approve the project agent-deck entry, run \`agent-deck use <deck>\` in the folder, then reload MCP`);
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
  console.log('First turn: the agent calls get_session_context once and shows exactly one');
  console.log('verbatim display_summary line. That transcript receipt is the authoritative');
  console.log('binding record for the session — terminal status lines are optional secondary context.');
  console.log('');
  console.log('Updates: managed install auto-updates by default (agent-deck install). Opt out: AGENT_DECK_DISABLE_AUTOUPDATER=1');
}

export function shouldStartAfterSetup(exitCode: number): boolean {
  return exitCode === 2;
}
