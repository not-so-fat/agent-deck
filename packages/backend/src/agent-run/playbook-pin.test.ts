/**
 * NOT-537: the run's playbook pin reaches the agent's MCP connection through
 * each client's explicit per-run override — never through inherited process
 * env, which MCP servers started with a restricted env never see. Codex
 * carries the pin as a `-c mcp_servers.agent-deck` argv override; Claude
 * passes an inline `mcpServers` entry to the SDK; Cursor and Muse have no
 * per-run override and fail closed in `planStart` instead of silently
 * reading live bodies. NOT-566: both overrides are pure HTTP (workspace +
 * pin headers), with no launcher process involved.
 */
import { describe, expect, it } from 'vitest';

import { formatRunPlaybookPin, PLAYBOOK_PIN_ENV_VAR } from './adapter';
import {
  buildClaudePinMcpServer,
  CLAUDE_PIN_PLAYBOOK_PIN_HEADER,
  CLAUDE_PIN_WORKSPACE_HEADER,
  createClaudeAdapter,
  type RunQueryOptions,
} from './claude';
import {
  buildCodexArgv,
  buildCodexPinConfigOverride,
  CODEX_PIN_PLAYBOOK_PIN_HEADER,
  CODEX_PIN_WORKSPACE_HEADER,
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

  it('codex builds a full pure-HTTP mcp_servers override carrying the pin', () => {
    expect(buildCodexPinConfigOverride(PIN, '/work/repo', { port: '1110', host: '127.0.0.1' })).toBe(
      'mcp_servers.agent-deck={url="http://127.0.0.1:1110/mcp",' +
        'http_headers={"x-agent-deck-workspace"="/work/repo",' +
        '"x-agent-deck-playbook-pin"="pb_baseline=123e4567-e89b-42d3-a456-426614174000"}}',
    );
  });

  it('codex pin header names match the shared contract', () => {
    expect(CODEX_PIN_WORKSPACE_HEADER).toBe('x-agent-deck-workspace');
    expect(CODEX_PIN_PLAYBOOK_PIN_HEADER).toBe('x-agent-deck-playbook-pin');
    expect(CLAUDE_PIN_WORKSPACE_HEADER).toBe('x-agent-deck-workspace');
    expect(CLAUDE_PIN_PLAYBOOK_PIN_HEADER).toBe('x-agent-deck-playbook-pin');
  });

  it('codex puts the pin override on start and resume argv, and no -c without a pin', () => {
    const start = buildCodexArgv({
      prompt: 'hi',
      tools: 'readonly',
      insideGitRepo: true,
      playbookPin: PIN,
      workspaceRoot: '/work/repo',
    });
    const flag = start.indexOf('-c');
    expect(flag).toBeGreaterThan(-1);
    expect(start[flag + 1]).toContain(`"${CODEX_PIN_PLAYBOOK_PIN_HEADER}"="${PIN_VALUE}"`);
    expect(start[flag + 1]).toContain(`"${CODEX_PIN_WORKSPACE_HEADER}"="/work/repo"`);
    expect(start[flag + 1]).not.toContain('mcp-launch');
    // Before the `--` terminator, so codex parses it as an option.
    expect(flag).toBeLessThan(start.indexOf('--'));

    const resume = buildCodexArgv({
      prompt: 'hi',
      tools: 'readonly',
      insideGitRepo: true,
      resumeId: 'thread-1',
      playbookPin: PIN,
      workspaceRoot: '/work/repo',
    });
    expect(resume).toContain('-c');
    expect(resume[resume.indexOf('-c') + 1]).toContain(PIN_VALUE);

    const unpinned = buildCodexArgv({ prompt: 'hi', tools: 'readonly', insideGitRepo: true });
    expect(unpinned).not.toContain('-c');
  });

  it('codex fails closed on a pin without a workspace root', () => {
    expect(() =>
      buildCodexArgv({ prompt: 'hi', tools: 'readonly', insideGitRepo: true, playbookPin: PIN }),
    ).toThrow(/without workspaceRoot/);
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

  it('claude builds an inline pure-HTTP agent-deck server carrying the pin', () => {
    expect(buildClaudePinMcpServer(PIN, '/work/repo', {})).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:1110/mcp',
      headers: {
        'x-agent-deck-workspace': '/work/repo',
        'x-agent-deck-playbook-pin': PIN_VALUE,
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
    const previousPort = process.env.AGENT_DECK_MCP_PORT;
    const previousHost = process.env.AGENT_DECK_HOST;
    delete process.env[PLAYBOOK_PIN_ENV_VAR];
    delete process.env.AGENT_DECK_MCP_PORT;
    delete process.env.AGENT_DECK_HOST;
    try {
      await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly', playbookPin: PIN }));
      expect(seenOptions).toHaveLength(1);
      expect(seenOptions[0].strictMcpConfig).toBe(true);
      expect(seenOptions[0].mcpServers?.['agent-deck']).toEqual({
        type: 'http',
        url: 'http://127.0.0.1:1110/mcp',
        headers: {
          'x-agent-deck-workspace': '/tmp',
          'x-agent-deck-playbook-pin': PIN_VALUE,
        },
      });
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
      if (previousPort === undefined) {
        delete process.env.AGENT_DECK_MCP_PORT;
      } else {
        process.env.AGENT_DECK_MCP_PORT = previousPort;
      }
      if (previousHost === undefined) {
        delete process.env.AGENT_DECK_HOST;
      } else {
        process.env.AGENT_DECK_HOST = previousHost;
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
