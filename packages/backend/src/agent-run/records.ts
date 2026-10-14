/**
 * Canonical run records for the host-local agent run service (NOT-400,
 * NOT-402, NOT-479).
 *
 * One run is a directory holding `meta.json` (the run record) and
 * `run.jsonl` (the normalized event log). Both the CLI and the backend read
 * and write runs only through this module, so there is exactly one event
 * history: the JSONL log. A `running` meta whose pid is no longer alive is
 * reported as `died` so orchestrators never wait forever. Pid-reuse is
 * mitigated by comparing `startedAt` with the process start time where `ps`
 * is available.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { RunClient, RunToolsProfile } from './adapter';

export type RunLogLine =
  | { t: 'text'; ts: string; text: string }
  | { t: 'tool'; ts: string; name: string }
  | { t: 'result'; ts: string; sessionId: string | null; subtype: string; result: unknown }
  | { t: 'end'; ts: string; sessionId: string | null }
  | { t: 'notice'; ts: string; message: string; sessionId: string | null }
  | { t: 'error'; ts: string; message: string; sessionId: string | null };

/**
 * The trusted Agent Deck run that started a resumed session (NOT-484): its
 * run id, the session id, and the tool profile that run launched with. Only
 * Agent Deck's own identifiers; no provider state.
 */
export type RunResumeOrigin = {
  runId: string;
  sessionId: string;
  tools: RunToolsProfile;
};

export type RunMeta = {
  runId: string;
  deck: string;
  client: RunClient;
  tools: RunToolsProfile;
  cwd: string;
  /** Realpath of `cwd` at launch; resume provenance compares against it. */
  canonicalCwd?: string;
  pid: number;
  startedAt: string;
  state: 'running' | 'ended' | 'error';
  sessionId?: string;
  /** Present only when the launch bypassed a client workspace-trust guard. */
  trustOverride?: true;
  /** Present only on a resume: the run that started the session. */
  resumedFrom?: RunResumeOrigin;
};

export type RunInspectState = 'running' | 'ended' | 'error' | 'died';

export type RunStatusInfo = {
  runId: string;
  deck: string;
  client: string;
  state: RunInspectState;
  sessionId: string | null;
  startedAt: string;
  lastLogTs: string | null;
  logPath: string;
  /** Present only when this run resumed a session another run started. */
  resumedFrom?: RunResumeOrigin;
};

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `run-${stamp}-${randomBytes(3).toString('hex')}`;
}

export function runsRoot(homeDir: string): string {
  return path.join(homeDir, 'runs');
}

/** Default record location for `runId` under `homeDir`. */
export function runPaths(
  homeDir: string,
  runId: string,
): { dir: string; metaPath: string; logPath: string } {
  const dir = path.join(runsRoot(homeDir), runId);
  return { dir, metaPath: path.join(dir, 'meta.json'), logPath: path.join(dir, 'run.jsonl') };
}

/** meta.json always sits next to the log, whether the log path is default or custom. */
export function metaPathForLog(logPath: string): string {
  return path.join(path.dirname(logPath), 'meta.json');
}

/**
 * Atomic run-record write: readers (`run status`, detach tests, orchestrators)
 * poll meta.json while the run child rewrites it, and a plain writeFileSync
 * truncates before writing — a concurrent read lands on empty/partial bytes
 * and JSON.parse throws. Writing to a sibling temp file and renaming keeps
 * every observed state a complete document (rename is atomic on POSIX and
 * Windows). The pid suffix keeps the starter's and the child's temp files
 * distinct when both target the same meta.json.
 */
export function writeRunMeta(metaPath: string, meta: RunMeta): void {
  const tmpPath = `${metaPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, metaPath);
}

export function appendRunLogLine(logPath: string, line: RunLogLine): void {
  fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`, 'utf8');
}

export type MetaRead =
  | { ok: true; meta: RunMeta }
  | { ok: false; reason: string; partial: Partial<RunMeta> };

export function readRunMeta(metaPath: string): MetaRead {
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath, 'utf8');
  } catch {
    return { ok: false, reason: 'unreadable', partial: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid JSON', partial: {} };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'not an object', partial: {} };
  }
  const partial = parsed as Partial<RunMeta>;
  if (
    typeof partial.runId !== 'string' ||
    typeof partial.deck !== 'string' ||
    typeof partial.client !== 'string' ||
    typeof partial.startedAt !== 'string' ||
    (partial.state !== 'running' && partial.state !== 'ended' && partial.state !== 'error')
  ) {
    return { ok: false, reason: 'missing required fields', partial };
  }
  return { ok: true, meta: partial as RunMeta };
}

export type ParsedLogEvent = {
  raw: string;
  event: RunLogLine & { ts?: string; sessionId?: string | null };
};

export type LogRead = {
  exists: boolean;
  events: ParsedLogEvent[];
  truncated: boolean;
  lastTs: string | null;
  lastSessionId: string | null;
  sawEnd: boolean;
  sawError: boolean;
};

export function logEventSessionId(event: ParsedLogEvent['event']): string | null {
  const value = (event as { sessionId?: unknown }).sessionId;
  return typeof value === 'string' && value ? value : null;
}

export function readRunLog(logPath: string): LogRead {
  const empty: LogRead = {
    exists: false,
    events: [],
    truncated: false,
    lastTs: null,
    lastSessionId: null,
    sawEnd: false,
    sawError: false,
  };
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch {
    return empty;
  }
  empty.exists = true;
  if (!raw) {
    return empty;
  }
  const endsWithNewline = raw.endsWith('\n');
  const chunks = raw.split('\n');
  // A trailing newline leaves an empty final chunk that is not a line.
  const lines = endsWithNewline ? chunks.slice(0, -1) : chunks;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Only the last chunk of a file without a trailing newline can be a
      // torn write; anything else is a corrupt line. Both are skipped.
      void isLast;
      empty.truncated = true;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { t?: unknown }).t !== 'string') {
      empty.truncated = true;
      continue;
    }
    const event = parsed as ParsedLogEvent['event'];
    empty.events.push({ raw: line, event });
    if (typeof event.ts === 'string' && event.ts) {
      empty.lastTs = event.ts;
    }
    const sessionId = logEventSessionId(event);
    if (sessionId) {
      empty.lastSessionId = sessionId;
    }
    if (event.t === 'end') {
      empty.sawEnd = true;
    } else if (event.t === 'error') {
      empty.sawError = true;
    }
  }
  return empty;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort process start time via `ps`; null when unavailable. */
function getProcessStartTime(pid: number): Date | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) {
      return null;
    }
    const parsed = new Date(out);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * True when `pid` is alive and not obviously recycled: the runner process
 * started before it wrote `startedAt`, so a live pid whose start time is
 * well after `startedAt` must be a different process.
 */
export function isRunPidAlive(pid: number, startedAt: string): boolean {
  if (!isProcessAlive(pid)) {
    return false;
  }
  const procStart = getProcessStartTime(pid);
  const runStart = new Date(startedAt);
  if (!procStart || Number.isNaN(runStart.getTime())) {
    return true;
  }
  // 2s tolerance for `ps` one-second resolution and clock skew.
  return procStart.getTime() <= runStart.getTime() + 2000;
}

function effectiveState(meta: RunMeta): RunInspectState {
  if (meta.state === 'ended' || meta.state === 'error') {
    return meta.state;
  }
  return isRunPidAlive(meta.pid, meta.startedAt) ? 'running' : 'died';
}

export type CollectedStatus =
  | { found: false }
  | { found: true; info: RunStatusInfo; warnings: string[]; corruptMeta: boolean };

export function collectRunStatus(runId: string, homeDir: string): CollectedStatus {
  const { metaPath, logPath } = runPaths(homeDir, runId);
  if (!fs.existsSync(metaPath)) {
    return { found: false };
  }
  const metaRead = readRunMeta(metaPath);
  const log = readRunLog(logPath);
  const warnings: string[] = [];
  if (metaRead.ok) {
    const meta = metaRead.meta;
    const sessionId =
      typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId : log.lastSessionId;
    if (log.truncated) {
      warnings.push(`truncated log line in ${logPath} (ignored)`);
    }
    return {
      found: true,
      corruptMeta: false,
      warnings,
      info: {
        runId: meta.runId,
        deck: meta.deck,
        client: meta.client,
        state: effectiveState(meta),
        sessionId,
        startedAt: meta.startedAt,
        lastLogTs: log.lastTs,
        logPath,
        ...(meta.resumedFrom ? { resumedFrom: meta.resumedFrom } : {}),
      },
    };
  }
  warnings.push(`meta.json is corrupt (${metaRead.reason}); showing log-derived info`);
  if (log.truncated) {
    warnings.push(`truncated log line in ${logPath} (ignored)`);
  }
  const partial = metaRead.partial;
  return {
    found: true,
    corruptMeta: true,
    warnings,
    info: {
      runId: typeof partial.runId === 'string' ? partial.runId : runId,
      deck: typeof partial.deck === 'string' ? partial.deck : 'unknown',
      client: typeof partial.client === 'string' ? partial.client : 'unknown',
      state: 'error',
      sessionId:
        (typeof partial.sessionId === 'string' && partial.sessionId ? partial.sessionId : null) ??
        log.lastSessionId,
      startedAt: typeof partial.startedAt === 'string' ? partial.startedAt : 'unknown',
      lastLogTs: log.lastTs,
      logPath,
    },
  };
}

export function listRunInfos(homeDir: string, limit: number): RunStatusInfo[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(runsRoot(homeDir));
  } catch {
    return [];
  }
  const infos: RunStatusInfo[] = [];
  for (const runId of entries) {
    const collected = collectRunStatus(runId, homeDir);
    if (collected.found) {
      infos.push(collected.info);
    }
  }
  infos.sort((a, b) => {
    if (a.startedAt !== b.startedAt) {
      return a.startedAt < b.startedAt ? 1 : -1;
    }
    return a.runId < b.runId ? 1 : -1;
  });
  return infos.slice(0, limit);
}
