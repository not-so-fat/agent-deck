import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentDeckHome } from '@agent-deck/shared';

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

/** A stop note older than this is stale — a previous run left it behind. */
export const STOP_REQUEST_MAX_AGE_MS = 60_000;

export function stopRequestPath(): string {
  return path.join(resolveAgentDeckHome(), 'stop-request.json');
}

export function lastStopPath(): string {
  return path.join(resolveAgentDeckHome(), 'last-stop.json');
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
  clearStopRequest();
  if (!request) {
    return null;
  }
  if (request.targetPid !== 0 && request.targetPid !== options.supervisorPid) {
    return null;
  }
  const requestedAt = new Date(request.requestedAt).getTime();
  if (Number.isNaN(requestedAt)) {
    return null;
  }
  const age = (options.now ?? new Date()).getTime() - requestedAt;
  if (age < 0 || age > (options.maxAgeMs ?? STOP_REQUEST_MAX_AGE_MS)) {
    return null;
  }
  return request;
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

export function writeLastStop(record: LastStopRecord): void {
  try {
    const target = lastStopPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch {
    // Never block a shutdown on a bookkeeping write.
  }
}

export function readLastStop(): LastStopRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lastStopPath(), 'utf8')) as LastStopRecord;
    if (typeof parsed?.at !== 'string' || typeof parsed?.reason !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
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
