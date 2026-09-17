import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendDaemonLogLine,
  formatChildLogTail,
  openDaemonLogFd,
  readDaemonLogTail,
  resolveDaemonLogPath,
} from './daemon-logs';
import {
  composeShutdownReason,
  consumeStopRequest,
  describeSignalOrigin,
  formatSupervisorShutdownLine,
  recordStopRequest,
} from './shutdown-reason';

/**
 * NOT-135 replay: the three stops of 2026-09-16 whose cause could not be
 * recovered from any log. Each scenario reproduces the supervisor's decision
 * path and asserts the new log names a cause.
 */
describe('NOT-135 replay — supervisor log names the cause', () => {
  let tempHome: string;
  let previousHome: string | undefined;
  const supervisorPid = 4242;

  beforeEach(() => {
    previousHome = process.env.AGENT_DECK_HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-replay-'));
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

  function supervisorLog(): string {
    try {
      return fs.readFileSync(resolveDaemonLogPath('supervisor'), 'utf8');
    } catch {
      return '';
    }
  }

  /** What start.ts does when a child dies: log the exit, then the child's tail. */
  function logChildExit(label: 'backend' | 'mcp', detail: string): void {
    appendDaemonLogLine('supervisor', `[agent-deck] ${label} exited (${detail})`);
    if (detail !== 'code 0') {
      for (const line of formatChildLogTail(label, readDaemonLogTail(label, 20))) {
        appendDaemonLogLine('supervisor', line);
      }
    }
  }

  function logShutdown(exitCode: number, origin: string): void {
    const request = consumeStopRequest({ supervisorPid });
    appendDaemonLogLine(
      'supervisor',
      formatSupervisorShutdownLine(exitCode, composeShutdownReason(origin, request)),
    );
  }

  it('10:43:18 — a deliberate `agent-deck stop` is no longer an anonymous exit 0', () => {
    recordStopRequest({ source: 'agent-deck stop', targetPid: supervisorPid, requesterPid: 9001 });

    logChildExit('mcp', 'code 0');
    logChildExit('backend', 'code 0');
    logShutdown(0, 'backend exited (code 0)');

    expect(supervisorLog()).toContain(
      'supervisor shutting down (exit 0, reason: backend exited (code 0); requested by agent-deck stop (pid 9001))',
    );
  });

  it('10:43:41 — a 308ms failed start carries the backend ABI error into supervisor.log', () => {
    // Real child, real fd redirection: exactly how the backend reports a fatal.
    const fd = openDaemonLogFd('backend');
    const script = [
      "process.stderr.write('[agent-deck] backend exiting (code 1): startup failed before listening on 127.0.0.1:1111\\n');",
      "process.stderr.write(\"[agent-deck] backend cause: Error [ERR_DLOPEN_FAILED]: The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 147.\\n\");",
      "process.stderr.write('[agent-deck] backend hint: npm rebuild better-sqlite3\\n');",
      'process.exit(1);',
    ].join('');
    const result = spawnSync(process.execPath, ['-e', script], { stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    expect(result.status).toBe(1);

    appendDaemonLogLine('supervisor', '[agent-deck] Starting backend ...');
    logChildExit('backend', 'code 1');
    logShutdown(1, 'backend exited (code 1)');

    const log = supervisorLog();
    expect(log).toContain('NODE_MODULE_VERSION 147');
    expect(log).toContain('npm rebuild better-sqlite3');
    expect(log).toContain('supervisor shutting down (exit 1, reason: backend exited (code 1))');
    // Nobody asked for this stop — the log must not imply otherwise.
    expect(log).not.toContain('requested by');
  });

  it('12:00:00 — an unattributed SIGTERM is distinguishable from a requested stop', () => {
    logChildExit('mcp', 'code 0');
    appendDaemonLogLine('supervisor', '[agent-deck] MCP stopped; dashboard API remains available.');
    logShutdown(0, describeSignalOrigin('SIGTERM'));

    const log = supervisorLog();
    expect(log).toContain('supervisor shutting down (exit 0, reason: signal SIGTERM)');
    expect(log).not.toContain('requested by');
  });
});
