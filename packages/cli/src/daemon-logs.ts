import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentDeckHome } from '@agent-deck/shared';
import { stripAnsi } from './strip-ansi';

export type DaemonLogName = 'supervisor' | 'backend' | 'mcp';

/** Child logs grow to hundreds of MB — only ever read the tail window. */
const LOG_TAIL_BYTES = 64 * 1024;

export function resolveDaemonLogsDir(): string {
  return path.join(resolveAgentDeckHome(), 'logs');
}

export function resolveDaemonLogPath(name: DaemonLogName): string {
  return path.join(resolveDaemonLogsDir(), `${name}.log`);
}

/** Append-only log sink; returns fd for child stdio (caller does not close while process runs). */
export function openDaemonLogFd(name: DaemonLogName): number {
  const logPath = resolveDaemonLogPath(name);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  fs.writeSync(fd, `\n--- ${name} ${new Date().toISOString()} ---\n`);
  return fd;
}

export function appendDaemonLogLine(name: DaemonLogName, line: string): void {
  const logPath = resolveDaemonLogPath(name);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${line}\n`);
}

/**
 * Last `maxLines` meaningful lines of a child log, newest last. Reads only the
 * trailing window of the file, so a multi-GB backend.log stays cheap.
 */
export function readDaemonLogTail(name: DaemonLogName, maxLines = 20): string[] {
  let fd: number | undefined;
  try {
    const logPath = resolveDaemonLogPath(name);
    fd = fs.openSync(logPath, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A partial first line is an artefact of the window, not a log entry.
    const lines = (size > length ? text.slice(text.indexOf('\n') + 1) : text)
      .split('\n')
      .map((line) => stripAnsi(line).trimEnd())
      .filter((line) => line.length > 0);
    // Each spawn writes a `--- <name> <iso> ---` banner; report the current
    // run only, so a previous run's output cannot look like this failure.
    let lastBanner = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/^--- \w+ \d{4}-\d{2}-\d{2}T/.test(lines[i])) {
        lastBanner = i;
        break;
      }
    }
    return (lastBanner >= 0 ? lines.slice(lastBanner + 1) : lines).slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** Supervisor-log rendering of a child log tail, so the origin of each line is obvious. */
export function formatChildLogTail(name: DaemonLogName, lines: string[]): string[] {
  if (lines.length === 0) {
    return [`[agent-deck] ${name}.log had no output to show (${resolveDaemonLogPath(name)})`];
  }
  return [
    `[agent-deck] --- last ${lines.length} line(s) of ${name}.log ---`,
    ...lines.map((line) => `[agent-deck] ${name}.log| ${line}`),
    `[agent-deck] --- end of ${name}.log tail (${resolveDaemonLogPath(name)}) ---`,
  ];
}

export function resolveCliEntry(): string {
  return process.argv[1] ?? path.join(__dirname, 'bin.js');
}
