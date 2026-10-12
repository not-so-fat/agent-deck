/**
 * `agent-deck run status|log|list` — poll a run without parsing files (NOT-402).
 *
 * Reads the run record (`meta.json`) and JSONL log written by NOT-400
 * (`run.ts`). Works for foreground and detached runs: a `running` meta whose
 * pid is no longer alive is reported as `died` so orchestrators never wait
 * forever. Pid-reuse is mitigated by comparing `startedAt` with the process
 * start time where `ps` is available.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { agentDeckHome } from './managed/paths';
import { isProcessAlive } from './runtime-state';
import type { RunLogLine, RunMeta } from './run';
import { terminalColorsEnabled, terminalStyle } from './terminal-style';

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
};

export type RunInspectDeps = {
  homeDir?: string;
  /** Follow poll interval (tests only; default 100ms). */
  followPollMs?: number;
};

export const RUN_LIST_DEFAULT_LIMIT = 20;

function runsRoot(homeDir: string): string {
  return path.join(homeDir, 'runs');
}

function runPaths(homeDir: string, runId: string): { dir: string; metaPath: string; logPath: string } {
  const dir = path.join(runsRoot(homeDir), runId);
  return { dir, metaPath: path.join(dir, 'meta.json'), logPath: path.join(dir, 'run.jsonl') };
}

function resolveHomeDir(deps?: RunInspectDeps): string {
  return deps?.homeDir ?? agentDeckHome();
}

type MetaRead =
  | { ok: true; meta: RunMeta }
  | { ok: false; reason: string; partial: Partial<RunMeta> };

function readMetaFile(metaPath: string): MetaRead {
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

type ParsedLogEvent = {
  raw: string;
  event: RunLogLine & { ts?: string; sessionId?: string | null };
};

type LogRead = {
  exists: boolean;
  events: ParsedLogEvent[];
  truncated: boolean;
  lastTs: string | null;
  lastSessionId: string | null;
  sawEnd: boolean;
  sawError: boolean;
};

function sessionOf(event: ParsedLogEvent['event']): string | null {
  const value = (event as { sessionId?: unknown }).sessionId;
  return typeof value === 'string' && value ? value : null;
}

function readLogFile(logPath: string): LogRead {
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
    const sessionId = sessionOf(event);
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
  const metaRead = readMetaFile(metaPath);
  const log = readLogFile(logPath);
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

function formatState(state: RunInspectState, color: boolean): string {
  if (state === 'error' || state === 'died') {
    return terminalStyle.error(state, color);
  }
  if (state === 'running') {
    return terminalStyle.bold(state, color);
  }
  return terminalStyle.dim(state, color);
}

function printStatusHuman(info: RunStatusInfo): void {
  const color = terminalColorsEnabled(process.stdout);
  console.log(`run ${terminalStyle.bold(info.runId, color)} ${formatState(info.state, color)}`);
  console.log(`  deck ${info.deck}`);
  console.log(`  client ${info.client}`);
  console.log(`  started ${info.startedAt}`);
  if (info.sessionId) {
    console.log(`  session ${info.sessionId}`);
  }
  console.log(`  last log ${info.lastLogTs ?? 'never'}`);
  console.log(`  log ${info.logPath}`);
}

function warnAll(warnings: string[]): void {
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }
}

// --- status ---------------------------------------------------------------

export function printRunStatusHelp(): void {
  console.log(`Usage:
  agent-deck run status <runId> [--json]

Prints runId, deck, client, state (running|ended|error|died), sessionId when
known, startedAt, last log line time, and the log path. A running meta whose
pid is no longer alive is reported as died. Exit 0 for any state; non-zero
only when the run id is unknown.`);
}

export function parseRunStatusArgs(args: string[]): { runId: string; json: boolean } | { error: string } {
  let runId: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown run status option: ${arg}` };
    } else if (!runId) {
      runId = arg;
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  if (!runId) {
    return { error: 'run id is required' };
  }
  return { runId, json };
}

export async function runRunStatusCommand(args: string[], deps?: RunInspectDeps): Promise<number> {
  const parsed = parseRunStatusArgs(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      printRunStatusHelp();
      return 0;
    }
    console.error(parsed.error);
    return 1;
  }
  const collected = collectRunStatus(parsed.runId, resolveHomeDir(deps));
  if (!collected.found) {
    console.error(`Unknown run: ${parsed.runId}`);
    return 1;
  }
  warnAll(collected.warnings);
  if (parsed.json) {
    console.log(JSON.stringify(collected.info));
  } else {
    printStatusHuman(collected.info);
  }
  return 0;
}

// --- log ------------------------------------------------------------------

export function printRunLogHelp(): void {
  console.log(`Usage:
  agent-deck run log <runId> [--tail <n>] [--follow] [--json]

Prints one line per log event (text, tool, result, end, error); --json prints
raw JSONL. --tail prints the last n events. --follow prints new lines until
an end or error line is seen, then exits 0.`);
}

type ParsedLogArgs = { runId: string; tail: number | null; follow: boolean; json: boolean };

export function parseRunLogArgs(args: string[]): ParsedLogArgs | { error: string } {
  let runId: string | undefined;
  let tail: number | null = null;
  let follow = false;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--follow' || arg === '-f') {
      follow = true;
    } else if (arg === '--tail') {
      const value = args[++i];
      const parsed = Number.parseInt(value ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { error: `--tail must be a non-negative integer (got "${value ?? ''}")` };
      }
      tail = parsed;
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown run log option: ${arg}` };
    } else if (!runId) {
      runId = arg;
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  if (!runId) {
    return { error: 'run id is required' };
  }
  return { runId, tail, follow, json };
}

function singleLine(value: string): string {
  return value.replace(/\r?\n/g, '\\n');
}

function formatLogHuman(event: ParsedLogEvent['event']): string {
  const ts = typeof event.ts === 'string' && event.ts ? event.ts : 'unknown-time';
  switch (event.t) {
    case 'text':
      return `${ts} text ${singleLine(typeof event.text === 'string' ? event.text : '')}`;
    case 'tool':
      return `${ts} tool ${typeof event.name === 'string' ? event.name : 'unknown'}`;
    case 'result': {
      const subtype = typeof event.subtype === 'string' ? event.subtype : '';
      const result = (event as { result?: unknown }).result;
      const rendered =
        typeof result === 'string' ? singleLine(result) : singleLine(JSON.stringify(result ?? null));
      return `${ts} result ${subtype} sessionId=${sessionOf(event) ?? 'unknown'}${rendered ? ` ${rendered}` : ''}`;
    }
    case 'end':
      return `${ts} end sessionId=${sessionOf(event) ?? 'unknown'}`;
    case 'error': {
      const message = typeof event.message === 'string' ? event.message : '';
      return `${ts} error sessionId=${sessionOf(event) ?? 'unknown'}${message ? ` ${singleLine(message)}` : ''}`;
    }
    default: {
      // Runtime tolerance for a future/unknown `t` value that still parses.
      const unknown = event as { t?: unknown };
      return `${ts} ${String(unknown.t ?? 'unknown')} ${singleLine(JSON.stringify(event))}`;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runRunLogCommand(args: string[], deps?: RunInspectDeps): Promise<number> {
  const parsed = parseRunLogArgs(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      printRunLogHelp();
      return 0;
    }
    console.error(parsed.error);
    return 1;
  }
  const homeDir = resolveHomeDir(deps);
  const { metaPath, logPath } = runPaths(homeDir, parsed.runId);
  if (!fs.existsSync(metaPath)) {
    console.error(`Unknown run: ${parsed.runId}`);
    return 1;
  }
  const metaRead = readMetaFile(metaPath);
  if (!metaRead.ok) {
    console.warn(`Warning: meta.json is corrupt (${metaRead.reason}); showing the log anyway`);
  }

  const printEvent = (entry: ParsedLogEvent): void => {
    console.log(parsed.json ? entry.raw : formatLogHuman(entry.event));
  };

  let read = readLogFile(logPath);
  if (read.truncated) {
    console.warn(`Warning: truncated log line in ${logPath} (ignored)`);
  }
  const initial =
    parsed.tail === null ? read.events : read.events.slice(Math.max(0, read.events.length - parsed.tail));
  for (const entry of initial) {
    printEvent(entry);
  }
  if (initial.some((entry) => entry.event.t === 'end' || entry.event.t === 'error')) {
    return 0;
  }
  if (!parsed.follow) {
    return 0;
  }

  // Follow: poll for appended lines until end/error. A torn final line is
  // re-read on the next poll, so track printed valid events only.
  let printed = read.events.length;
  let warnedTruncated = read.truncated;
  const pollMs = deps?.followPollMs ?? 100;
  for (;;) {
    await sleep(pollMs);
    read = readLogFile(logPath);
    if (read.truncated && !warnedTruncated) {
      warnedTruncated = true;
      console.warn(`Warning: truncated log line in ${logPath} (ignored)`);
    }
    if (read.events.length > printed) {
      const fresh = read.events.slice(printed);
      printed = read.events.length;
      for (const entry of fresh) {
        printEvent(entry);
      }
      if (fresh.some((entry) => entry.event.t === 'end' || entry.event.t === 'error')) {
        return 0;
      }
    }
    // A run that died without an end/error line must still release followers.
    const collected = collectRunStatus(parsed.runId, homeDir);
    if (collected.found && collected.info.state !== 'running' && read.events.length >= printed) {
      return 0;
    }
  }
}

// --- list -----------------------------------------------------------------

export function printRunListHelp(): void {
  console.log(`Usage:
  agent-deck run list [--json] [--limit <n>]

Lists recent runs, newest first. Default limit ${RUN_LIST_DEFAULT_LIMIT}.`);
}

export function parseRunListArgs(args: string[]): { json: boolean; limit: number } | { error: string } {
  let json = false;
  let limit = RUN_LIST_DEFAULT_LIMIT;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--limit') {
      const value = args[++i];
      const parsed = Number.parseInt(value ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { error: `--limit must be a non-negative integer (got "${value ?? ''}")` };
      }
      limit = parsed;
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown run list option: ${arg}` };
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }
  return { json, limit };
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

export async function runRunListCommand(args: string[], deps?: RunInspectDeps): Promise<number> {
  const parsed = parseRunListArgs(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      printRunListHelp();
      return 0;
    }
    console.error(parsed.error);
    return 1;
  }
  const infos = listRunInfos(resolveHomeDir(deps), parsed.limit);
  if (parsed.json) {
    console.log(JSON.stringify(infos));
    return 0;
  }
  if (infos.length === 0) {
    console.log('No runs yet');
    return 0;
  }
  const color = terminalColorsEnabled(process.stdout);
  for (const info of infos) {
    const session = info.sessionId ? ` ${info.sessionId}` : '';
    console.log(
      `${terminalStyle.bold(info.runId, color)} ${formatState(info.state, color)} ${info.deck} ${info.startedAt}${session}`,
    );
  }
  return 0;
}
