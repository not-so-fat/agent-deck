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
  resolveDaemonLogsDir,
} from './daemon-logs';

describe('daemon-logs', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-daemon-'));
    process.env.AGENT_DECK_HOME = tempHome;
  });

  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('resolves log paths under AGENT_DECK_HOME', () => {
    expect(resolveDaemonLogsDir()).toBe(path.join(tempHome, 'logs'));
    expect(resolveDaemonLogPath('backend')).toBe(path.join(tempHome, 'logs', 'backend.log'));
  });

  it('opens append-only log fd with start marker', () => {
    const fd = openDaemonLogFd('supervisor');
    const content = fs.readFileSync(resolveDaemonLogPath('supervisor'), 'utf8');
    expect(content).toContain('--- supervisor');
    fs.closeSync(fd);
  });

  it('appends lines to log file', () => {
    appendDaemonLogLine('mcp', '[test] hello');
    expect(fs.readFileSync(resolveDaemonLogPath('mcp'), 'utf8')).toContain('[test] hello');
  });

  describe('log tail', () => {
    it('returns the newest lines, oldest first', () => {
      for (let i = 0; i < 50; i += 1) {
        appendDaemonLogLine('backend', `line ${i}`);
      }
      expect(readDaemonLogTail('backend', 3)).toEqual(['line 47', 'line 48', 'line 49']);
    });

    it('reads only the trailing window of a large log', () => {
      const logPath = resolveDaemonLogPath('backend');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      // 1 MB of noise ahead of the interesting part.
      fs.writeFileSync(logPath, `${'x'.repeat(1_000_000)}\n`, 'utf8');
      appendDaemonLogLine('backend', 'the reason it died');

      const tail = readDaemonLogTail('backend', 5);
      expect(tail).toEqual(['the reason it died']);
    });

    it('reports only the current run, not the previous one', () => {
      appendDaemonLogLine('backend', 'old run: request completed');
      const fd = openDaemonLogFd('backend'); // writes the `--- backend <iso> ---` banner
      fs.closeSync(fd);
      appendDaemonLogLine('backend', 'new run: unable to open database file');

      expect(readDaemonLogTail('backend', 20)).toEqual(['new run: unable to open database file']);
    });

    it('strips ANSI colouring from child stack traces', () => {
      appendDaemonLogLine('backend', '[90m    at Module.load[39m');
      expect(readDaemonLogTail('backend', 1)).toEqual(['    at Module.load']);
    });

    it('returns nothing for a log that does not exist', () => {
      expect(readDaemonLogTail('mcp')).toEqual([]);
      expect(formatChildLogTail('mcp', [])[0]).toContain('no output to show');
    });

    it('labels each tailed line with the log it came from', () => {
      const rendered = formatChildLogTail('backend', ['boom']);
      expect(rendered[0]).toContain('last 1 line(s) of backend.log');
      expect(rendered[1]).toBe('[agent-deck] backend.log| boom');
      expect(rendered[2]).toContain(resolveDaemonLogPath('backend'));
    });

    /**
     * NOT-135 root cause B: the child writes its reason to backend.log via the
     * inherited fd, and the supervisor can read it back after the exit.
     */
    it('captures a child that exits non-zero through the redirected fd', () => {
      const fd = openDaemonLogFd('backend');
      const script =
        "process.stderr.write('❌ Failed to start server: ERR_DLOPEN_FAILED NODE_MODULE_VERSION 147\\n'); process.exit(1);";
      const result = spawnSync(process.execPath, ['-e', script], { stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);

      expect(result.status).toBe(1);
      expect(readDaemonLogTail('backend', 5).join('\n')).toContain('NODE_MODULE_VERSION 147');
    });
  });
});
