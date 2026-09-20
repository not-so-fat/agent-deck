import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type CodexClassification =
  | 'missing'
  | 'disabled'
  | 'compatible'
  | 'version-mismatch'
  | 'legacy-http'
  | 'ambiguous-source';

export type CodexTransport = 'mcp-launch' | 'direct-http' | 'unknown';

export type CodexRunResult = { code: number; stdout: string; stderr: string };
export type CodexRunner = (args: string[]) => Promise<CodexRunResult>;

export const AGENT_DECK_PLUGIN_NAME = 'agent-deck';
export const DEFAULT_PLUGIN_SELECTOR = 'agent-deck@agent-deck';

function codexBin(): string {
  return process.env.CODEX_BIN?.trim() || 'codex';
}

export function runCodexCommand(args: string[]): Promise<CodexRunResult> {
  const bin = codexBin();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      resolve({ code: 127, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

type JsonRecord = Record<string, unknown>;

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    const record = value as JsonRecord;
    for (const key of ['plugins', 'marketplaces', 'items', 'data', 'results']) {
      if (Array.isArray(record[key])) {
        return record[key] as unknown[];
      }
    }
  }
  return [];
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function firstString(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export interface CodexInstalledPlugin {
  name: string;
  version?: string;
  selector: string;
  enabled: boolean;
  marketplace?: string;
  root?: string;
}

export interface CodexMarketplace {
  name: string;
  root?: string;
  source: 'local' | 'git' | 'unknown';
}

function marketplacePart(selector: string): string | undefined {
  const at = selector.indexOf('@');
  if (at <= 0 || at === selector.length - 1) {
    return undefined;
  }
  return selector.slice(at + 1);
}

function parseInstalledPlugin(entry: unknown): CodexInstalledPlugin | null {
  const record = asRecord(entry);
  if (!record) {
    return null;
  }
  const name = firstString(record, ['name', 'plugin', 'id']) ?? '';
  const selectorFromField = firstString(record, ['selector']);
  const marketplace = firstString(record, ['marketplace', 'marketplace_name', 'registry']);
  const selector = selectorFromField ?? (marketplace ? `${name}@${marketplace}` : name);
  if (!name && !selector) {
    return null;
  }
  const rawEnabled = record.enabled ?? record.active ?? record.disabled;
  let enabled = true;
  if (typeof record.enabled === 'boolean') {
    enabled = record.enabled;
  } else if (typeof record.active === 'boolean') {
    enabled = record.active;
  } else if (typeof record.disabled === 'boolean') {
    enabled = !record.disabled;
  } else if (typeof rawEnabled === 'string') {
    enabled = !['false', 'no', 'off', 'disabled'].includes(rawEnabled.toLowerCase());
  }
  return {
    name,
    version: firstString(record, ['version']),
    selector,
    enabled,
    marketplace,
    root: firstString(record, ['install_root', 'root', 'path', 'location', 'dir', 'installRoot']),
  };
}

function parseMarketplace(entry: unknown): CodexMarketplace | null {
  const record = asRecord(entry);
  if (!record) {
    return null;
  }
  const name =
    firstString(record, ['name', 'selector', 'id', 'marketplace', 'marketplace_name']) ?? '';
  if (!name) {
    return null;
  }
  const root = firstString(record, ['root', 'path', 'location', 'dir', 'url']);
  const kindRaw = firstString(record, ['source', 'kind', 'type']) ?? '';
  const urlLike = root !== undefined && /^(https?:|git@|ssh:)/i.test(root);
  const source: CodexMarketplace['source'] =
    /git/i.test(kindRaw) || (/^(https?:|git@|ssh:)/i.test(kindRaw) && kindRaw.length > 0) || urlLike
      ? 'git'
      : /local|path|dir|file/i.test(kindRaw) || (root !== undefined && !urlLike)
        ? 'local'
        : 'unknown';
  return { name, root, source };
}

function isAgentDeckPlugin(plugin: CodexInstalledPlugin): boolean {
  if (plugin.name === AGENT_DECK_PLUGIN_NAME) {
    return true;
  }
  if (plugin.selector === DEFAULT_PLUGIN_SELECTOR || plugin.selector.startsWith('agent-deck@')) {
    return true;
  }
  return plugin.name.endsWith('/agent-deck');
}

export interface CodexPluginState {
  available: boolean;
  error?: string;
  cliVersion: string;
  installed: CodexInstalledPlugin[];
  marketplaces: CodexMarketplace[];
  classification?: CodexClassification;
  installedVersion?: string;
  selector?: string;
  root?: string;
  marketplaceName?: string;
  sourceKind?: 'local' | 'git' | 'unknown';
  transport: CodexTransport;
}

function readTransport(root: string | undefined): CodexTransport {
  if (!root) {
    return 'unknown';
  }
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
  } catch {
    return 'unknown';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unknown';
  }
  const record = asRecord(parsed);
  const servers = record ? asRecord(record.mcpServers) : null;
  const entry = servers ? asRecord(servers[AGENT_DECK_PLUGIN_NAME]) : null;
  if (!entry) {
    return 'unknown';
  }
  const command = asString(entry.command) ?? '';
  const args = Array.isArray(entry.args)
    ? (entry.args as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  if (command === 'agent-deck' && args.includes('mcp-launch')) {
    return 'mcp-launch';
  }
  const type = asString(entry.type) ?? '';
  const url = asString(entry.url) ?? '';
  if (type === 'http' || /^https?:/i.test(url)) {
    return 'direct-http';
  }
  return 'unknown';
}

export async function inspectCodexPlugin(
  cliVersion: string,
  runner: CodexRunner = runCodexCommand,
): Promise<CodexPluginState> {
  const base: CodexPluginState = {
    available: true,
    cliVersion,
    installed: [],
    marketplaces: [],
    transport: 'unknown',
  };

  let listOut: CodexRunResult;
  try {
    listOut = await runner(['plugin', 'list', '--available', '--json']);
  } catch (error) {
    return {
      ...base,
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (listOut.code !== 0) {
    const missing =
      listOut.code === 127 ||
      /not found|no such file|ENOENT|command not found/i.test(`${listOut.stderr} ${listOut.stdout}`);
    return { ...base, available: !missing ? true : false, error: missing ? 'codex CLI not found' : (listOut.stderr.trim() || listOut.stdout.trim() || `codex exited with code ${listOut.code}`) };
  }

  let marketplaceOut: CodexRunResult;
  try {
    marketplaceOut = await runner(['plugin', 'marketplace', 'list', '--json']);
  } catch (error) {
    return {
      ...base,
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let pluginEntries: unknown[];
  try {
    pluginEntries = asArray(JSON.parse(listOut.stdout));
  } catch {
    return { ...base, error: `could not parse \`codex plugin list --available --json\` output as JSON` };
  }
  const installedAll = pluginEntries
    .map(parseInstalledPlugin)
    .filter((p): p is CodexInstalledPlugin => p !== null);
  const installed = installedAll.filter(isAgentDeckPlugin);

  let marketplaceEntries: unknown[] = [];
  if (marketplaceOut.code === 0) {
    try {
      marketplaceEntries = asArray(JSON.parse(marketplaceOut.stdout));
    } catch {
      return { ...base, installed, error: `could not parse \`codex plugin marketplace list --json\` output as JSON` };
    }
  }
  const marketplaces = marketplaceEntries
    .map(parseMarketplace)
    .filter((m): m is CodexMarketplace => m !== null);

  if (installed.length === 0) {
    return { ...base, installed, marketplaces, classification: 'missing' };
  }

  const first = installed[0] as CodexInstalledPlugin;
  if (!first.enabled) {
    return {
      ...base,
      installed,
      marketplaces,
      classification: 'disabled',
      installedVersion: first.version,
      selector: first.selector,
      root: first.root,
      transport: readTransport(first.root),
    };
  }

  const selectors = [...new Set(installed.map((p) => p.selector))];
  const selector = selectors.length === 1 ? (selectors[0] as string) : undefined;
  const part = selector ? marketplacePart(selector) : undefined;

  const supplying =
    selector === undefined
      ? []
      : marketplaces.filter((m) => {
          if (part && (m.name === part || m.name === selector)) {
            return true;
          }
          const roots = installed.map((p) => p.root).filter(Boolean) as string[];
          return m.root !== undefined && roots.includes(m.root);
        });

  const distinctRoots = [...new Set(installed.map((p) => p.root).filter(Boolean))] as string[];
  const ambiguous = selectors.length > 1 || supplying.length > 1 || distinctRoots.length > 1;
  if (ambiguous) {
    return {
      ...base,
      installed,
      marketplaces,
      classification: 'ambiguous-source',
      installedVersion: first.version,
      selector,
      root: distinctRoots.length === 1 ? distinctRoots[0] : first.root,
      transport: readTransport(distinctRoots.length === 1 ? distinctRoots[0] : first.root),
    };
  }

  const resolvedMarketplace = supplying.length === 1 ? (supplying[0] as CodexMarketplace) : undefined;
  const root = first.root ?? resolvedMarketplace?.root;
  const marketplaceName = part ?? resolvedMarketplace?.name ?? first.marketplace;
  const sourceKind = resolvedMarketplace?.source ?? 'unknown';
  const transport = readTransport(root);

  if (transport === 'direct-http') {
    return {
      ...base,
      installed,
      marketplaces,
      classification: 'legacy-http',
      installedVersion: first.version,
      selector,
      root,
      marketplaceName,
      sourceKind,
      transport,
    };
  }

  if (first.version !== cliVersion) {
    return {
      ...base,
      installed,
      marketplaces,
      classification: 'version-mismatch',
      installedVersion: first.version,
      selector,
      root,
      marketplaceName,
      sourceKind,
      transport,
    };
  }

  return {
    ...base,
    installed,
    marketplaces,
    classification: 'compatible',
    installedVersion: first.version,
    selector,
    root,
    marketplaceName,
    sourceKind,
    transport,
  };
}

export function manualCodexCommands(selector: string): string[] {
  return [`codex plugin remove ${selector}`, `codex plugin add ${selector}`];
}

export function remediationLine(selector: string): string {
  return `codex plugin remove ${selector} && codex plugin add ${selector}`;
}

function printManualSyncBlock(selector: string, marketplaceName?: string): void {
  console.log('To sync the plugin manually, run:');
  if (marketplaceName) {
    console.log(`  codex plugin marketplace upgrade ${marketplaceName}`);
  }
  for (const command of manualCodexCommands(selector)) {
    console.log(`  ${command}`);
  }
}

/**
 * Reconcile the installed Agent Deck plugin after a successful CLI upgrade.
 *
 * Only acts when exactly one installed selector and one source root resolve.
 * For a Git marketplace the marketplace is refreshed first. Reinstalls through
 * supported `codex plugin remove` / `codex plugin add` commands, then
 * re-reads plugin state. Never edits Codex files directly: every failure path
 * prints `CLI upgrade complete; Codex plugin unchanged` (or the reconciled
 * state) plus the exact manual Codex commands, and returns 1.
 */
export async function reconcileCodexPluginAfterUpgrade(
  expectedVersion: string,
  runner: CodexRunner = runCodexCommand,
): Promise<number> {
  const state = await inspectCodexPlugin(expectedVersion, runner);
  const selector = state.selector ?? DEFAULT_PLUGIN_SELECTOR;

  if (!state.available) {
    console.log('CLI upgrade complete; Codex plugin unchanged (codex CLI not found).');
    printManualSyncBlock(selector);
    return 1;
  }
  if (state.error && !state.classification) {
    console.log(`CLI upgrade complete; Codex plugin unchanged (${state.error}).`);
    printManualSyncBlock(selector);
    return 1;
  }

  if (state.classification === 'compatible') {
    const transport = state.transport === 'unknown' ? 'mcp-launch' : state.transport;
    console.log(`Codex plugin: OK (${state.installedVersion ?? expectedVersion}, ${transport})`);
    return 0;
  }

  if (state.classification === 'missing') {
    console.log('CLI upgrade complete; Codex plugin unchanged (plugin not installed).');
    printManualSyncBlock(selector);
    return 1;
  }

  if (state.classification === 'ambiguous-source' || !state.selector || !state.root) {
    console.log(
      'CLI upgrade complete; Codex plugin unchanged (multiple sources could supply the installed plugin).',
    );
    printManualSyncBlock(selector, state.marketplaceName);
    console.log('See: codex plugin list --available --json');
    return 1;
  }

  const targetSelector = state.selector;
  const marketplaceName = state.marketplaceName;

  if (state.sourceKind === 'git' && marketplaceName) {
    const refreshed = await runner(['plugin', 'marketplace', 'upgrade', marketplaceName]);
    if (refreshed.code !== 0) {
      console.log(
        `CLI upgrade complete; Codex plugin unchanged (marketplace refresh failed: ${(refreshed.stderr.trim() || refreshed.stdout.trim() || `exit ${refreshed.code}`)}).`,
      );
      printManualSyncBlock(targetSelector, marketplaceName);
      return 1;
    }
  }

  const removed = await runner(['plugin', 'remove', targetSelector]);
  if (removed.code !== 0) {
    console.log(
      `CLI upgrade complete; Codex plugin unchanged (remove failed: ${(removed.stderr.trim() || removed.stdout.trim() || `exit ${removed.code}`)}).`,
    );
    printManualSyncBlock(targetSelector, marketplaceName);
    return 1;
  }

  const added = await runner(['plugin', 'add', targetSelector]);
  if (added.code !== 0) {
    console.log(
      `CLI upgrade complete; Codex plugin unchanged (add failed: ${(added.stderr.trim() || added.stdout.trim() || `exit ${added.code}`)}).`,
    );
    printManualSyncBlock(targetSelector, marketplaceName);
    return 1;
  }

  const reread = await inspectCodexPlugin(expectedVersion, runner);
  if (reread.classification === 'compatible') {
    const transport = reread.transport === 'unknown' ? 'mcp-launch' : reread.transport;
    console.log(`Codex plugin: OK (${reread.installedVersion ?? expectedVersion}, ${transport})`);
    return 0;
  }

  console.log(
    `CLI upgrade complete; Codex plugin still ${reread.classification ?? 'unreadable'} (installed ${reread.installedVersion ?? '(unknown)'}, expected ${expectedVersion}).`,
  );
  printManualSyncBlock(targetSelector, marketplaceName);
  return 1;
}

/**
 * Read-only `doctor` section for the Codex plugin. Never mutates Codex state:
 * it only runs `codex plugin list` / `codex plugin marketplace list` and reads
 * the installed plugin's bundled `.mcp.json`. Returns 0 when the plugin is
 * compatible (or Codex is entirely absent / no plugin installed — those are
 * warnings for non-Codex users), 1 when the installed plugin is stale,
 * disabled, ambiguous, or unreadable.
 */
export async function runCodexPluginDoctor(
  cliVersion: string,
  runner: CodexRunner = runCodexCommand,
): Promise<number> {
  const state = await inspectCodexPlugin(cliVersion, runner);

  if (!state.available) {
    console.log('WARN: Codex CLI not found (Codex plugin check skipped)');
    return 0;
  }
  if (state.error && !state.classification) {
    console.error(`FAIL: Codex plugin state unreadable (${state.error})`);
    console.log('Run: codex plugin list --available --json');
    return 1;
  }

  switch (state.classification) {
    case 'compatible': {
      const transport = state.transport === 'unknown' ? 'mcp-launch' : state.transport;
      console.log(`Codex plugin: OK (${state.installedVersion ?? cliVersion}, ${transport})`);
      return 0;
    }
    case 'missing': {
      console.log('WARN: Codex plugin not installed (expected agent-deck@agent-deck)');
      console.log(`Run: codex plugin add ${DEFAULT_PLUGIN_SELECTOR}`);
      return 0;
    }
    case 'disabled':
    case 'version-mismatch':
    case 'legacy-http':
    case 'ambiguous-source': {
      const selector = state.selector ?? DEFAULT_PLUGIN_SELECTOR;
      const root = state.root ?? '(unknown)';
      const source = state.sourceKind ?? 'unknown';
      console.log(
        `Codex plugin: ${state.classification} (installed ${state.installedVersion ?? '(unknown)'}, expected ${cliVersion})`,
      );
      console.log(`Selector: ${selector}`);
      console.log(`Marketplace root: ${root} (${source})`);
      console.log(`Transport: ${state.transport}`);
      console.log(`Remediation: ${remediationLine(selector)}`);
      console.error(
        `FAIL: Codex plugin ${state.classification} (installed ${state.installedVersion ?? '(unknown)'}, expected ${cliVersion})`,
      );
      return 1;
    }
    default: {
      console.error(`FAIL: Codex plugin state unreadable (${state.error ?? 'unknown error'})`);
      return 1;
    }
  }
}
