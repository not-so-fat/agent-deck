/**
 * `agent-deck run status|log|list` — poll a run without parsing files (NOT-402).
 *
 * Reads the run record (`meta.json`) and JSONL log through the shared run
 * service (`@agent-deck/backend/agent-run`), so foreground, detached, and
 * backend-started runs report the same state, including `died` for a
 * `running` meta whose pid is gone. This file owns arg parsing, terminal
 * formatting, and `--follow` polling.
 */
import fs from 'node:fs';

import {
  collectRunStatus,
  listRunInfos,
  logEventSessionId,
  readRunLog,
  readRunMeta,
  runPaths,
  type ParsedLogEvent,
  type RunInspectState,
  type RunStatusInfo,
} from '@agent-deck/backend/agent-run';

import { agentDeckHome } from './managed/paths';
import { terminalColorsEnabled, terminalStyle } from './terminal-style';

// Run records and their reads live in the shared run service (NOT-479);
// re-exported so existing `from './run-status'` imports keep working.
export {
  collectRunStatus,
  isRunPidAlive,
  listRunInfos,
  type CollectedStatus,
  type RunInspectState,
  type RunStatusInfo,
} from '@agent-deck/backend/agent-run';

export type RunInspectDeps = {
  homeDir?: string;
  /** Follow poll interval (tests only; default 100ms). */
  followPollMs?: number;
};

export const RUN_LIST_DEFAULT_LIMIT = 20;

function resolveHomeDir(deps?: RunInspectDeps): string {
  return deps?.homeDir ?? agentDeckHome();
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
  if (info.resumedFrom) {
    console.log(`  resumed from ${info.resumedFrom.runId} (--tools ${info.resumedFrom.tools})`);
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
known, the origin run a resume continued (resumedFrom), startedAt, last log
line time, and the log path. A running meta whose
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
      return `${ts} result ${subtype} sessionId=${logEventSessionId(event) ?? 'unknown'}${rendered ? ` ${rendered}` : ''}`;
    }
    case 'end':
      return `${ts} end sessionId=${logEventSessionId(event) ?? 'unknown'}`;
    case 'error': {
      const message = typeof event.message === 'string' ? event.message : '';
      return `${ts} error sessionId=${logEventSessionId(event) ?? 'unknown'}${message ? ` ${singleLine(message)}` : ''}`;
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
  const metaRead = readRunMeta(metaPath);
  if (!metaRead.ok) {
    console.warn(`Warning: meta.json is corrupt (${metaRead.reason}); showing the log anyway`);
  }

  const printEvent = (entry: ParsedLogEvent): void => {
    console.log(parsed.json ? entry.raw : formatLogHuman(entry.event));
  };

  let read = readRunLog(logPath);
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
    read = readRunLog(logPath);
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
