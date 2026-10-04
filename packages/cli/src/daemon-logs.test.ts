import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    process.env.AGENT_DECK_LOG_MAX_BYTES = '100';
    process.env.AGENT_DECK_LOG_RETAIN = '3';
  });

  afterEach(() => {
    delete process.env.AGENT_DECK_HOME;
    delete process.env.AGENT_DECK_LOG_MAX_BYTES;
    delete process.env.AGENT_DECK_LOG_RETAIN;
    vi.restoreAllMocks();
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

  describe('rotation', () => {
    it('retains three generations in newest-to-oldest order', () => {
      const logPath = resolveDaemonLogPath('backend');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });

      for (let generation = 1; generation <= 4; generation += 1) {
        fs.writeFileSync(logPath, `generation ${generation}`.padEnd(100, '.'));
        appendDaemonLogLine('backend', `new write ${generation}`);
      }

      expect(fs.readFileSync(logPath, 'utf8')).toBe('new write 4\n');
      expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toContain('generation 4');
      expect(fs.readFileSync(`${logPath}.2`, 'utf8')).toContain('generation 3');
      expect(fs.readFileSync(`${logPath}.3`, 'utf8')).toContain('generation 2');
      expect(fs.existsSync(`${logPath}.4`)).toBe(false);
      expect(readDaemonLogTail('backend', 20)).toEqual(['new write 4']);
    });

    it('honors a configured retention count', () => {
      process.env.AGENT_DECK_LOG_RETAIN = '2';
      const logPath = resolveDaemonLogPath('backend');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'newest'.padEnd(100, '.'));
      fs.writeFileSync(`${logPath}.1`, 'older');
      fs.writeFileSync(`${logPath}.2`, 'oldest');

      appendDaemonLogLine('backend', 'new active');

      expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toContain('newest');
      expect(fs.readFileSync(`${logPath}.2`, 'utf8')).toBe('older');
      expect(fs.existsSync(`${logPath}.3`)).toBe(false);
    });

    it.each(['backend', 'mcp', 'supervisor'] as const)(
      'rotates the %s log before opening it',
      (name) => {
        const logPath = resolveDaemonLogPath(name);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, `${name} old`.padEnd(100, '.'));

        const fd = openDaemonLogFd(name);
        fs.closeSync(fd);

        expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toContain(`${name} old`);
        expect(fs.readFileSync(logPath, 'utf8')).toMatch(new RegExp(`^\\n--- ${name} `));
      },
    );

    it.each(['0', '-1', 'not-a-number'])(
      'uses default limits when overrides are invalid (%s)',
      (invalidValue) => {
        process.env.AGENT_DECK_LOG_MAX_BYTES = invalidValue;
        process.env.AGENT_DECK_LOG_RETAIN = invalidValue;
        const logPath = resolveDaemonLogPath('backend');
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, 'old active');
        fs.truncateSync(logPath, 25 * 1024 * 1024);
        fs.writeFileSync(`${logPath}.1`, 'previous one');
        fs.writeFileSync(`${logPath}.2`, 'previous two');
        fs.writeFileSync(`${logPath}.3`, 'previous three');

        appendDaemonLogLine('backend', 'new active');

        expect(fs.readFileSync(logPath, 'utf8')).toBe('new active\n');
        expect(fs.statSync(`${logPath}.1`).size).toBe(25 * 1024 * 1024);
        expect(fs.readFileSync(`${logPath}.2`, 'utf8')).toBe('previous one');
        expect(fs.readFileSync(`${logPath}.3`, 'utf8')).toBe('previous two');
        expect(fs.existsSync(`${logPath}.4`)).toBe(false);
      },
    );

    it.each([
      ['appendDaemonLogLine', (name: 'mcp') => appendDaemonLogLine(name, 'write survived')],
      [
        'openDaemonLogFd',
        (name: 'mcp') => {
          const fd = openDaemonLogFd(name);
          fs.closeSync(fd);
        },
      ],
    ] as const)('warns once and continues writing when rename fails in %s', (_label, write) => {
      const logPath = resolveDaemonLogPath('mcp');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'existing'.padEnd(100, '.'));
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('forced rename failure');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(() => write('mcp')).not.toThrow();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('mcp.log'));
      expect(fs.readFileSync(logPath, 'utf8').length).toBeGreaterThan(100);
    });
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
      const logPath = resolveDaemonLogPath('backend');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, 'previous run'.padEnd(100, '.'));
      const fd = openDaemonLogFd('backend');
      const script =
        "process.stderr.write('❌ Failed to start server: ERR_DLOPEN_FAILED NODE_MODULE_VERSION 147\\n'); process.exit(1);";
      const result = spawnSync(process.execPath, ['-e', script], { stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);

      expect(result.status).toBe(1);
      expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toContain('previous run');
      expect(readDaemonLogTail('backend', 5).join('\n')).toContain('NODE_MODULE_VERSION 147');
    });
  });
});
