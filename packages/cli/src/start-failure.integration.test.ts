import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertFreshCliAndBackendBuild,
  createIsolatedHome,
  killLeftovers,
  occupyPort,
  readDaemonLog,
  removeIsolatedHome,
  reserveFreePort,
  runCli,
} from './cli-integration-harness';

/**
 * NOT-135: the acceptance criteria are about what an operator can read *after*
 * the fact, so these drive the real `agent-deck start` / `agent-deck status`
 * processes and assert the files they leave behind. Nothing here reimplements
 * the supervisor's decisions.
 */
describe('NOT-135 — a failed start is recoverable from the logs it leaves', () => {
  let home: string;

  beforeEach(() => {
    assertFreshCliAndBackendBuild();
    home = createIsolatedHome('agent-deck-start-fail-');
  });

  afterEach(() => {
    killLeftovers(home);
    removeIsolatedHome(home);
  });

  it('a backend that dies during startup writes its reason to backend.log, supervisor.log and status', async () => {
    // A directory where SQLite expects a file: the backend throws while opening
    // the store, before it ever listens — replaying 2026-09-16 10:43:41, the
    // 308ms `exit 1` that left no diagnostic in any log.
    fs.mkdirSync(path.join(home, 'agent_deck.db'));

    const backendPort = await reserveFreePort();
    const mcpPort = await reserveFreePort();
    const start = runCli(home, [
      'start',
      '--daemon',
      '--no-ui',
      '--no-open',
      '--port',
      String(backendPort),
      '--mcp-port',
      String(mcpPort),
    ]);

    expect(start.status).toBe(1);

    // 1. The child says why before it exits.
    const backendLog = readDaemonLog(home, 'backend');
    expect(backendLog).toContain('[agent-deck] backend exiting (code 1)');
    expect(backendLog).toContain('[agent-deck] backend cause:');

    // 2. The supervisor brings that reason to the operator's file.
    const supervisorLog = readDaemonLog(home, 'supervisor');
    expect(supervisorLog).toContain('[agent-deck] backend exited (code 1)');
    expect(supervisorLog).toContain('backend.log| ');
    expect(supervisorLog).toContain('[agent-deck] backend cause:');
    expect(supervisorLog).toMatch(/supervisor shutting down \(exit 1, reason: backend exited \(code 1\)\)/);

    // 3. `agent-deck status` answers "why did it stop?" without opening a log.
    const status = runCli(home, ['status']);
    expect(status.stdout).toContain('Last stop');
    expect(status.stdout).toContain('backend exited (code 1)');
  }, 120_000);

  it('a port conflict recorded before anything spawns still reaches supervisor.log and status', async () => {
    const taken = await occupyPort();
    const mcpPort = await reserveFreePort();

    try {
      const start = runCli(home, [
        'start',
        '--daemon',
        '--no-ui',
        '--no-open',
        '--port',
        String(taken.port),
        '--mcp-port',
        String(mcpPort),
      ]);

      expect(start.status).toBe(1);
      expect(start.stderr).toContain(`Port ${taken.port} (API/dashboard) is in use`);

      const supervisorLog = readDaemonLog(home, 'supervisor');
      expect(supervisorLog).toContain(
        `[agent-deck] start failed: port ${taken.port} (API/dashboard) is held by another program`,
      );

      const status = runCli(home, ['status']);
      expect(status.stdout).toContain('Last failed start:');
      expect(status.stdout).toContain(`port ${taken.port} (API/dashboard) is held by another program`);
    } finally {
      await taken.release();
    }
  }, 120_000);
});
