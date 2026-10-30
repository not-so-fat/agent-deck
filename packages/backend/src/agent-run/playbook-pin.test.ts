/**
 * NOT-537: the run's playbook pin reaches the agent's MCP launch through
 * each client's explicit per-server env mechanism — never through inherited
 * process env, which MCP stdio servers never see (Codex documents a
 * restricted env; the MCP SDK's StdioClientTransport only inherits a safe
 * allowlist plus the configured server `env`). Codex carries the pin as a
 * `-c mcp_servers.agent-deck` argv override; Claude passes an inline
 * `mcpServers` entry to the SDK; Cursor and Muse have no per-run override
 * and fail closed in `planStart` instead of silently reading live bodies.
 */
import { describe, expect, it } from 'vitest';

import { formatRunPlaybookPin, PLAYBOOK_PIN_ENV_VAR } from './adapter';
import { buildClaudePinMcpServer, createClaudeAdapter, type RunQueryOptions } from './claude';
import {
  buildCodexArgv,
  buildCodexPinConfigOverride,
  createCodexAdapter,
} from './codex';
import { createCursorAdapter } from './cursor';
import { createMuseAdapter } from './muse';

const PIN = { playbookId: 'pb_baseline', versionId: '123e4567-e89b-42d3-a456-426614174000' };
const PIN_VALUE = 'pb_baseline=123e4567-e89b-42d3-a456-426614174000';

function emptyLines(): AsyncIterable<string> {
  return (async function* (): AsyncGenerator<string> {})();
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  // The pin is captured at spawn/query time; stream outcome is irrelevant.
  try {
    for await (const _event of stream) {
      // consume
    }
  } catch {
    // Fake children carry no valid client output — expected here.
  }
}

describe('playbook pin carriage (NOT-537)', () => {
  it('formats the pin value', () => {
    expect(formatRunPlaybookPin(PIN)).toBe(PIN_VALUE);
    expect(PLAYBOOK_PIN_ENV_VAR).toBe('AGENT_DECK_PLAYBOOK_PIN');
  });

  it('codex builds a full mcp_servers override carrying the pin', () => {
    expect(buildCodexPinConfigOverride(PIN, { port: '1110', host: '127.0.0.1' })).toBe(
      'mcp_servers.agent-deck={command="agent-deck",args=["mcp-launch"],' +
        'env={AGENT_DECK_PLAYBOOK_PIN="pb_baseline=123e4567-e89b-42d3-a456-426614174000",' +
        'AGENT_DECK_MCP_PORT="1110",AGENT_DECK_HOST="127.0.0.1"}}',
    );
  });

  it('codex puts the pin override on start and resume argv, and no -c without a pin', () => {
    const start = buildCodexArgv({ prompt: 'hi', tools: 'readonly', insideGitRepo: true, playbookPin: PIN });
    const flag = start.indexOf('-c');
    expect(flag).toBeGreaterThan(-1);
    expect(start[flag + 1]).toContain(`AGENT_DECK_PLAYBOOK_PIN="${PIN_VALUE}"`);
    // Before the `--` terminator, so codex parses it as an option.
    expect(flag).toBeLessThan(start.indexOf('--'));

    const resume = buildCodexArgv({
      prompt: 'hi',
      tools: 'readonly',
      insideGitRepo: true,
      resumeId: 'thread-1',
      playbookPin: PIN,
    });
    expect(resume).toContain('-c');
    expect(resume[resume.indexOf('-c') + 1]).toContain(PIN_VALUE);

    const unpinned = buildCodexArgv({ prompt: 'hi', tools: 'readonly', insideGitRepo: true });
    expect(unpinned).not.toContain('-c');
  });

  it('codex start passes the pin argv and no pin env to the child', async () => {
    const seenArgv: string[][] = [];
    const seenEnv: Array<NodeJS.ProcessEnv | undefined> = [];
    const adapter = createCodexAdapter({
      spawn: (_bin, argv, opts) => {
        seenArgv.push(argv);
        seenEnv.push(opts.env);
        return { stdout: emptyLines(), wait: async () => ({ code: 0, stderrTail: '' }) };
      },
      isGitRepo: () => true,
    });

    await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly', playbookPin: PIN }));
    expect(seenArgv).toHaveLength(1);
    expect(seenArgv[0].join(' ')).toContain(PIN_VALUE);
    // The `-c` override is the only carrier: no env juggling on the child.
    expect(seenEnv[0]?.[PLAYBOOK_PIN_ENV_VAR]).toBeUndefined();
  });

  it('claude builds an inline agent-deck server carrying the pin', () => {
    expect(buildClaudePinMcpServer(PIN, '/work/repo', {})).toEqual({
      type: 'stdio',
      command: 'agent-deck',
      args: ['mcp-launch'],
      env: {
        AGENT_DECK_WORKSPACE: '/work/repo',
        AGENT_DECK_MCP_PORT: '1110',
        AGENT_DECK_HOST: '127.0.0.1',
        [PLAYBOOK_PIN_ENV_VAR]: PIN_VALUE,
      },
    });
  });

  it('claude passes the pinned server plus strictMcpConfig only when pinned', async () => {
    const seenOptions: RunQueryOptions[] = [];
    const adapter = createClaudeAdapter({
      query: (params) => {
        seenOptions.push(params.options);
        return (async function* () {
          yield { type: 'result', subtype: 'success', session_id: 'ses_1', result: 'ok' };
        })();
      },
    });

    const previousPin = process.env[PLAYBOOK_PIN_ENV_VAR];
    delete process.env[PLAYBOOK_PIN_ENV_VAR];
    try {
      await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly', playbookPin: PIN }));
      expect(seenOptions).toHaveLength(1);
      expect(seenOptions[0].strictMcpConfig).toBe(true);
      expect(seenOptions[0].mcpServers?.['agent-deck']?.env?.[PLAYBOOK_PIN_ENV_VAR]).toBe(PIN_VALUE);
      // No global env mutation: the SDK option is the only carrier.
      expect(process.env[PLAYBOOK_PIN_ENV_VAR]).toBeUndefined();

      seenOptions.length = 0;
      await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly' }));
      expect(seenOptions).toHaveLength(1);
      expect(seenOptions[0].strictMcpConfig).toBeUndefined();
      expect(seenOptions[0].mcpServers).toBeUndefined();
    } finally {
      if (previousPin === undefined) {
        delete process.env[PLAYBOOK_PIN_ENV_VAR];
      } else {
        process.env[PLAYBOOK_PIN_ENV_VAR] = previousPin;
      }
    }
  });

  it('cursor fails closed on a pin before any model work', () => {
    const adapter = createCursorAdapter();
    const plan = adapter.planStart({ cwd: '/tmp', prompt: 'hi', tools: 'readonly', playbookPin: PIN });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.remedy).toContain('--playbook-version is not supported with --client cursor');
    }
    expect(
      adapter.planStart({ cwd: '/tmp', prompt: 'hi', tools: 'readonly' }),
    ).toEqual({ ok: true, trustOverride: true });
  });

  it('muse fails closed on a pin before any model work', () => {
    const adapter = createMuseAdapter({
      readFile: (candidate) =>
        candidate.endsWith('settings.json')
          ? JSON.stringify({ mcpServers: { 'agent-deck': { command: 'agent-deck' } } })
          : null,
      probe: () => ({ code: 0, stdout: '--disable-write --disable-shell', stderr: '' }),
    });
    const plan = adapter.planStart({ cwd: '/tmp', prompt: 'hi', tools: 'readonly', playbookPin: PIN });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.remedy).toContain('--playbook-version is not supported with --client muse');
    }
    expect(adapter.planStart({ cwd: '/tmp', prompt: 'hi', tools: 'readonly' }).ok).toBe(true);
  });
});
