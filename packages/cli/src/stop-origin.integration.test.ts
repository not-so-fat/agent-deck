import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertFreshCliAndBackendBuild,
  createIsolatedHome,
  isAlive,
  killLeftovers,
  reserveFreePort,
  runCli,
  shutdownLines,
  spawnCli,
  waitForHealthy,
  waitForRunState,
  waitUntil,
} from './cli-integration-harness';

/**
 * NOT-135 acceptance, step 2 of Reproduce: stop a real deck four different ways
 * and require four distinguishable lines. This drives the shipped CLI end to
 * end — a real supervisor, a real backend, a real SIGTERM — because the defect
 * being fixed was precisely that the supervisor could not tell these apart.
 */
describe('NOT-135 — every stop names its origin', () => {
  let home: string;
  let foreground: ChildProcess | null = null;

  beforeEach(() => {
    assertFreshCliAndBackendBuild();
    home = createIsolatedHome('agent-deck-stop-origin-');
    foreground = null;
  });

  afterEach(() => {
    killLeftovers(home, [foreground]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** Start a background deck on ports nothing else holds, and wait for it. */
  async function startDaemon(): Promise<void> {
    const backendPort = await reserveFreePort();
    const mcpPort = await reserveFreePort();
    const started = runCli(home, [
      'start',
      '--daemon',
      '--no-ui',
      '--no-open',
      '--port',
      String(backendPort),
      '--mcp-port',
      String(mcpPort),
    ]);
    expect(started.status, `start --daemon failed: ${started.stderr}`).toBe(0);
  }

  /** The reason text of the next shutdown line, with the requester pid removed. */
  async function nextShutdownReason(previousCount: number): Promise<string> {
    const appeared = await waitUntil(() => shutdownLines(home).length > previousCount);
    expect(appeared, 'supervisor.log gained no shutdown line').toBe(true);
    const line = shutdownLines(home).at(-1) ?? '';
    const reason = /reason: (.*)\)\s*$/.exec(line)?.[1];
    expect(reason, `no reason in: ${line}`).toBeTruthy();
    return (reason as string).replace(/ \(pid \d+\)/g, '');
  }

  /** Nothing from the stopped run may outlive it into the next scenario. */
  async function expectChildrenGone(pids: { backendPid: number; mcpPid: number }): Promise<void> {
    const gone = await waitUntil(() => !isAlive(pids.backendPid) && !isAlive(pids.mcpPid));
    expect(gone, 'backend/MCP survived the stop').toBe(true);
  }

  it('distinguishes agent-deck stop, a bare SIGTERM, a named caller and Ctrl-C', async () => {
    const reasons: string[] = [];

    // 1. `agent-deck stop` — the note the CLI leaves names the caller.
    //    Replays 2026-09-16 10:43:18, logged then as a bare `(exit 0)`.
    await startDaemon();
    let state = await waitForRunState(home);
    let count = shutdownLines(home).length;
    expect(runCli(home, ['stop']).status).toBe(0);
    reasons.push(await nextShutdownReason(count));
    await expectChildrenGone(state);

    // 2. `kill -TERM <supervisor pid>` — no note, so only the signal is known.
    //    Replays 2026-09-16 12:00:00: a stop nobody claimed, now visibly
    //    unclaimed rather than indistinguishable from `agent-deck stop`.
    await startDaemon();
    state = await waitForRunState(home);
    count = shutdownLines(home).length;
    process.kill(state.cliPid, 'SIGTERM');
    reasons.push(await nextShutdownReason(count));
    await expectChildrenGone(state);

    // 3. A named caller (what the menubar or a wrapper script passes).
    await startDaemon();
    state = await waitForRunState(home);
    count = shutdownLines(home).length;
    expect(
      runCli(home, ['stop', '--source', 'menubar', '--detail', 'Quit Agent Deck']).status,
    ).toBe(0);
    reasons.push(await nextShutdownReason(count));
    await expectChildrenGone(state);

    // 4. Ctrl-C on a foreground (inherit-mode) run: the one stop that never
    //    went through supervisor.log before this ticket.
    const backendPort = await reserveFreePort();
    const mcpPort = await reserveFreePort();
    foreground = spawnCli(home, [
      'start',
      '--no-ui',
      '--no-open',
      '--port',
      String(backendPort),
      '--mcp-port',
      String(mcpPort),
    ]);
    // Inherit mode pipes the children's output through this process — drain it
    // so a full pipe cannot stall the backend we are waiting on.
    foreground.stdout?.resume();
    foreground.stderr?.resume();
    expect(await waitForHealthy(backendPort), 'foreground deck never became healthy').toBe(true);
    state = await waitForRunState(home);
    count = shutdownLines(home).length;
    foreground.kill('SIGINT');
    reasons.push(await nextShutdownReason(count));
    await expectChildrenGone(state);

    expect(reasons[0]).toContain('requested by agent-deck stop');
    expect(reasons[1]).toBe('signal SIGTERM');
    expect(reasons[2]).toContain('requested by menubar — Quit Agent Deck');
    expect(reasons[3]).toContain('signal SIGINT');
    // The point of the ticket: four stops, four different answers.
    expect(new Set(reasons).size).toBe(4);

    // And the last of them is what `agent-deck status` reports.
    const status = runCli(home, ['status']);
    expect(status.stdout).toContain('Last stop:');
    expect(status.stdout).toContain('signal SIGINT');
    expect(status.stdout).not.toContain('Last failed start:');
  }, 240_000);
});
