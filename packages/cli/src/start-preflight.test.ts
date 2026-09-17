import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
/** The other two ways this process can end without saying why. */
const CRASH_EVENTS = ['uncaughtException', 'unhandledRejection'] as const;
const EXIT_EVENTS = [...SIGNALS, ...CRASH_EVENTS] as const;

/**
 * NOT-135: what must be true before `runStart` does any work that can take
 * time — handlers for every way this process can end are already installed, and
 * a preflight failure is persisted where `agent-deck status` and supervisor.log
 * will find it rather than only on the terminal that invoked the start.
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
      EXIT_EVENTS.map((event) => [event, process.listeners(event) as NodeJS.SignalsListener[]]),
    );
    // Vitest listens for crashes too, and would claim the one this suite fires
    // on purpose. Its listeners come back in afterEach.
    for (const event of CRASH_EVENTS) {
      process.removeAllListeners(event);
    }
  });

  afterEach(() => {
    for (const event of EXIT_EVENTS) {
      process.removeAllListeners(event);
      for (const listener of previousListeners.get(event) ?? []) {
        process.on(event, listener);
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
    const baseline = EXIT_EVENTS.map((event) => process.listenerCount(event));
    const handlersAtPreflight: number[] = [];

    vi.doMock('./node-runtime', () => ({
      checkStartPreflight: () => {
        EXIT_EVENTS.forEach((event, i) => {
          handlersAtPreflight.push(process.listenerCount(event) - baseline[i]);
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

  it('installs its signal and crash handlers before the first startup check', async () => {
    const { handlersAtPreflight } = await runStartWithFailedPreflight();

    // One new handler per way out, already in place when preflight runs — so a
    // stop (or a throw) landing during preflight, an upgrade check or a port
    // probe is attributed rather than taking Node's default termination path.
    expect(handlersAtPreflight).toEqual(EXIT_EVENTS.map(() => 1));
  });

  /**
   * The least explained exit of all: Node's default handler prints a trace and
   * exits, leaving nothing in supervisor.log and nothing for `agent-deck
   * status`. This one crashes before anything was spawned, so it is a failed
   * start — a deck that is still running elsewhere must keep its last stop.
   */
  it('records a crash before anything was spawned as a failed start, not a stop', async () => {
    await runStartWithFailedPreflight();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const boom = new Error('deck went away');
      process.emit('uncaughtException', boom);

      const { readLastStartFailure, readLastStop } = await import('./shutdown-reason');
      const { resolveDaemonLogPath } = await import('./daemon-logs');

      const record = readLastStartFailure();
      expect(record?.exitCode).toBe(1);
      expect(record?.reason).toBe('supervisor uncaught exception: Error: deck went away');
      expect(readLastStop()).toBeNull();

      const supervisorLog = fs.readFileSync(resolveDaemonLogPath('supervisor'), 'utf8');
      expect(supervisorLog).toContain(
        '[agent-deck] start failed: supervisor uncaught exception: Error: deck went away',
      );
      // The frames go to the log as well — the reason alone does not locate it.
      expect(supervisorLog).toContain('[agent-deck] supervisor stack| at ');

      // shutdown() gives the children a moment before exiting; let that land
      // while process.exit is still stubbed, or it would kill this worker.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
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
