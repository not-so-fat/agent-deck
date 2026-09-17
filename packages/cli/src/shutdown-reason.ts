import fs from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { resolveAgentDeckHome } from '@agent-deck/shared';
import { appendDaemonLogLine } from './daemon-logs';

/**
 * A SIGTERM carries no sender, so `agent-deck stop`, the menubar, an API call
 * and `kill -TERM` all land in the same supervisor handler. The requester drops
 * a short-lived note here first; the supervisor consumes it while shutting down
 * so the log line can name the origin instead of only the exit code.
 */
export interface StopRequest {
  /** Who asked for the stop — `agent-deck stop`, `menubar`, `api`, ... */
  source: string;
  /** Free-form context: `--force restart`, dashboard user, calling script. */
  detail?: string;
  requestedAt: string;
  requesterPid: number;
  /** Supervisor pid this request targets; 0 means "whichever instance is up". */
  targetPid: number;
}

export interface LastStopRecord {
  at: string;
  exitCode: number;
  reason: string;
  supervisorPid: number;
}

/**
 * A start that never reached the supervisor loop answers a different question
 * ("why won't it start?") and lives in its own file, so it cannot overwrite the
 * answer to "why did the deck stop?".
 */
export interface LastStartFailureRecord {
  at: string;
  exitCode: number;
  reason: string;
  pid: number;
}

/** A stop note older than this is stale — a previous run left it behind. */
export const STOP_REQUEST_MAX_AGE_MS = 60_000;

export function stopRequestPath(): string {
  return path.join(resolveAgentDeckHome(), 'stop-request.json');
}

export function lastStopPath(): string {
  return path.join(resolveAgentDeckHome(), 'last-stop.json');
}

export function lastStartFailurePath(): string {
  return path.join(resolveAgentDeckHome(), 'last-start-failure.json');
}

export function recordStopRequest(input: {
  source: string;
  detail?: string;
  targetPid?: number;
  now?: Date;
  requesterPid?: number;
}): StopRequest {
  const request: StopRequest = {
    source: input.source,
    ...(input.detail ? { detail: input.detail } : {}),
    requestedAt: (input.now ?? new Date()).toISOString(),
    requesterPid: input.requesterPid ?? process.pid,
    targetPid: input.targetPid ?? 0,
  };
  const target = stopRequestPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  return request;
}

export function readStopRequest(): StopRequest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(stopRequestPath(), 'utf8')) as StopRequest;
    if (typeof parsed?.source !== 'string' || typeof parsed?.requestedAt !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearStopRequest(): void {
  try {
    fs.unlinkSync(stopRequestPath());
  } catch {
    // ignore
  }
}

/**
 * Take the pending stop note if it is fresh and aimed at this supervisor.
 * Always removes the file so a stale note cannot mislabel a later shutdown.
 */
export function consumeStopRequest(options: {
  supervisorPid: number;
  now?: Date;
  maxAgeMs?: number;
}): StopRequest | null {
  const request = readStopRequest();
  if (!request) {
    clearStopRequest();
    return null;
  }

  const requestedAt = new Date(request.requestedAt).getTime();
  const age = (options.now ?? new Date()).getTime() - requestedAt;
  const stale =
    Number.isNaN(requestedAt) || age < 0 || age > (options.maxAgeMs ?? STOP_REQUEST_MAX_AGE_MS);
  const forThisSupervisor = request.targetPid === 0 || request.targetPid === options.supervisorPid;

  // Someone else's note is left where its target can still find it: eating it
  // would cost that supervisor its attribution *and* convince `agent-deck stop`
  // that the origin was recorded when nobody recorded it.
  if (forThisSupervisor || stale) {
    clearStopRequest();
  }
  return forThisSupervisor && !stale ? request : null;
}

export function describeStopRequest(request: StopRequest): string {
  const parts = [request.source];
  if (request.detail) {
    parts.push(request.detail);
  }
  return `${parts.join(' — ')} (pid ${request.requesterPid})`;
}

/**
 * Combine what the supervisor observed (a signal, a child exit, a failed
 * start) with the requester note, when there is one.
 */
export function composeShutdownReason(origin: string, request: StopRequest | null): string {
  return request ? `${origin}; requested by ${describeStopRequest(request)}` : origin;
}

/**
 * A supervisor that throws is a stop too, and the least explained one: Node's
 * default handler prints a trace and exits without any of our bookkeeping. Split
 * into a one-line reason (the log line, `status`) and the frames (the log body).
 */
export function describeCrash(error: unknown): { reason: string; detail: string[] } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      reason: code ? `${error.name} [${code}]: ${error.message}` : `${error.name}: ${error.message}`,
      // error.stack repeats the message on its first line; keep only the frames.
      detail: (error.stack?.split('\n').slice(1) ?? []).map((line) => line.trim()).filter(Boolean),
    };
  }
  // `String({})` is "[object Object]" — a rejected plain object is exactly the
  // throw an operator has no other way to identify.
  return { reason: typeof error === 'string' ? error : inspect(error, { depth: 2 }), detail: [] };
}

/** Origin string for a signal with no matching stop note. */
export function describeSignalOrigin(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): string {
  switch (signal) {
    case 'SIGINT':
      return 'signal SIGINT (Ctrl-C or terminal interrupt)';
    case 'SIGHUP':
      return 'signal SIGHUP (terminal closed)';
    default:
      return 'signal SIGTERM';
  }
}

export function formatSupervisorShutdownLine(exitCode: number, reason: string): string {
  return `[agent-deck] supervisor shutting down (exit ${exitCode}, reason: ${reason})`;
}

/**
 * A `start` that never supervised anything — it found a deck already running,
 * or died before spawning one — is not the deck stopping, and must not claim a
 * `supervisor shutting down` line that an operator reads as exactly that.
 */
export function formatCommandExitLine(exitCode: number, reason: string): string {
  return `[agent-deck] agent-deck start exiting (exit ${exitCode}, reason: ${reason})`;
}

export function formatStartFailureLine(reason: string): string {
  return `[agent-deck] start failed: ${reason}`;
}

/**
 * A start that dies before the supervisor loop still has to leave a trail. The
 * operator's next move is supervisor.log or `agent-deck status`, and neither can
 * show a message that only ever reached the invoking terminal.
 */
export function recordStartFailure(input: {
  reason: string;
  /** Extra operator-facing lines, copied into supervisor.log under the reason. */
  detail?: string[];
  exitCode?: number;
  /** Something closer to the failure already wrote a record — do not clobber it. */
  keepExistingRecord?: boolean;
  pid?: number;
  now?: Date;
}): number {
  const exitCode = input.exitCode ?? 1;
  const at = (input.now ?? new Date()).toISOString();

  try {
    appendDaemonLogLine('supervisor', `${at} ${formatStartFailureLine(input.reason)}`);
    for (const line of input.detail ?? []) {
      appendDaemonLogLine('supervisor', `${at} [agent-deck] start failed| ${line}`);
    }
  } catch {
    // A start already failing must not fail again on its own diagnostic.
  }

  if (!input.keepExistingRecord) {
    writeJsonRecord(lastStartFailurePath(), {
      at,
      exitCode,
      reason: input.reason,
      pid: input.pid ?? process.pid,
    });
  }

  return exitCode;
}

function writeJsonRecord(target: string, record: unknown): void {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch {
    // Never block a shutdown (or a failing start) on a bookkeeping write.
  }
}

function readJsonRecord<T extends { at?: unknown; reason?: unknown }>(source: string): T | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(source, 'utf8')) as T;
    if (typeof parsed?.at !== 'string' || typeof parsed?.reason !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeLastStop(record: LastStopRecord): void {
  writeJsonRecord(lastStopPath(), record);
}

export function readLastStop(): LastStopRecord | null {
  return readJsonRecord<LastStopRecord>(lastStopPath());
}

export function readLastStartFailure(): LastStartFailureRecord | null {
  return readJsonRecord<LastStartFailureRecord>(lastStartFailurePath());
}

/** A start that got the deck running answers the previous failure — drop it. */
export function clearLastStartFailure(): void {
  try {
    fs.unlinkSync(lastStartFailurePath());
  } catch {
    // Nothing to clear.
  }
}

export function formatLastStopLines(record: LastStopRecord | null): string[] {
  if (!record) {
    return [
      'Last stop: (no record — an instance stopped before this build, or was killed with SIGKILL)',
    ];
  }
  return [
    'Last stop:',
    `  at      ${record.at}`,
    `  exit    ${record.exitCode}`,
    `  reason  ${record.reason}`,
  ];
}

/** Printed under the last stop, so "won't start" and "stopped" stay distinct. */
export function formatLastStartFailureLines(record: LastStartFailureRecord | null): string[] {
  if (!record) {
    return [];
  }
  return [
    'Last failed start:',
    `  at      ${record.at}`,
    `  exit    ${record.exitCode}`,
    `  reason  ${record.reason}`,
  ];
}
