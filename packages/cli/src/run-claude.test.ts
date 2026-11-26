/**
 * Claude adapter tests (NOT-672): worker-profile options, the canUseTool
 * gate, client-reported denial mapping, and resume provenance.
 *
 * The SDK never loads here: every test injects a fake `query()` and asserts
 * the options the adapter passes plus the normalized events it yields.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpLaunchPlan } from './mcp-launcher';
import {
  claudeAllowedToolsForProfile,
  createClaudeAdapter,
  createRunAdapter,
  type NormalizedEvent,
  type RunQueryFn,
  type RunQueryMessage,
  type RunQueryOptions,
} from '@agent-deck/backend/agent-run';
import { runRunCommand, type RunDeps } from './run';

const DECK = { id: 'deck-planner', name: 'planner' };

const tmpDirs: string[] = [];
let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
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

function matchingPlan(cwd: string): McpLaunchPlan {
  return {
    workspaceRoot: cwd,
    mcpUrl: 'http://127.0.0.1:1110/mcp',
    deckId: DECK.id,
    deckName: DECK.name,
    headers: [],
  };
}

function fakeQuery(messages: RunQueryMessage[]): {
  query: RunQueryFn & ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async function* (): AsyncGenerator<RunQueryMessage> {
    yield* messages;
  });
  return { query: query as unknown as RunQueryFn & ReturnType<typeof vi.fn> };
}

function successMessages(sessionId: string): RunQueryMessage[] {
  return [
    {
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: 'done' }] },
    },
    { type: 'result', subtype: 'success', session_id: sessionId, result: 'done' },
  ];
}

describe('claude worker options (NOT-672)', () => {
  it('passes isolation, dontAsk, explicit lists, settings, and the gate on start and resume', async () => {
    const seen: RunQueryOptions[] = [];
    const adapter = createClaudeAdapter({
      query: (params) => {
        seen.push(params.options);
        return (async function* () {
          yield* successMessages('ses_1');
        })();
      },
      homeDir: '/home/agent',
      tmpDir: '/tmp',
    });

    for await (const _event of adapter.start({ cwd: '/work', prompt: 'hi', tools: 'readonly' })) {
      // Drain.
    }
    for await (const _event of adapter.start({
      cwd: '/work',
      prompt: 'again',
      tools: 'edit',
      resumeId: 'ses_1',
      resumedFrom: { runId: 'run-1', sessionId: 'ses_1', tools: 'edit' },
    })) {
      // Drain.
    }

    expect(seen).toHaveLength(2);
    expect(seen[0].allowedTools).toEqual([...claudeAllowedToolsForProfile('readonly')]);
    expect(seen[1].allowedTools).toEqual([...claudeAllowedToolsForProfile('edit')]);
    for (const options of seen) {
      expect(options.settingSources).toEqual([]);
      expect(options.permissionMode).toBe('dontAsk');
      expect(options.disallowedTools).toEqual([]);
      expect(options.skills).toEqual([]);
      expect(options.settings?.permissions.ask).toEqual([]);
      expect(options.settings?.permissions.defaultMode).toBe('dontAsk');
      expect(options.additionalDirectories).toEqual(['/home/agent', '/tmp']);
      expect(typeof options.canUseTool).toBe('function');
      expect(options.strictMcpConfig).toBe(true);
      expect(Object.keys(options.mcpServers ?? {})).toEqual(['agent-deck']);
    }
    expect(seen[0].resume).toBeUndefined();
    expect(seen[1].resume).toBe('ses_1');
    // The resume re-applies the requested profile's full options.
    expect(seen[1].settings?.permissions.allow).toEqual([...claudeAllowedToolsForProfile('edit')]);
  });

  it('the adapter rejects resume without trusted same-profile provenance', () => {
    const adapter = createClaudeAdapter({ query: fakeQuery([]).query });
    const missing = adapter.planStart({ cwd: '/w', prompt: 'p', tools: 'readonly', resumeId: 'ses_x' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.remedy).toMatch(/no trusted Agent Deck run is known to have started it/);
    }
    const mismatched = adapter.planStart({
      cwd: '/w',
      prompt: 'p',
      tools: 'edit',
      resumeId: 'ses_x',
      resumedFrom: { runId: 'run-1', sessionId: 'ses_x', tools: 'readonly' },
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) {
      expect(mismatched.remedy).toMatch(/started it with --tools readonly/);
    }
    expect(
      adapter.planStart({
        cwd: '/w',
        prompt: 'p',
        tools: 'readonly',
        resumeId: 'ses_x',
        resumedFrom: { runId: 'run-1', sessionId: 'ses_x', tools: 'readonly' },
      }),
    ).toEqual({ ok: true, trustOverride: false });

    // The enforcement gate re-checks behind planStart; starts pass.
    expect(adapter.profileEnforcement({ cwd: '/w', prompt: 'p', tools: 'readonly' })).toEqual({ ok: true });
    expect(
      adapter.profileEnforcement({ cwd: '/w', prompt: 'p', tools: 'readonly', resumeId: 'ses_x' }).ok,
    ).toBe(false);
  });

  it('a resume yields a notice naming the origin run and the re-applied profile', async () => {
    const adapter = createClaudeAdapter({ query: fakeQuery(successMessages('ses_1')).query });
    const events: NormalizedEvent[] = [];
    for await (const event of adapter.start({
      cwd: '/work',
      prompt: 'again',
      tools: 'edit',
      resumeId: 'ses_1',
      resumedFrom: { runId: 'run-9', sessionId: 'ses_1', tools: 'edit' },
    })) {
      events.push(event);
    }
    expect(events[0]).toMatchObject({ kind: 'notice', sessionId: 'ses_1' });
    expect((events[0] as { message?: string }).message).toContain('started by run run-9');
    expect((events[0] as { message?: string }).message).toContain('--tools edit');
  });
});

describe('claude denial mapping (NOT-672)', () => {
  async function drain(
    messages: RunQueryMessage[],
    tools: 'readonly' | 'edit' = 'readonly',
  ): Promise<NormalizedEvent[]> {
    const adapter = createClaudeAdapter({ query: fakeQuery(messages).query });
    const events: NormalizedEvent[] = [];
    for await (const event of adapter.start({ cwd: '/work', prompt: 'hi', tools })) {
      events.push(event);
    }
    return events;
  }

  it('maps permission_denied frames to denial events with kinds', async () => {
    const events = await drain([
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'call_1',
        decision_reason: 'rule',
        message: 'Bash("rm -rf /tmp/x") was denied by a deny rule',
        session_id: 'ses_1',
      },
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Edit',
        tool_use_id: 'call_2',
        message: 'Edit was denied',
        session_id: 'ses_1',
      },
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'mcp__agent-deck__switch_deck',
        tool_use_id: 'call_3',
        session_id: 'ses_1',
      },
      ...successMessages('ses_1'),
    ]);

    expect(events.filter((event) => event.kind === 'denial')).toEqual([
      {
        kind: 'denial',
        target: 'Bash',
        reason: 'rule',
        denialKind: 'shell',
        sessionId: 'ses_1',
      },
      {
        kind: 'denial',
        target: 'Edit',
        reason: 'Edit was denied',
        denialKind: 'file_write',
        sessionId: 'ses_1',
      },
      {
        kind: 'denial',
        target: 'mcp__agent-deck__switch_deck',
        reason: 'worker profile "readonly" denied mcp__agent-deck__switch_deck',
        denialKind: 'client_tool',
        sessionId: 'ses_1',
      },
    ]);
    // The run still completes: denials are status, not failures.
    expect(events.at(-1)).toMatchObject({ kind: 'result', subtype: 'success' });
  });

  it('maps result.permission_denials and dedupes repeats by tool_use_id', async () => {
    const events = await drain([
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Monitor',
        tool_use_id: 'call_9',
        session_id: 'ses_1',
      } as RunQueryMessage,
      {
        type: 'result',
        subtype: 'success',
        session_id: 'ses_1',
        result: 'done',
        permission_denials: [
          { tool_name: 'Monitor', tool_use_id: 'call_9' },
          { tool_name: 'Write', tool_use_id: 'call_10' },
        ],
      },
    ]);

    const denials = events.filter((event) => event.kind === 'denial');
    expect(denials).toHaveLength(2);
    expect(denials[0]).toMatchObject({ target: 'Monitor', denialKind: 'client_tool', sessionId: 'ses_1' });
    expect(denials[1]).toMatchObject({ target: 'Write', denialKind: 'file_write', sessionId: 'ses_1' });
  });

  it('records client denials on the run with the effective profile end to end', async () => {
    const cwd = makeDir('agent-deck-claude-cwd-');
    const homeDir = makeDir('agent-deck-claude-home-');
    const { query } = fakeQuery([
      {
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'call_1',
        message: 'denied',
        session_id: 'ses_deny',
      } as RunQueryMessage,
      {
        type: 'result',
        subtype: 'success',
        session_id: 'ses_deny',
        result: 'done with refusals',
        permission_denials: [{ tool_name: 'Edit', tool_use_id: 'call_2' }],
      },
    ]);
    const deps: RunDeps = {
      query,
      createAdapter: (client) => ({
        ...createRunAdapter(client, { claude: { query } }),
        profileEnforcement: () => ({ ok: true as const }),
      }),
      resolveDeck: async () => ({ ...DECK }),
      resolveLaunchPlan: async () => matchingPlan(cwd),
      claudeProbe: async () => ({ ok: true as const }),
      homeDir,
    };

    expect(await runRunCommand(['planner', '--client', 'claude', '--cwd', cwd, '--prompt', 'try writes'], deps)).toBe(0);

    const logPath = (logs.at(-1)?.match(/log (\S+) sessionId/) ?? [])[1] ?? '';
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(logPath), 'meta.json'), 'utf8')) as {
      denials?: Array<Record<string, unknown>>;
    };
    expect(meta.denials).toHaveLength(2);
    expect(meta.denials?.[0]).toMatchObject({
      client: 'claude',
      profile: 'readonly',
      source: 'client',
      kind: 'shell',
      target: 'Bash',
    });
    expect(meta.denials?.[1]).toMatchObject({
      client: 'claude',
      profile: 'readonly',
      source: 'client',
      kind: 'file_write',
      target: 'Edit',
    });
    // Denials are status, not events: no log line is written for them.
    const kinds = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { t?: string }).t);
    expect(kinds).toEqual(['result', 'end']);
  });
});
