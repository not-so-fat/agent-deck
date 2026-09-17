import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertFreshCliAndBackendBuild,
  createIsolatedDeck,
  isAlive,
  killLeftovers,
  occupyPort,
  readLastStartFailureFile,
  readLastStopFile,
  removeIsolatedDeck,
  reserveFreePort,
  runCli,
  shutdownLines,
  spawnCli,
  waitForRunState,
  waitUntil,
  type IsolatedDeck,
} from './cli-integration-harness';

/**
 * NOT-135: the one claim that genuinely needs two real decks — a stop recorded
 * by the process that ran the deck must survive an unrelated start that dies
 * before it supervises anything. Everything provable from the formatting and the
 * record files alone lives in `shutdown-reason.test.ts`, without processes.
 */
describe('NOT-135 — a real stop outlives an unrelated failed start', () => {
  let deck: IsolatedDeck;
  let foreground: ChildProcess | null = null;

  beforeEach(async () => {
    assertFreshCliAndBackendBuild();
    // Its own store *and* its own ports: `agent-deck stop` kills whatever holds
    // the configured ports, and on the defaults that is the developer's deck.
    deck = await createIsolatedDeck('agent-deck-stop-origin-');
    foreground = null;
  });

  afterEach(() => {
    killLeftovers(deck, [foreground]);
    removeIsolatedDeck(deck);
  });

  /** Start a background deck on this suite's own ports, and wait for it. */
  async function startDaemon(): Promise<void> {
    const started = runCli(deck, ['start', '--daemon', '--no-ui', '--no-open']);
    expect(started.status, `start --daemon failed: ${started.stderr}`).toBe(0);
  }

  /** The reason text of the next shutdown line, with the requester pid removed. */
  async function nextShutdownReason(previousCount: number): Promise<string> {
    const appeared = await waitUntil(() => shutdownLines(deck).length > previousCount);
    expect(appeared, 'supervisor.log gained no shutdown line').toBe(true);
    const line = shutdownLines(deck).at(-1) ?? '';
    const reason = /reason: (.*)\)\s*$/.exec(line)?.[1];
    expect(reason, `no reason in: ${line}`).toBeTruthy();
    return (reason as string).replace(/ \(pid \d+\)/g, '');
  }

  /** Nothing from the stopped run may outlive it into the next scenario. */
  async function expectChildrenGone(pids: { backendPid: number; mcpPid: number }): Promise<void> {
    const gone = await waitUntil(() => !isAlive(pids.backendPid) && !isAlive(pids.mcpPid));
    expect(gone, 'backend/MCP survived the stop').toBe(true);
  }

  /**
   * The answer to "why did the deck stop?" belongs to the process that ran the
   * deck. A `start` interrupted before it supervises anything has its own
   * question ("why won't it start?") and must not overwrite the other one.
   *
   * The four origins themselves are proved in `shutdown-reason.test.ts`, which
   * needs no processes at all; only this one needs two real decks to be wrong.
   */
  it('keeps the real stop when an unrelated start is interrupted before it supervises anything', async () => {
    await startDaemon();
    const state = await waitForRunState(deck);
    const count = shutdownLines(deck).length;
    expect(runCli(deck, ['stop']).status).toBe(0);
    await nextShutdownReason(count);
    await expectChildrenGone(state);

    const recorded = readLastStopFile(deck);
    expect(recorded?.reason).toContain('requested by agent-deck stop');

    // A fresh start on a port something else holds, interrupted on top of that:
    // it cannot reach a spawn either way, so nothing here ever supervised the
    // deck — whichever of the two ends it first is the path under test.
    const taken = await occupyPort();
    try {
      foreground = spawnCli(deck, [
        'start',
        '--no-ui',
        '--no-open',
        '--port',
        String(taken.port),
        '--mcp-port',
        String(await reserveFreePort()),
      ]);
      foreground.stdout?.resume();
      foreground.stderr?.resume();
      // Wait for the observable, never a fixed delay. A sleep long enough on
      // this laptop lands while node is still loading the CLI on a slower CI
      // runner: the signal then takes the runtime's default path, no handler
      // records anything, and the assertion below fails for a reason that has
      // nothing to do with the behaviour under test (ubuntu-latest, 2026-09-17).
      // The held port guarantees this start fails on its own, so the record
      // appearing is the signal that the failure path ran.
      const failed = await waitUntil(() => readLastStartFailureFile(deck) !== null);
      expect(failed, 'the start never recorded a failure').toBe(true);
      foreground.kill('SIGINT');
      const exited = await waitUntil(
        () => foreground?.exitCode !== null || foreground?.signalCode !== null,
      );
      expect(exited, 'the interrupted start never exited').toBe(true);
    } finally {
      await taken.release();
    }

    // Unchanged, down to the timestamp: that stop is still the last one.
    expect(readLastStopFile(deck)).toEqual(recorded);
    const status = runCli(deck, ['status']).stdout;
    expect(status).toContain(recorded?.reason as string);
    // The interrupted start is answerable too — just under its own heading.
    expect(status).toContain('Last failed start:');
  }, 240_000);
});
