import path from 'node:path';

import { createCollectionAdmin } from './backend-runtime';
import { CLI_DEFAULT_MCP_PORT, parseCliMcpPort } from './defaults';
import {
  buildAgentDeckEntry,
  buildMcpUrl,
  mergeMcpServerConfig,
  readJsonFile,
  resolveConfigPath,
  writeJsonFile,
  type McpClient,
} from './mcp-config';
import { syncPlaybookStubs, type StubSyncResult } from './playbook-stubs';
import { issueWorkspaceGrant, activateWorkspaceGrant, revokePendingWorkspaceGrant, toGrantManifest } from './grant-issue';
import { FileGrantStore, KeychainGrantStore, readWorkspaceGrant } from './grant-store';
import { readUseManifest } from './playbook-stubs';

export type UseClientTarget = 'cursor' | 'claude' | 'both';

export interface UseOptions {
  deckRef?: string;
  refresh: boolean;
  clients: UseClientTarget;
  host: string;
  mcpPort: number;
  skipMcp: boolean;
  workspaceRoot: string;
}

export type UseResult = {
  deck: { id: string; name: string };
  mcpUrl: string;
  manifestPath: string;
  mcp: Array<{ client: McpClient; path: string }>;
  stubs: StubSyncResult;
  playbookCount: number;
};

function parseUseClient(value: string | undefined): UseClientTarget | null {
  if (!value || value === 'both') {
    return 'both';
  }
  if (value === 'cursor' || value === 'claude') {
    return value;
  }
  return null;
}

export function parseUseArgs(args: string[]): UseOptions | { error: string } {
  let deckRef: string | undefined;
  let refresh = false;
  let clients: UseClientTarget = 'both';
  let host = process.env.AGENT_DECK_HOST ?? '127.0.0.1';
  let mcpPort = parseCliMcpPort(process.env.AGENT_DECK_MCP_PORT);
  let skipMcp = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--refresh') {
      refresh = true;
    } else if (arg === '--client') {
      const parsed = parseUseClient(args[++i]);
      if (!parsed) {
        return { error: '--client must be cursor, claude, or both' };
      }
      clients = parsed;
    } else if (arg === '--host') {
      host = args[++i] ?? host;
    } else if (arg === '--mcp-port') {
      mcpPort = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg === '--no-mcp') {
      skipMcp = true;
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown use option: ${arg}` };
    } else if (!deckRef) {
      deckRef = arg;
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }

  if (!refresh && !deckRef) {
    return { error: 'deck name or id is required (or pass --refresh)' };
  }

  if (!Number.isFinite(mcpPort)) {
    return { error: '--mcp-port must be a number' };
  }

  return {
    deckRef,
    refresh,
    clients,
    host,
    mcpPort,
    skipMcp,
    workspaceRoot: process.cwd(),
  };
}

function clientsToWrite(target: UseClientTarget): McpClient[] {
  if (target === 'cursor') {
    return ['cursor'];
  }
  if (target === 'claude') {
    return ['claude'];
  }
  return ['cursor', 'claude'];
}

function resolveGrantStoreKind(): 'file' | 'keychain' {
  if (process.env.AGENT_DECK_GRANT_STORE === 'file' || process.env.AGENT_DECK_DEV === '1') {
    return 'file';
  }
  return process.platform === 'darwin' ? 'keychain' : 'file';
}

export async function runUse(parsed: UseOptions): Promise<UseResult | { error: string }> {
  const admin = createCollectionAdmin();

  if (parsed.refresh) {
    const grant = await readWorkspaceGrant(parsed.workspaceRoot);
    const legacy = readUseManifest(parsed.workspaceRoot);
    if (grant) {
      console.log(`Bound deck: ${grant.deckName ?? grant.deckId} (${grant.deckId})`);
      console.log(`Grant: ${grant.grantId} · workspace ${grant.workspaceKey}`);
      console.log('To rotate or change deck, run: agent-deck use <deck>');
      return { error: 'refresh-diagnosis-only' };
    }
    if (legacy) {
      console.log(`Legacy manifest deck: ${legacy.deckName} (${legacy.deckId})`);
      console.log(`Run explicitly: agent-deck use ${legacy.deckName}`);
      return { error: 'refresh-diagnosis-only' };
    }
    console.log('No workspace grant — run: agent-deck use <deck>');
    return { error: 'refresh-diagnosis-only' };
  }

  let deckRef = parsed.deckRef;
  if (!deckRef) {
    return { error: 'deck name or id is required' };
  }

  const deck = await admin.resolveDeck(deckRef);
  if (!deck) {
    return { error: `Deck not found: ${deckRef}` };
  }

  const playbooks = await admin.listDeckPlaybookStubs(deck.id);
  const endpoint = { host: parsed.host, mcpPort: parsed.mcpPort };
  const mcpUrl = buildMcpUrl(endpoint);

  const issued = await issueWorkspaceGrant({
    workspaceRoot: parsed.workspaceRoot,
    deckId: deck.id,
    host: parsed.host,
  });
  if ('error' in issued) {
    return { error: issued.error };
  }

  const storeKind = resolveGrantStoreKind();
  const manifest = toGrantManifest(issued, mcpUrl, storeKind);
  const fileStore = new FileGrantStore(parsed.workspaceRoot);
  const keychainStore =
    storeKind === 'keychain' ? new KeychainGrantStore(parsed.workspaceRoot) : null;

  try {
    await fileStore.stage(manifest);
    if (keychainStore) {
      await keychainStore.stage(manifest);
    }

    const activated = await activateWorkspaceGrant({
      grantId: issued.grantId,
      host: parsed.host,
    });
    if ('error' in activated) {
      throw new Error(activated.error);
    }

    await fileStore.activate();
    if (keychainStore) {
      await keychainStore.activate();
    }
  } catch (error) {
    await revokePendingWorkspaceGrant({ grantId: issued.grantId, host: parsed.host });
    await fileStore.rollback();
    if (keychainStore) {
      await keychainStore.rollback();
    }
    return { error: error instanceof Error ? error.message : 'Grant installation failed' };
  }

  const manifestPath = path.join(parsed.workspaceRoot, '.agent-deck', 'use.json');

  const mcpWritten: Array<{ client: McpClient; path: string }> = [];
  if (!parsed.skipMcp) {
    for (const client of clientsToWrite(parsed.clients)) {
      const configPath = resolveConfigPath(client, 'project', parsed.workspaceRoot);
      const entry = buildAgentDeckEntry(client, endpoint);
      const merged = mergeMcpServerConfig(readJsonFile(configPath), entry);
      writeJsonFile(configPath, merged);
      mcpWritten.push({ client, path: configPath });
    }
  }

  const stubs = syncPlaybookStubs(parsed.workspaceRoot, playbooks, {
    cursor: parsed.clients !== 'claude',
    claude: parsed.clients !== 'cursor',
  });

  return {
    deck,
    mcpUrl,
    manifestPath,
    mcp: mcpWritten,
    stubs,
    playbookCount: playbooks.length,
  };
}

export function formatUseSummary(result: UseResult): string {
  const lines = [
    `Deck "${result.deck.name}" (${result.deck.id})`,
    `Manifest → ${result.manifestPath}`,
    `MCP → ${result.mcpUrl}`,
  ];
  for (const entry of result.mcp) {
    lines.push(`  ${entry.client}: ${entry.path}`);
  }
  lines.push(
    `Stubs: ${result.playbookCount} playbook(s) — cursor +${result.stubs.cursor.created} ~${result.stubs.cursor.updated} -${result.stubs.cursor.removed}; claude +${result.stubs.claude.created} ~${result.stubs.claude.updated} -${result.stubs.claude.removed}`,
  );
  lines.push(`Cursor stubs → ${path.join('.cursor', 'rules', 'agent-deck-stubs')}`);
  lines.push(`Claude stubs → ${path.join('.claude', 'skills', 'agent-deck-<slug>')}`);
  lines.push('Restart the IDE host so MCP and stub discovery reload.');
  return lines.join('\n');
}

export async function runUseCommand(args: string[]): Promise<number> {
  const parsed = parseUseArgs(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      console.log(`Usage:
  agent-deck use <deck> [--client cursor|claude|both] [--host HOST] [--mcp-port PORT] [--no-mcp]
  agent-deck use --refresh

Writes project MCP config (one agent-deck entry), .agent-deck/use.json, and thin playbook trigger stubs.
Bodies stay on the deck — stubs are pointers only.`);
      return 0;
    }
    console.error(parsed.error);
    return 1;
  }

  const result = await runUse(parsed);
  if ('error' in result) {
    if (result.error === 'refresh-diagnosis-only') {
      return 0;
    }
    console.error(result.error);
    return 1;
  }

  console.log(formatUseSummary(result));
  return 0;
}
