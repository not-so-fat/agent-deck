import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpLaunchPlan } from './mcp-launcher';
import {
  claudeAllowedToolsForProfile,
  claudeDenyRulesForProfile,
  createRunAdapter,
  type RunCanUseTool,
  type RunWorkerSettings,
} from '@agent-deck/backend/agent-run';
import { runRunCommand, type RunDeps, type RunQueryMessage } from './run';

const DECK = { id: 'deck-planner', name: 'planner' };

const tmpDirs: string[] = [];
let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    errors.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function setup(): { cwd: string; homeDir: string; deps: RunDeps & { query: ReturnType<typeof vi.fn> } } {
  const cwd = makeDir('agent-deck-run-tools-cwd-');
  const homeDir = makeDir('agent-deck-run-tools-home-');
  const messages: RunQueryMessage[] = [
    { type: 'result', subtype: 'success', session_id: 'ses_tools', result: 'ok' },
  ];
  const query = vi.fn(async function* (): AsyncGenerator<RunQueryMessage> {
    yield* messages;
  });
  const plan: McpLaunchPlan = {
    workspaceRoot: cwd,
    mcpUrl: 'http://127.0.0.1:1110/mcp',
    deckId: DECK.id,
    deckName: DECK.name,
    headers: [],
  };
  const deps: RunDeps & { query: ReturnType<typeof vi.fn> } = {
    query,
    // Real adapter behavior with the NOT-669 gate bypassed: these tests
    // exercise tool-profile mapping, not the sibling-ticket mapping.
    createAdapter: (client) => ({
      ...createRunAdapter(client, { claude: { query } }),
      profileEnforcement: () => ({ ok: true as const }),
    }),
    resolveDeck: vi.fn(async () => ({ ...DECK })),
    resolveLaunchPlan: vi.fn(async () => plan) as unknown as RunDeps['resolveLaunchPlan'],
    claudeProbe: vi.fn(async () => ({ ok: true as const })),
    homeDir,
  };
  return { cwd, homeDir, deps };
}

function argsFor(cwd: string, extra: string[] = []): string[] {
  return ['planner', '--client', 'claude', '--cwd', cwd, '--prompt', 'brief', ...extra];
}

type QueryOptionsShape = {
  allowedTools: string[];
  disallowedTools: string[];
  skills: string[];
  permissionMode: string;
  settingSources: string[];
  settings: RunWorkerSettings;
  additionalDirectories: string[];
  canUseTool: RunCanUseTool;
  strictMcpConfig: boolean;
  mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
  resume?: string;
};

function queryOptions(deps: { query: ReturnType<typeof vi.fn> }, call = 0): QueryOptionsShape {
  return (deps.query.mock.calls[call][0] as { options: never }).options as QueryOptionsShape;
}

describe('run tool profiles (NOT-400, NOT-672)', () => {
  it('default (no --tools flag) passes exactly the readonly worker list', async () => {
    const { cwd, deps } = setup();

    expect(await runRunCommand(argsFor(cwd), deps)).toBe(0);

    const options = queryOptions(deps);
    expect(options.allowedTools).toEqual([...claudeAllowedToolsForProfile('readonly')]);
    expect(options.allowedTools).toContain('Read');
    expect(options.allowedTools).toContain('WebFetch');
    expect(options.allowedTools).toContain('Bash(git log:*)');
    expect(options.allowedTools).toContain('mcp__agent-deck__get_run');
    expect(options.allowedTools).not.toContain('Edit');
    expect(options.allowedTools).not.toContain('Write');
    expect(options.allowedTools).not.toContain('Bash');
    expect(options.allowedTools).not.toContain('mcp__agent-deck__switch_deck');
  });

  it('--tools edit passes the edit worker list with writes and full shell', async () => {
    const { cwd, deps } = setup();

    expect(await runRunCommand(argsFor(cwd, ['--tools', 'edit']), deps)).toBe(0);

    const options = queryOptions(deps);
    expect(options.allowedTools).toEqual([...claudeAllowedToolsForProfile('edit')]);
    expect(options.allowedTools).toContain('Edit');
    expect(options.allowedTools).toContain('Write');
    expect(options.allowedTools).toContain('Bash');
    expect(options.allowedTools).toContain('Monitor');
    expect(options.allowedTools).toContain('mcp__agent-deck__bind_workspace');
    expect(options.allowedTools).not.toContain('mcp__agent-deck__switch_deck');
  });

  it('unknown --tools value exits non-zero before any query() call', async () => {
    const { cwd, deps } = setup();

    const code = await runRunCommand(argsFor(cwd, ['--tools', 'admin']), deps);

    expect(code).not.toBe(0);
    expect(deps.query).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/readonly, edit/);
  });

  it.each(['readonly', 'edit'] as const)(
    '--tools %s uses permissionMode dontAsk and never bypassPermissions',
    async (profile) => {
      const { cwd, deps } = setup();

      expect(await runRunCommand(argsFor(cwd, ['--tools', profile]), deps)).toBe(0);

      const options = queryOptions(deps);
      expect(options.permissionMode).toBe('dontAsk');
      expect(JSON.stringify({ ...options, canUseTool: undefined })).not.toContain('bypassPermissions');
    },
  );

  it('both profiles isolate settings, forbid skills, and carry explicit rules', async () => {
    for (const profile of ['readonly', 'edit'] as const) {
      const { cwd, deps } = setup();
      expect(await runRunCommand(argsFor(cwd, ['--tools', profile]), deps)).toBe(0);
      const options = queryOptions(deps);
      expect(options.settingSources).toEqual([]);
      expect(options.skills).toEqual([]);
      expect(options.disallowedTools).toEqual([]);
      expect(options.settings.permissions.allow).toEqual([...claudeAllowedToolsForProfile(profile)]);
      expect(options.settings.permissions.deny).toEqual([...claudeDenyRulesForProfile(profile)]);
      expect(options.settings.permissions.ask).toEqual([]);
      expect(options.settings.permissions.defaultMode).toBe('dontAsk');
      expect(options.settings.permissions.additionalDirectories).toHaveLength(2);
      expect(options.additionalDirectories).toEqual(options.settings.permissions.additionalDirectories);
    }
  });

  it('both profiles connect exactly the inline worker MCP server', async () => {
    for (const profile of ['readonly', 'edit'] as const) {
      const { cwd, deps } = setup();
      expect(await runRunCommand(argsFor(cwd, ['--tools', profile]), deps)).toBe(0);
      const options = queryOptions(deps);
      expect(options.strictMcpConfig).toBe(true);
      expect(Object.keys(options.mcpServers)).toEqual(['agent-deck']);
      expect(options.mcpServers['agent-deck'].headers['x-agent-deck-workspace']).toBe(cwd);
      expect(options.mcpServers['agent-deck'].headers['x-agent-deck-run-token']).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('the canUseTool handler enforces the profile outside prompt instructions', async () => {
    const readonly = setup();
    expect(await runRunCommand(argsFor(readonly.cwd), readonly.deps)).toBe(0);
    const readonlyGate = queryOptions(readonly.deps).canUseTool;
    expect(typeof readonlyGate).toBe('function');
    expect(await readonlyGate('Read', { file_path: '/work/a.ts' })).toMatchObject({ behavior: 'allow' });
    expect(await readonlyGate('WebFetch', { url: 'http://127.0.0.1:9/x', prompt: 'summarize' })).toMatchObject({
      behavior: 'allow',
    });
    expect(await readonlyGate('Bash', { command: 'ls -la' })).toMatchObject({ behavior: 'allow' });
    expect(await readonlyGate('Bash', { command: 'git status' })).toMatchObject({
      behavior: 'allow',
      updatedInput: expect.objectContaining({ command: expect.stringContaining('--no-pager') }),
    });
    expect(await readonlyGate('Bash', { command: 'curl -X POST http://127.0.0.1:9/x' })).toMatchObject({
      behavior: 'deny',
    });
    expect(await readonlyGate('Bash', { command: 'python3 -c "print(1)"' })).toMatchObject({ behavior: 'deny' });
    expect(await readonlyGate('Edit', { file_path: '/work/a.ts' })).toMatchObject({ behavior: 'deny' });
    expect(await readonlyGate('Monitor', { description: 'watch', timeout_ms: 1000 })).toMatchObject({ behavior: 'deny' });
    expect(await readonlyGate('mcp__agent-deck__get_run', {})).toMatchObject({ behavior: 'allow' });
    expect(await readonlyGate('mcp__agent-deck__switch_deck', {})).toMatchObject({ behavior: 'deny' });

    const edit = setup();
    expect(await runRunCommand(argsFor(edit.cwd, ['--tools', 'edit']), edit.deps)).toBe(0);
    const editGate = queryOptions(edit.deps).canUseTool;
    expect(await editGate('Bash', { command: 'rm -rf /tmp/scratch' })).toMatchObject({ behavior: 'allow' });
    expect(await editGate('Edit', { file_path: `${edit.cwd}/a.ts` })).toMatchObject({ behavior: 'allow' });
    expect(await editGate('Edit', { file_path: '/etc/hostname' })).toMatchObject({ behavior: 'deny' });
    expect(await editGate('Monitor', { description: 'watch', timeout_ms: 1000 })).toMatchObject({ behavior: 'allow' });
    expect(await editGate('mcp__agent-deck__start_run', {})).toMatchObject({ behavior: 'deny' });
    expect(await editGate('AskUserQuestion', { questions: [] })).toMatchObject({ behavior: 'deny' });
  });

  it('--resume continues only a same-profile session the host started', async () => {
    const { cwd, deps } = setup();
    expect(await runRunCommand(argsFor(cwd), deps)).toBe(0);
    expect(queryOptions(deps, 0).resume).toBeUndefined();

    // Same profile, proven origin: resumes with the readonly list.
    expect(await runRunCommand(argsFor(cwd, ['--resume', 'ses_tools']), deps)).toBe(0);
    expect(queryOptions(deps, 1).allowedTools).toEqual([...claudeAllowedToolsForProfile('readonly')]);
    expect(queryOptions(deps, 1).resume).toBe('ses_tools');
    expect(queryOptions(deps, 1).permissionMode).toBe('dontAsk');

    // Cross-profile and unknown sessions fail closed before any query.
    const before = deps.query.mock.calls.length;
    expect(await runRunCommand(argsFor(cwd, ['--resume', 'ses_tools', '--tools', 'edit']), deps)).not.toBe(0);
    expect(await runRunCommand(argsFor(cwd, ['--resume', 'ses_other']), deps)).not.toBe(0);
    expect(deps.query.mock.calls.length).toBe(before);
    expect(errors.join('\n')).toMatch(/started it with --tools readonly/);
    expect(errors.join('\n')).toMatch(/no Agent Deck run on this host started it/);
  });
});
