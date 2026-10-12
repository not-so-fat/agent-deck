import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpLaunchPlan } from './mcp-launcher';
import {
  RUN_EDIT_TOOLS,
  RUN_READONLY_TOOLS,
  runRunCommand,
  type RunDeps,
  type RunQueryMessage,
} from './run';

const DECK = { id: 'deck-planner', name: 'planner' };
const EXPECTED_READONLY = [
  'mcp__agent-deck__*',
  'Read',
  'Glob',
  'Grep',
  'Bash(git log:*)',
  'Bash(git status:*)',
  'Bash(ls:*)',
];
const EXPECTED_EDIT = [
  ...EXPECTED_READONLY,
  'Edit',
  'Write',
  'Bash(git diff:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git checkout -b:*)',
];

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

function setup(): { cwd: string; deps: RunDeps & { query: ReturnType<typeof vi.fn> } } {
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
    resolveDeck: vi.fn(async () => ({ ...DECK })),
    resolveLaunchPlan: vi.fn(async () => plan) as unknown as RunDeps['resolveLaunchPlan'],
    claudeProbe: vi.fn(async () => ({ ok: true as const })),
    homeDir,
  };
  return { cwd, deps };
}

function argsFor(cwd: string, extra: string[] = []): string[] {
  return ['planner', '--client', 'claude', '--cwd', cwd, '--prompt', 'brief', ...extra];
}

function queryOptions(deps: { query: ReturnType<typeof vi.fn> }): {
  allowedTools: string[];
  permissionMode: string;
  settingSources: string[];
  resume?: string;
} {
  return (deps.query.mock.calls[0][0] as { options: never }).options as {
    allowedTools: string[];
    permissionMode: string;
    settingSources: string[];
    resume?: string;
  };
}

describe('run tool profiles (NOT-400)', () => {
  it('default (no --tools flag) passes exactly the readonly allowlist', async () => {
    const { cwd, deps } = setup();

    expect(await runRunCommand(argsFor(cwd), deps)).toBe(0);

    const options = queryOptions(deps);
    expect(options.allowedTools).toEqual(EXPECTED_READONLY);
    expect(options.allowedTools).not.toContain('Edit');
    expect(options.allowedTools).not.toContain('Write');
    expect(options.allowedTools).not.toContain('Bash');
  });

  it('--tools readonly passes exactly the readonly allowlist', async () => {
    const { cwd, deps } = setup();

    expect(await runRunCommand(argsFor(cwd, ['--tools', 'readonly']), deps)).toBe(0);

    expect(queryOptions(deps).allowedTools).toEqual(EXPECTED_READONLY);
  });

  it('--tools edit passes readonly plus the edit set', async () => {
    const { cwd, deps } = setup();

    expect(await runRunCommand(argsFor(cwd, ['--tools', 'edit']), deps)).toBe(0);

    expect(queryOptions(deps).allowedTools).toEqual(EXPECTED_EDIT);
  });

  it('unknown --tools value exits non-zero before any query() call', async () => {
    const { cwd, deps } = setup();

    const code = await runRunCommand(argsFor(cwd, ['--tools', 'admin']), deps);

    expect(code).not.toBe(0);
    expect(deps.query).not.toHaveBeenCalled();
    expect(errors.join('\n')).toMatch(/readonly, edit/);
  });

  it.each(['readonly', 'edit'] as const)(
    '--tools %s uses permissionMode acceptEdits and never bypassPermissions',
    async (profile) => {
      const { cwd, deps } = setup();

      expect(await runRunCommand(argsFor(cwd, ['--tools', profile]), deps)).toBe(0);

      const options = queryOptions(deps);
      expect(options.permissionMode).toBe('acceptEdits');
      expect(JSON.stringify(options)).not.toContain('bypassPermissions');
    },
  );

  it('both profiles use settingSources project+user', async () => {
    for (const profile of ['readonly', 'edit'] as const) {
      const { cwd, deps } = setup();
      expect(await runRunCommand(argsFor(cwd, ['--tools', profile]), deps)).toBe(0);
      expect(queryOptions(deps).settingSources).toEqual(['project', 'user']);
    }
  });

  it('neither profile allows unscoped Bash, git push, or network tools', () => {
    for (const tools of [RUN_READONLY_TOOLS, RUN_EDIT_TOOLS]) {
      expect(tools).not.toContain('Bash');
      for (const entry of tools) {
        if (entry.startsWith('Bash')) {
          expect(entry).toMatch(/^Bash\(.+\)$/);
        }
        expect(entry).not.toMatch(/push/i);
        expect(entry).not.toMatch(/^Web/);
      }
    }
    expect(RUN_READONLY_TOOLS).toEqual(EXPECTED_READONLY);
    expect(RUN_EDIT_TOOLS).toEqual(EXPECTED_EDIT);
  });

  it('--resume uses the profile passed on that invocation (default readonly)', async () => {
    const resumed = setup();
    expect(
      await runRunCommand(argsFor(resumed.cwd, ['--resume', 'ses_old']), resumed.deps),
    ).toBe(0);
    expect(queryOptions(resumed.deps).allowedTools).toEqual(EXPECTED_READONLY);
    expect(queryOptions(resumed.deps).resume).toBe('ses_old');

    const resumedEdit = setup();
    expect(
      await runRunCommand(
        argsFor(resumedEdit.cwd, ['--resume', 'ses_old', '--tools', 'edit']),
        resumedEdit.deps,
      ),
    ).toBe(0);
    expect(queryOptions(resumedEdit.deps).allowedTools).toEqual(EXPECTED_EDIT);
  });
});
