/**
 * `agent-deck exec` children get the injected connection env on top of the
 * inherited env minus daemon-only secrets (vault key etc.). Fake marker only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DAEMON_ONLY_SECRET_ENV_VARS } from '@agent-deck/backend/agent-run';

import { runCommand } from './backend-runtime';

const MARKER = 'fake-marker-not-a-secret';

describe('exec child env', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of DAEMON_ONLY_SECRET_ENV_VARS) {
      saved[name] = process.env[name];
      process.env[name] = MARKER;
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('drops daemon-only secrets but keeps injected connection env', async () => {
    // Exit codes only (stdio is inherited): 3 = a secret leaked, 4 = the
    // injected connection var is missing, 0 = correct.
    const script =
      `const leaked = ${JSON.stringify(DAEMON_ONLY_SECRET_ENV_VARS)}.some((n) => n in process.env);` +
      `process.exit(leaked ? 3 : process.env.INJECTED_CONNECTION === 'x' ? 0 : 4);`;
    const code = await runCommand(process.execPath, ['-e', script], { INJECTED_CONNECTION: 'x' });
    expect(code).toBe(0);
  });
});
