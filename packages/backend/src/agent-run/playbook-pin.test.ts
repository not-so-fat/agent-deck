/**
 * NOT-537: the run's playbook pin reaches the agent process env so its MCP
 * launch sends the pin header. Spawn adapters pass an explicit `env` to the
 * child; the in-process Claude adapter scopes `process.env` to the stream.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { PLAYBOOK_PIN_ENV_VAR, playbookPinEnv } from './adapter';
import { createClaudeAdapter } from './claude';
import { createCodexAdapter, type CodexSpawnOptions } from './codex';
import { createCursorAdapter, type CursorSpawnOptions } from './cursor';
import { createMuseAdapter, type MuseSpawnOptions } from './muse';

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

describe('playbook pin env propagation (NOT-537)', () => {
  const previousPin = process.env[PLAYBOOK_PIN_ENV_VAR];

  afterEach(() => {
    if (previousPin === undefined) {
      delete process.env[PLAYBOOK_PIN_ENV_VAR];
    } else {
      process.env[PLAYBOOK_PIN_ENV_VAR] = previousPin;
    }
  });

  it('builds a child env only when the run has a pin', () => {
    expect(playbookPinEnv(undefined)).toBeUndefined();
    const env = playbookPinEnv(PIN);
    expect(env?.[PLAYBOOK_PIN_ENV_VAR]).toBe(PIN_VALUE);
  });

  it('codex passes the pin env to the child', async () => {
    const seen: CodexSpawnOptions[] = [];
    const adapter = createCodexAdapter({
      spawn: (_bin, _argv, opts) => {
        seen.push(opts);
        return { stdout: emptyLines(), wait: async () => ({ code: 0, stderrTail: '' }) };
      },
      isGitRepo: () => true,
    });

    await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly', playbookPin: PIN }));
    expect(seen).toHaveLength(1);
    expect(seen[0].env?.[PLAYBOOK_PIN_ENV_VAR]).toBe(PIN_VALUE);

    seen.length = 0;
    await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].env).toBeUndefined();
  });

  it('cursor passes the pin env to the child', async () => {
    const seen: CursorSpawnOptions[] = [];
    const adapter = createCursorAdapter({
      spawn: (_bin, _argv, opts) => {
        seen.push(opts);
        return { stdout: emptyLines(), wait: async () => ({ code: 0, stderrTail: '' }) };
      },
    });

    await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly', playbookPin: PIN }));
    expect(seen).toHaveLength(1);
    expect(seen[0].env?.[PLAYBOOK_PIN_ENV_VAR]).toBe(PIN_VALUE);

    seen.length = 0;
    await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].env).toBeUndefined();
  });

  it('muse passes the pin env to the child', async () => {
    const seen: MuseSpawnOptions[] = [];
    const adapter = createMuseAdapter({
      spawn: (_bin, _argv, opts) => {
        seen.push(opts);
        return {
          stdout: emptyLines(),
          stderr: emptyLines(),
          wait: async () => ({ code: 0, stderrTail: '' }),
        };
      },
    });

    await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly', playbookPin: PIN }));
    expect(seen).toHaveLength(1);
    expect(seen[0].env?.[PLAYBOOK_PIN_ENV_VAR]).toBe(PIN_VALUE);

    seen.length = 0;
    await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].env).toBeUndefined();
  });

  it('claude scopes the pin env to the stream and restores it', async () => {
    delete process.env[PLAYBOOK_PIN_ENV_VAR];
    const seenDuringStream: Array<string | undefined> = [];
    const adapter = createClaudeAdapter({
      query: async function* () {
        seenDuringStream.push(process.env[PLAYBOOK_PIN_ENV_VAR]);
        yield { type: 'result', subtype: 'success', session_id: 'ses_1', result: 'ok' };
        seenDuringStream.push(process.env[PLAYBOOK_PIN_ENV_VAR]);
      },
    });

    await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly', playbookPin: PIN }));
    expect(seenDuringStream).toEqual([PIN_VALUE, PIN_VALUE]);
    expect(process.env[PLAYBOOK_PIN_ENV_VAR]).toBeUndefined();

    // An unpinned run never touches the env.
    process.env[PLAYBOOK_PIN_ENV_VAR] = 'pb_outer=223e4567-e89b-42d3-a456-426614174001';
    seenDuringStream.length = 0;
    await drain(adapter.start({ cwd: '/tmp', prompt: 'hi', tools: 'readonly' }));
    expect(seenDuringStream).toEqual([
      'pb_outer=223e4567-e89b-42d3-a456-426614174001',
      'pb_outer=223e4567-e89b-42d3-a456-426614174001',
    ]);
    expect(process.env[PLAYBOOK_PIN_ENV_VAR]).toBe('pb_outer=223e4567-e89b-42d3-a456-426614174001');
  });
});
