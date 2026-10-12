/**
 * `agent-deck run --detach` — start the same run in a new session (NOT-401).
 *
 * The starter validates the launch exactly like a foreground run, allocates the
 * run id and log path, then re-executes the CLI as a detached child (`detached:
 * true` calls setsid on POSIX, so the child survives the calling shell, SSH
 * session, or tool call going away) with stdin from /dev/null and stdout/stderr
 * to `run.out` next to the log. Every flag of the starter is passed through
 * unchanged, so a `--tools edit` run cannot silently run as readonly.
 *
 * The starter prints `runId`, child `pid`, and the log path, then exits 0
 * within DETACH_FIRST_LINE_TIMEOUT_MS. Only one outcome is a starter failure:
 * the child died before writing its first log line — that surfaces as exit 1
 * with the tail of the child's captured output.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveCliEntry } from './daemon-logs';
import { agentDeckHome } from './managed/paths';
import {
  newRunId,
  validateRunPrereqs,
  writeRunMeta,
  type RunDeps,
  type RunMeta,
  type RunOptions,
} from './run';

/** Bounded starter return: never wait longer than this for the first log line. */
export const DETACH_FIRST_LINE_TIMEOUT_MS = 5000;

/** How often the starter polls for the first log line / child exit. */
const DETACH_POLL_MS = 50;

/** Stderr lines shown when the child dies before its first log line. */
const DETACH_TAIL_LINES = 20;

/** Child stdout/stderr sink, always next to the JSONL log. */
export function resolveRunOutPath(logPath: string): string {
  return path.join(path.dirname(logPath), 'run.out');
}

/** run.ts flags that consume the following argv token as their value. */
const RUN_VALUE_FLAGS = new Set([
  '--client',
  '--cwd',
  '--prompt',
  '--prompt-file',
  '--tools',
  '--log',
  '--resume',
  '--_run-id',
]);

/**
 * Child argv for the re-exec: the starter's own tokens verbatim (so a `--prompt`
 * value that happens to read `--detach` still arrives intact), minus `--detach`
 * itself, plus an explicit `--log` when the starter relied on the default and
 * the allocated `--_run-id` so the child reuses the same run record.
 */
export function buildDetachedChildArgs(
  originalArgs: string[],
  runId: string,
  logPath: string,
): string[] {
  const child: string[] = [];
  let hasLog = false;
  for (let i = 0; i < originalArgs.length; i += 1) {
    const arg = originalArgs[i];
    if (arg === '--detach') {
      continue;
    }
    if (arg === '--_run-id') {
      // A stale override never survives: the starter's allocation always wins.
      i += 1;
      continue;
    }
    child.push(arg);
    if (arg === '--log') {
      hasLog = true;
    }
    if (RUN_VALUE_FLAGS.has(arg)) {
      i += 1;
      if (i < originalArgs.length) {
        child.push(originalArgs[i]);
      }
    }
  }
  if (!hasLog) {
    child.push('--log', logPath);
  }
  child.push('--_run-id', runId);
  return child;
}

export type DetachedStarterDeps = RunDeps & {
  /** Override for unit tests; production spawns the real CLI entry. */
  spawnFn?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  cliEntry?: string;
  firstLineTimeoutMs?: number;
};

function logHasFirstLine(logPath: string): boolean {
  try {
    return fs.readFileSync(logPath, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

function readOutTail(outPath: string, maxLines: number): string[] {
  try {
    return fs
      .readFileSync(outPath, 'utf8')
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-maxLines);
  } catch {
    return [];
  }
}

function describeChildEnd(code: number | null, signal: string | null): string {
  if (signal) {
    return `signal ${signal}`;
  }
  return `code ${code ?? 1}`;
}

export async function startDetachedRun(
  originalArgs: string[],
  options: RunOptions,
  deps: DetachedStarterDeps = {},
): Promise<number> {
  const prereq = await validateRunPrereqs(options, deps);
  if ('error' in prereq) {
    console.error(prereq.error);
    return 1;
  }
  const { deck } = prereq;

  const homeDir = deps.homeDir ?? agentDeckHome();
  const runId = newRunId();
  const logPath = options.log ?? path.join(homeDir, 'runs', runId, 'run.jsonl');
  const metaPath = path.join(path.dirname(logPath), 'meta.json');
  const outPath = resolveRunOutPath(logPath);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const childArgs = buildDetachedChildArgs(originalArgs, runId, logPath);
  const spawnFn = deps.spawnFn ?? spawn;
  const cliEntry = deps.cliEntry ?? resolveCliEntry();
  const timeoutMs = deps.firstLineTimeoutMs ?? DETACH_FIRST_LINE_TIMEOUT_MS;

  const outFd = fs.openSync(outPath, 'a');
  fs.writeSync(outFd, `\n--- run ${runId} ${new Date().toISOString()} ---\n`);

  let child: ChildProcess;
  try {
    child = spawnFn(process.execPath, [cliEntry, 'run', ...childArgs], {
      detached: true,
      stdio: ['ignore', outFd, outFd],
    });
  } catch (error) {
    fs.closeSync(outFd);
    console.error(
      `Failed to start the detached run: ${error instanceof Error ? error.message : error}`,
    );
    return 1;
  }
  // The stdio fds are dup'd into the child at spawn; the starter's copies can go.
  fs.closeSync(outFd);

  let spawnError: Error | null = null;
  let childEnd: { code: number | null; signal: string | null } | null = null;
  child.on('error', (error) => {
    spawnError = error;
    childEnd = { code: null, signal: null };
  });
  child.on('exit', (code, signal) => {
    childEnd = { code, signal };
  });

  const pid = child.pid;
  if (!pid) {
    console.error('Failed to start the detached run: no child pid');
    return 1;
  }
  child.unref();

  const meta: RunMeta = {
    runId,
    deck: deck.id,
    client: options.client,
    tools: options.tools,
    cwd: options.cwd,
    pid,
    startedAt: new Date().toISOString(),
    state: 'running',
  };
  writeRunMeta(metaPath, meta);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (logHasFirstLine(logPath)) {
      break;
    }
    if (childEnd !== null || spawnError !== null) {
      break;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, DETACH_POLL_MS));
  }

  if (logHasFirstLine(logPath)) {
    console.log(`run ${runId} detached: pid ${pid} log ${logPath}`);
    return 0;
  }

  if (childEnd === null && spawnError === null) {
    // Slow first token, but the child is alive: the launch succeeded and the
    // starter must still return within its bound.
    console.log(`run ${runId} detached: pid ${pid} log ${logPath}`);
    return 0;
  }

  // The child died before writing its first log line: surface its last words
  // instead of reporting a launch that never happened.
  // `as` defeats narrowing: both are only assigned from event callbacks, which
  // control flow cannot see, so without it they read as still-null here.
  const failure = spawnError as Error | null;
  const end = childEnd as { code: number | null; signal: string | null } | null;
  if (failure !== null) {
    console.error(`Detached run ${runId} failed to spawn: ${failure.message}`);
  } else {
    console.error(
      `Detached run ${runId} (pid ${pid}) died before its first log line (${describeChildEnd(end?.code ?? null, end?.signal ?? null)})`,
    );
  }
  // Console output to a file fd flushes asynchronously; give the tail a beat.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const tail = readOutTail(outPath, DETACH_TAIL_LINES);
  if (tail.length === 0) {
    console.error(`[agent-deck] ${outPath} had no output to show`);
  } else {
    console.error(`[agent-deck] --- last ${tail.length} line(s) of ${outPath} ---`);
    for (const line of tail) {
      console.error(`[agent-deck] run.out| ${line}`);
    }
  }
  try {
    const current = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as RunMeta;
    if (current.runId === runId && current.state === 'running') {
      current.state = 'error';
      writeRunMeta(metaPath, current);
    }
  } catch {
    // The diagnostic above is the deliverable; meta bookkeeping never fails it.
  }
  return 1;
}
