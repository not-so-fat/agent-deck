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
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { RunClient, RunPlaybookPin } from './adapter';
import type { RunToolsProfile } from './profiles';

export type RunLogLine =
  | { t: 'text'; ts: string; text: string }
  | { t: 'tool'; ts: string; name: string }
  | {
      t: 'result';
      ts: string;
      sessionId: string | null;
      subtype: string;
      result: unknown;
      /** Client-reported token usage; present only when the adapter reports it. */
      usage?: unknown;
    }
  | { t: 'end'; ts: string; sessionId: string | null }
  | { t: 'notice'; ts: string; message: string; sessionId: string | null }
  | { t: 'error'; ts: string; message: string; sessionId: string | null }
  /** Operator cancellation (NOT-481): terminal, and nothing after it counts. */
  | { t: 'canceled'; ts: string; sessionId: string | null };

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

/** Recorded lifecycle. `died` and evidence-derived states are written only by reconciliation (NOT-481). */
export type RunMetaState = 'running' | 'ended' | 'error' | 'canceled' | 'died';

/**
 * NOT-669: what denied an action. `agent-deck` is the MCP server's own
 * enforcement (an MCP tool call outside the effective profile); `client`
 * is a denial the client adapter reported back.
 */
export type RunDenialSource = 'agent-deck' | 'client';

/**
 * NOT-669: what kind of action was denied. `mcp_tool` is reserved for
 * Agent Deck's server-side enforcement; adapters report the client-native
 * kinds through the `denial` normalized event.
 */
export type RunDenialKind = 'mcp_tool' | 'shell' | 'file_write' | 'network' | 'client_tool';

/**
 * NOT-669: one profile denial recorded on a run. `target` names what was
 * denied (the MCP tool name for `kind: "mcp_tool"`); `profile` is the
 * run's effective profile at denial time. Same shape as the shared
 * `AgentRunDenialSchema`, declared here because agent-run imports nothing
 * outside node built-ins and its own modules.
 */
export type RunDenial = {
  at: string;
  client: RunClient;
  profile: RunToolsProfile;
  source: RunDenialSource;
  kind: RunDenialKind;
  target: string;
  reason: string;
};

export type RunMeta = {
  runId: string;
  deck: string;
  /** Deck name at launch; lets reconciliation re-run the session receipt check. */
  deckName?: string;
  client: RunClient;
  tools: RunToolsProfile;
  cwd: string;
  /** Realpath of `cwd` at launch; resume provenance compares against it. */
  canonicalCwd?: string;
  pid: number;
  startedAt: string;
  state: RunMetaState;
  sessionId?: string;
  /**
   * Process group the run owns (the client process it spawned as a group
   * leader), with the time it was recorded for pid-reuse checks. Cancellation
   * and orphan cleanup signal only this group (NOT-481).
   */
  pgid?: number;
  pgidStartedAt?: string;
  canceledAt?: string;
  /** Present only when the launch bypassed a client workspace-trust guard. */
  trustOverride?: true;
  /** Present only on a resume: the run that started the session. */
  resumedFrom?: RunResumeOrigin;
  /** Present only on a pinned run: the playbook version the session read (NOT-537). */
  playbookPin?: RunPlaybookPin;
  /**
   * Trusted-session id (NOT-640) of the MCP session that started the run.
   * Lets the starter read status and events after switching decks; absent
   * on runs written before NOT-640 and on non-session starts (CLI, grants).
   */
  startedBySessionId?: string;
  /**
   * NOT-669: SHA-256 hex of the run's unguessable worker token, minted at
   * launch/resume. The plaintext token is passed to the adapter only and
   * never appears in the record, the log, or status reads.
   */
  runTokenHash?: string;
  /** NOT-669: profile denials recorded on this run, oldest first. */
  denials?: RunDenial[];
};

export type RunInspectState = RunMetaState;

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
  /** NOT-669: the worker profile enforced on this run. */
  effectiveProfile: RunToolsProfile;
  /** NOT-669: profile denials recorded on this run, oldest first. */
  denials: RunDenial[];
};

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `run-${stamp}-${randomBytes(3).toString('hex')}`;
}

/**
 * NOT-669: mint one run's unguessable worker token (32 random bytes, hex).
 * Passed to the adapter as `AdapterStartArgs.runToken`; only
 * {@link hashRunToken} of it is ever stored.
 */
export function mintRunToken(): string {
  return randomBytes(32).toString('hex');
}

/** NOT-669: SHA-256 hex of a worker token — the only form ever stored. */
export function hashRunToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** NOT-669: tokens are exactly the minted shape; anything else is rejected without a lookup. */
export function isRunTokenFormat(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
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
 * NOT-669 repair: cross-process mutual exclusion for one run record.
 * `meta.json` is written from several processes at once — the run service
 * (state, session, client-reported denials), the MCP server (server-side
 * denials), the CLI, reconciliation — and every write is read-modify-write,
 * so two processes interleaving read/write lose each other's update (in
 * particular a recorded denial). The lock serializes the whole critical
 * section; the atomic rename below then only keeps readers on complete
 * documents.
 *
 * The lock is a sibling directory (`meta.json.lock`): `mkdir` is atomic on
 * POSIX and Windows, and an empty directory needs no cleanup protocol. A
 * lock older than `RUN_META_LOCK_STALE_MS` belongs to a crashed holder and
 * is broken. Reentrant within one process (nested `withRunMetaLock` for the
 * same record runs straight through — `appendRunDenial` calls
 * `writeRunMeta` under its own lock); across processes the directory still
 * serializes. When the lock cannot be acquired in time the critical section
 * NEVER runs unlocked — that would reintroduce the lost-update race the
 * lock exists to prevent — and {@link RunMetaLockTimeoutError} is thrown
 * instead. Callers fail loudly (`writeRunMeta`) or degrade safely
 * (`appendRunDenial` retries once, then reports `false`).
 */
const RUN_META_LOCK_STALE_MS = 10_000;
const RUN_META_LOCK_WAIT_MS = 5_000;
const RUN_META_LOCK_POLL_MS = 20;

/** NOT-669 repair round 3: the record lock stayed held past the wait budget. Never bypassed. */
export class RunMetaLockTimeoutError extends Error {
  readonly metaPath: string;
  constructor(metaPath: string) {
    super(`Timed out acquiring the run record lock for ${metaPath}`);
    this.name = 'RunMetaLockTimeoutError';
    this.metaPath = metaPath;
  }
}

const RUN_META_LOCKS_HELD = new Set<string>();

function sleepSyncMs(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No shared memory in this runtime: busy-spin briefly instead.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Intentional spin: lock polling only.
    }
  }
}

export function withRunMetaLock<T>(metaPath: string, fn: () => T): T {
  const lockDir = `${metaPath}.lock`;
  if (RUN_META_LOCKS_HELD.has(lockDir)) {
    return fn();
  }
  const deadline = Date.now() + RUN_META_LOCK_WAIT_MS;
  let acquired = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
      break;
    } catch {
      try {
        const ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (ageMs > RUN_META_LOCK_STALE_MS) {
          try {
            fs.rmdirSync(lockDir);
          } catch {
            // Another process broke or released it first; retry.
          }
          continue;
        }
      } catch {
        // The lock vanished between mkdir and stat; retry.
      }
      sleepSyncMs(RUN_META_LOCK_POLL_MS);
    }
  }
  if (!acquired) {
    throw new RunMetaLockTimeoutError(metaPath);
  }
  RUN_META_LOCKS_HELD.add(lockDir);
  try {
    return fn();
  } finally {
    RUN_META_LOCKS_HELD.delete(lockDir);
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Broken as stale by a waiter, or removed with the run dir.
    }
  }
}

/**
 * Atomic run-record write: readers (`run status`, detach tests, orchestrators)
 * poll meta.json while the run child rewrites it, and a plain writeFileSync
 * truncates before writing — a concurrent read lands on empty/partial bytes
 * and JSON.parse throws. Writing to a sibling temp file and renaming keeps
 * every observed state a complete document (rename is atomic on POSIX and
 * Windows). The pid suffix keeps the starter's and the child's temp files
 * distinct when both target the same meta.json.
 *
 * NOT-669: denials are append-only across processes — the MCP server records
 * server-side denials while the run service holds its own in-memory meta —
 * so a write never drops denials recorded since the caller's meta was read:
 * the disk read, the union, and the rename all run under the record lock,
 * and entries on disk that the caller's meta lacks are unioned in (by value;
 * entries are immutable once written, so this cannot duplicate or resurrect
 * anything). The union is merged chronologically by `at` (stable for ties)
 * so the record keeps its oldest-first contract no matter which side wrote
 * first. No caller clears denials.
 */
export function writeRunMeta(metaPath: string, meta: RunMeta): void {
  withRunMetaLock(metaPath, () => {
    let merged = meta.denials;
    try {
      const disk = readRunMeta(metaPath);
      if (disk.ok && disk.meta.denials?.length) {
        const known = new Set((meta.denials ?? []).map((denial) => JSON.stringify(denial)));
        const missing = disk.meta.denials.filter((denial) => !known.has(JSON.stringify(denial)));
        if (missing.length > 0) {
          merged = [...(meta.denials ?? []), ...missing].sort((a, b) => {
            const left = typeof a.at === 'string' ? a.at : '';
            const right = typeof b.at === 'string' ? b.at : '';
            return left < right ? -1 : left > right ? 1 : 0;
          });
        }
      }
    } catch {
      // Best effort: the state write below still lands.
    }
    const tmpPath = `${metaPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify({ ...meta, ...(merged ? { denials: merged } : {}) }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, metaPath);
  });
}

export function appendRunLogLine(logPath: string, line: RunLogLine): void {
  fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`, 'utf8');
}

/**
 * NOT-669: append one denial to a run record, oldest first. Read-modify-write
 * through the atomic meta write, for recorders that hold no live meta (the
 * MCP server process recording a server-side denial). Returns false when the
 * record is missing or corrupt, or when the record stays locked through a
 * bounded retry, instead of throwing — so a denial can never fail an
 * unrelated request (the denial itself was still enforced). The caller logs
 * a `false` loudly.
 *
 * The read, the append, and the write all run under the record lock, so a
 * concurrent service write in another process cannot land between them and
 * lose the entry — the post-write read verifies the entry landed durably,
 * and re-recording the same denial is a no-op. One retry: a waiter that
 * starts right after a holder crashes can time out while the abandoned lock
 * is still too fresh to break as stale; the second attempt then breaks it
 * and lands the denial. The fingerprint check makes the retry idempotent.
 */
export function appendRunDenial(metaPath: string, denial: RunDenial): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return withRunMetaLock(metaPath, () => {
        const read = readRunMeta(metaPath);
        if (!read.ok) {
          return false;
        }
        const fingerprint = JSON.stringify(denial);
        if ((read.meta.denials ?? []).some((entry) => JSON.stringify(entry) === fingerprint)) {
          return true;
        }
        read.meta.denials = [...(read.meta.denials ?? []), denial];
        writeRunMeta(metaPath, read.meta);
        const verify = readRunMeta(metaPath);
        return (
          verify.ok && (verify.meta.denials ?? []).some((entry) => JSON.stringify(entry) === fingerprint)
        );
      });
    } catch (error) {
      if (error instanceof RunMetaLockTimeoutError && attempt === 0) {
        continue;
      }
      if (error instanceof RunMetaLockTimeoutError) {
        return false;
      }
      throw error;
    }
  }
  return false;
}

/**
 * NOT-669: append one denial to a live in-memory meta (the run service
 * recording a client-reported `denial` event). Pure push — the caller owns
 * the write, so nothing the live meta holds is clobbered by a re-read.
 */
export function recordRunDenial(meta: RunMeta, denial: RunDenial): void {
  meta.denials = [...(meta.denials ?? []), denial];
}

/**
 * NOT-669: root of the token→record pointer index. A sibling of the runs
 * root (never inside it) so raw `runs/` scans keep seeing run dirs only.
 */
export function runTokenPointerRoot(homeDir: string): string {
  return path.join(homeDir, 'runs-by-token');
}

/**
 * NOT-669: where the token→record pointer for `tokenHash` lives. Every
 * launch/resume writes one — including runs with a custom `--log` path,
 * whose records live outside the runs root and are otherwise undiscoverable
 * (unlike resume provenance, worker enforcement must reach those runs).
 * The pointer names the meta path; the token itself never appears.
 */
export function runTokenPointerPath(homeDir: string, tokenHash: string): string {
  return path.join(runTokenPointerRoot(homeDir), `${tokenHash}.json`);
}

/**
 * NOT-669: record where the run carrying `tokenHash` keeps its meta. Atomic
 * (sibling temp file + rename), idempotent, and safe to call from any
 * process — concurrent launches mint distinct hashes, so pointers never
 * collide. Failure to write the pointer must fail the launch (the caller
 * decides): without it a custom-`--log` run's worker session could never
 * resolve server-side.
 */
export function writeRunTokenPointer(
  homeDir: string,
  tokenHash: string,
  runId: string,
  metaPath: string,
): void {
  const pointerPath = runTokenPointerPath(homeDir, tokenHash);
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  const tmpPath = `${pointerPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify({ runId, metaPath })}\n`, 'utf8');
  fs.renameSync(tmpPath, pointerPath);
}

/**
 * NOT-669: resolve a worker token hash to its run record. The token pointer
 * (written at every launch/resume, including custom-`--log` runs) is read
 * first; the default-records scan stays as a fallback for records written
 * before pointers existed. Returns null when no record carries the hash.
 */
export function findRunMetaByTokenHash(
  homeDir: string,
  tokenHash: string,
): { runId: string; metaPath: string; meta: RunMeta } | null {
  try {
    const raw = fs.readFileSync(runTokenPointerPath(homeDir, tokenHash), 'utf8');
    const pointer = JSON.parse(raw) as { runId?: unknown; metaPath?: unknown };
    if (typeof pointer.metaPath === 'string' && pointer.metaPath) {
      const read = readRunMeta(pointer.metaPath);
      if (read.ok && read.meta.runTokenHash === tokenHash) {
        return { runId: read.meta.runId, metaPath: pointer.metaPath, meta: read.meta };
      }
    }
  } catch {
    // No pointer (or a stale one): fall through to the scan.
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(runsRoot(homeDir));
  } catch {
    return null;
  }
  for (const runId of entries) {
    const metaPath = runPaths(homeDir, runId).metaPath;
    const read = readRunMeta(metaPath);
    if (read.ok && read.meta.runTokenHash === tokenHash) {
      return { runId, metaPath, meta: read.meta };
    }
  }
  return null;
}

const RUN_META_STATES: readonly RunMetaState[] = ['running', 'ended', 'error', 'canceled', 'died'];

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
    !(RUN_META_STATES as readonly unknown[]).includes(partial.state)
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
  sawCanceled: boolean;
  /** Subtype of the last `result` line; null when the client never reported one. */
  lastResultSubtype: string | null;
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
    sawCanceled: false,
    lastResultSubtype: null,
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
    } else if (event.t === 'canceled') {
      empty.sawCanceled = true;
    } else if (event.t === 'result') {
      empty.lastResultSubtype = typeof event.subtype === 'string' ? event.subtype : '';
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

/**
 * Session receipt check: the agent harness prints the bound deck as one
 * `get_session_context` receipt line rendering `display_summary`
 * (e.g. `◆ dev · 2 MCP · 0 keys · 1 playbooks`). Returns the mismatching deck
 * token when the log positively shows a deck other than the requested one;
 * a missing receipt is not a mismatch (the pre-start assignment gate is the
 * fail-closed check; this is a second net for a mis-bound session).
 * The fragments are joined before scanning: real clients stream token-level
 * deltas, so one receipt line can arrive split across many text events and a
 * per-fragment scan would miss the mismatch.
 */
export function findReceiptDeckMismatch(
  texts: readonly string[],
  deck: { id: string; name: string },
): string | null {
  const joined = texts.join('');
  const pattern = /◆\s*([^·\r\n]+?)\s*·/g;
  for (const match of joined.matchAll(pattern)) {
    const token = match[1].trim();
    if (token && token !== deck.name && token !== deck.id) {
      return token;
    }
  }
  return null;
}

/**
 * Terminal state the canonical log proves for a run whose recorded owner is
 * gone, or null when the log holds no terminal line. `ended` needs the same
 * evidence the live run uses — an `end` after a `success` result and a
 * receipt that names the run's deck — so a crash between the last log line
 * and the meta write never reads as more successful than the run was.
 */
function terminalFromLog(meta: RunMeta, log: LogRead): 'ended' | 'error' | null {
  if (log.sawError) {
    return 'error';
  }
  if (!log.sawEnd) {
    return null;
  }
  if (log.lastResultSubtype !== 'success' || !meta.deckName) {
    return 'error';
  }
  const texts = log.events.flatMap(({ event }) => (event.t === 'text' ? [event.text] : []));
  return findReceiptDeckMismatch(texts, { id: meta.deck, name: meta.deckName }) ? 'error' : 'ended';
}

/**
 * Truthful state from the run record, the canonical log, and the recorded
 * owner process (NOT-481). A `canceled` line is final whatever follows it; a
 * recorded terminal state stands; a `running` record is `running` only while
 * its owner lives, then whatever terminal state the log proves, else `died`.
 * Launch acknowledgement and a missing process never read as success.
 */
export function reconcileRunState(
  meta: RunMeta,
  log: LogRead,
  isAlive: (pid: number, startedAt: string) => boolean = isRunPidAlive,
): RunInspectState {
  if (log.sawCanceled || meta.state === 'canceled') {
    return 'canceled';
  }
  if (meta.state !== 'running') {
    return meta.state;
  }
  if (isAlive(meta.pid, meta.startedAt)) {
    return 'running';
  }
  return terminalFromLog(meta, log) ?? 'died';
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
        state: reconcileRunState(meta, log),
        sessionId,
        startedAt: meta.startedAt,
        lastLogTs: log.lastTs,
        logPath,
        ...(meta.resumedFrom ? { resumedFrom: meta.resumedFrom } : {}),
        effectiveProfile: meta.tools,
        denials: meta.denials ?? [],
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
      effectiveProfile: partial.tools === 'edit' ? 'edit' : 'readonly',
      denials: Array.isArray(partial.denials) ? (partial.denials as RunDenial[]) : [],
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
