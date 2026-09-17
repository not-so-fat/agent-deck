import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * NOT-135: the two things that must be true before `runStart` does any work
 * that can take time — signal handlers exist, and a preflight failure is
 * persisted where `agent-deck status` and supervisor.log will find it.
 *
 * Driven through the real `runStart` with only the native probe replaced, so an
 * early `return` that skips the diagnostic fails here.
 */
describe('runStart preflight', () => {
  let tempHome: string;
  let previousHome: string | undefined;
  let previousListeners: Map<string, NodeJS.SignalsListener[]>;

  beforeEach(() => {
    previousHome = process.env.AGENT_DECK_HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-preflight-'));
    process.env.AGENT_DECK_HOME = tempHome;
    // runStart installs real handlers on this process; put them back afterwards
    // so a later suite cannot inherit a shutdown() that calls process.exit.
    previousListeners = new Map(
      SIGNALS.map((signal) => [signal, process.listeners(signal) as NodeJS.SignalsListener[]]),
    );
  });

  afterEach(() => {
    for (const signal of SIGNALS) {
      process.removeAllListeners(signal);
      for (const listener of previousListeners.get(signal) ?? []) {
        process.on(signal, listener);
      }
    }
    vi.doUnmock('./node-runtime');
    vi.resetModules();
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** The ABI mismatch NOT-135 named as the likely cause of the 10:43 exit 1. */
  const abiFailure = {
    reason: 'better-sqlite3 native module does not match node v24.0.0 (NODE_MODULE_VERSION 137)',
    message: [
      'better-sqlite3 native module does not match this Node.js version.',
      '  npm rebuild better-sqlite3 -w @agent-deck/backend',
    ].join('\n'),
  };

  async function runStartWithFailedPreflight(): Promise<{ code: number; handlersAtPreflight: number[] }> {
    const baseline = SIGNALS.map((signal) => process.listenerCount(signal));
    const handlersAtPreflight: number[] = [];

    vi.doMock('./node-runtime', () => ({
      checkStartPreflight: () => {
        SIGNALS.forEach((signal, i) => {
          handlersAtPreflight.push(process.listenerCount(signal) - baseline[i]);
        });
        return abiFailure;
      },
      getNodeMajor: () => 24,
      isSupportedNodeMajor: () => true,
      verifySqliteNative: () => ({ ok: true }),
    }));

    const { runStart } = await import('./start');
    const code = await runStart({ supervisor: true });
    return { code, handlersAtPreflight };
  }

  it('installs its signal handlers before the first startup check', async () => {
    const { handlersAtPreflight } = await runStartWithFailedPreflight();

    // One new handler per signal, already in place when preflight runs — so a
    // stop landing during preflight, an upgrade check or a port probe is
    // attributed rather than taking Node's default termination path.
    expect(handlersAtPreflight).toEqual([1, 1, 1]);
  });

  it('persists a preflight failure to supervisor.log and the last-stop record', async () => {
    const { code } = await runStartWithFailedPreflight();
    expect(code).toBe(1);

    const { readLastStartFailure, readLastStop, formatLastStartFailureLines } = await import(
      './shutdown-reason'
    );
    const { resolveDaemonLogPath } = await import('./daemon-logs');

    const supervisorLog = fs.readFileSync(resolveDaemonLogPath('supervisor'), 'utf8');
    expect(supervisorLog).toContain(`[agent-deck] start failed: ${abiFailure.reason}`);
    expect(supervisorLog).toContain('npm rebuild better-sqlite3');

    const record = readLastStartFailure();
    expect(record?.exitCode).toBe(1);
    expect(record?.reason).toBe(abiFailure.reason);
    // A start that never ran is not a stop: it must not overwrite that answer.
    expect(readLastStop()).toBeNull();
    // What `agent-deck status` prints.
    expect(formatLastStartFailureLines(record)).toContain(`  reason  ${abiFailure.reason}`);
  });
});
