import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearLastStartFailure,
  clearStopRequest,
  composeShutdownReason,
  consumeStopRequest,
  describeCrash,
  describeSignalOrigin,
  formatLastStartFailureLines,
  formatLastStopLines,
  formatSupervisorShutdownLine,
  lastStopPath,
  readLastStartFailure,
  readLastStop,
  readStopRequest,
  recordStartFailure,
  recordStopRequest,
  stopRequestPath,
  writeLastStop,
} from './shutdown-reason';

describe('shutdown reason', () => {
  let tempHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.AGENT_DECK_HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-shutdown-'));
    process.env.AGENT_DECK_HOME = tempHome;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.AGENT_DECK_HOME;
    } else {
      process.env.AGENT_DECK_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('stores the stop request under the agent deck home', () => {
    recordStopRequest({ source: 'agent-deck stop', targetPid: 42 });
    expect(stopRequestPath()).toBe(path.join(tempHome, 'stop-request.json'));
    expect(readStopRequest()?.source).toBe('agent-deck stop');
  });

  it('hands a fresh request to the targeted supervisor and removes the note', () => {
    recordStopRequest({ source: 'menubar', detail: 'tray quit', targetPid: 42 });
    const request = consumeStopRequest({ supervisorPid: 42 });
    expect(request?.source).toBe('menubar');
    expect(request?.detail).toBe('tray quit');
    expect(readStopRequest()).toBeNull();
  });

  it('accepts an untargeted request from any supervisor', () => {
    recordStopRequest({ source: 'agent-deck stop' });
    expect(consumeStopRequest({ supervisorPid: 99 })?.source).toBe('agent-deck stop');
  });

  /**
   * Two decks can share a home on different ports. Eating a note addressed to
   * the other one costs that supervisor its attribution, and convinces
   * `agent-deck stop` that someone recorded a stop nobody recorded.
   */
  it('leaves a request aimed at a different supervisor where its target can find it', () => {
    recordStopRequest({ source: 'agent-deck stop', targetPid: 7 });
    expect(consumeStopRequest({ supervisorPid: 42 })).toBeNull();
    expect(readStopRequest()?.targetPid).toBe(7);
    expect(consumeStopRequest({ supervisorPid: 7 })?.source).toBe('agent-deck stop');
  });

  it('ignores a stale request left behind by an earlier run', () => {
    recordStopRequest({
      source: 'agent-deck stop',
      targetPid: 42,
      now: new Date(Date.now() - 10 * 60_000),
    });
    expect(consumeStopRequest({ supervisorPid: 42 })).toBeNull();
    // Stale notes are cleared, so they cannot mislabel a later shutdown.
    expect(readStopRequest()).toBeNull();
  });

  it('names the requester alongside what the supervisor observed', () => {
    recordStopRequest({ source: 'agent-deck stop', targetPid: 42, requesterPid: 1234 });
    const request = consumeStopRequest({ supervisorPid: 42 });
    expect(composeShutdownReason(describeSignalOrigin('SIGTERM'), request)).toBe(
      'signal SIGTERM; requested by agent-deck stop (pid 1234)',
    );
  });

  it('keeps the bare origin when nothing requested the stop', () => {
    expect(composeShutdownReason(describeSignalOrigin('SIGTERM'), null)).toBe('signal SIGTERM');
    expect(composeShutdownReason(describeSignalOrigin('SIGINT'), null)).toBe(
      'signal SIGINT (Ctrl-C or terminal interrupt)',
    );
  });

  it('turns a throw into a one-line origin plus the frames that locate it', () => {
    const error = Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
    const { reason, detail } = describeCrash(error);

    expect(reason).toBe('Error [ENOENT]: spawn node ENOENT');
    // The message itself is the reason; repeating it in the body adds nothing.
    expect(detail[0]).toMatch(/^at /);
    expect(formatSupervisorShutdownLine(1, `supervisor uncaught exception: ${reason}`)).toContain(
      'reason: supervisor uncaught exception: Error [ENOENT]: spawn node ENOENT',
    );
  });

  it('describes a non-Error throw rather than logging [object Object]', () => {
    expect(describeCrash('backend url missing')).toEqual({
      reason: 'backend url missing',
      detail: [],
    });
    // `Promise.reject({ code: 'X' })` is the throw with no message to fall back
    // on, so the value itself has to survive into the log.
    const { reason } = describeCrash({ code: 'ECONNREFUSED', port: 1111 });
    expect(reason).toContain('ECONNREFUSED');
    expect(reason).toContain('1111');
  });

  it('puts the reason on the shutdown line next to the exit code', () => {
    expect(formatSupervisorShutdownLine(1, 'backend exited (code 1)')).toBe(
      '[agent-deck] supervisor shutting down (exit 1, reason: backend exited (code 1))',
    );
  });

  it('round-trips the last stop record for status', () => {
    writeLastStop({
      at: '2026-09-16T12:00:00.474Z',
      exitCode: 0,
      reason: 'backend exited (code 0); requested by agent-deck stop (pid 1234)',
      supervisorPid: 42,
    });
    expect(lastStopPath()).toBe(path.join(tempHome, 'last-stop.json'));
    const record = readLastStop();
    expect(record?.reason).toContain('agent-deck stop');
    expect(formatLastStopLines(record)).toEqual([
      'Last stop:',
      '  at      2026-09-16T12:00:00.474Z',
      '  exit    0',
      '  reason  backend exited (code 0); requested by agent-deck stop (pid 1234)',
    ]);
  });

  it('says so plainly when no stop was ever recorded', () => {
    expect(formatLastStopLines(null)[0]).toContain('no record');
  });

  /**
   * "Why won't it start?" and "why did it stop?" are different questions, and
   * a failed start must not overwrite the answer to the second one.
   */
  it('keeps a failed start in its own record, next to the last stop', () => {
    writeLastStop({
      at: '2026-09-16T12:00:00.474Z',
      exitCode: 0,
      reason: 'signal SIGTERM; requested by agent-deck stop (pid 1234)',
      supervisorPid: 42,
    });

    const exitCode = recordStartFailure({
      reason: 'port 1111 (API/dashboard) is held by another program on 127.0.0.1',
      detail: ['[agent-deck] Free the port, or start on different ports'],
      pid: 4242,
    });

    expect(exitCode).toBe(1);
    expect(readLastStop()?.reason).toContain('agent-deck stop');
    expect(readLastStartFailure()?.reason).toContain('port 1111');
    expect(formatLastStartFailureLines(readLastStartFailure())[0]).toBe('Last failed start:');

    // The supervisor.log copy is what an operator reading the log sees.
    const supervisorLog = fs.readFileSync(path.join(tempHome, 'logs', 'supervisor.log'), 'utf8');
    expect(supervisorLog).toContain('[agent-deck] start failed: port 1111 (API/dashboard) is held');
    expect(supervisorLog).toContain('start failed| [agent-deck] Free the port');
  });

  it('drops the failed-start record once a start succeeds', () => {
    recordStartFailure({ reason: 'port 1111 is taken' });
    expect(readLastStartFailure()).not.toBeNull();
    clearLastStartFailure();
    expect(readLastStartFailure()).toBeNull();
    // Nothing to print when no start has failed.
    expect(formatLastStartFailureLines(null)).toEqual([]);
  });

  it('survives a corrupt note instead of blocking shutdown', () => {
    fs.mkdirSync(tempHome, { recursive: true });
    fs.writeFileSync(stopRequestPath(), 'not json', 'utf8');
    expect(readStopRequest()).toBeNull();
    expect(consumeStopRequest({ supervisorPid: 42 })).toBeNull();
    clearStopRequest();
    fs.writeFileSync(lastStopPath(), '{', 'utf8');
    expect(readLastStop()).toBeNull();
  });

  /**
   * The four stop paths from NOT-135 all arrive as a signal; only the note
   * left by the requester tells them apart.
   */
  it('distinguishes the four ways a deck gets stopped', () => {
    const lines: string[] = [];

    recordStopRequest({ source: 'agent-deck stop', targetPid: 42, requesterPid: 11 });
    lines.push(
      formatSupervisorShutdownLine(
        0,
        composeShutdownReason(describeSignalOrigin('SIGTERM'), consumeStopRequest({ supervisorPid: 42 })),
      ),
    );

    lines.push(
      formatSupervisorShutdownLine(
        0,
        composeShutdownReason(describeSignalOrigin('SIGTERM'), consumeStopRequest({ supervisorPid: 42 })),
      ),
    );

    lines.push(
      formatSupervisorShutdownLine(
        0,
        composeShutdownReason(describeSignalOrigin('SIGINT'), consumeStopRequest({ supervisorPid: 42 })),
      ),
    );

    recordStopRequest({ source: 'menubar', detail: 'Quit Agent Deck', targetPid: 42, requesterPid: 22 });
    lines.push(
      formatSupervisorShutdownLine(
        0,
        composeShutdownReason(describeSignalOrigin('SIGTERM'), consumeStopRequest({ supervisorPid: 42 })),
      ),
    );

    expect(new Set(lines).size).toBe(4);
    expect(lines[0]).toContain('requested by agent-deck stop (pid 11)');
    expect(lines[1]).toContain('signal SIGTERM)');
    expect(lines[1]).not.toContain('requested by');
    expect(lines[2]).toContain('Ctrl-C');
    expect(lines[3]).toContain('menubar — Quit Agent Deck (pid 22)');
  });
});
