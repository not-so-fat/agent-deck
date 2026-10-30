/**
 * Host-local agent run service (NOT-479).
 *
 * One execution attempt for a coding-agent client, shared by the
 * `agent-deck run` CLI and the backend: run prerequisites (brief, cwd, deck,
 * folder deck binding, Claude sign-in, codex resume provenance), client preflight, start/resume
 * planning, normalized event streaming into the canonical JSONL log, the
 * meta.json run record, and status/event reads. Callers own argument
 * parsing, presentation, and process placement (the CLI's `--detach`).
 *
 * Host lookups that differ between consumers — deck resolution and the
 * folder assignment — are injected; adapters are built from injectable
 * process seams, or replaced wholesale via `createAdapter` so tests never
 * launch a real model.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  RUN_CLIENT_PROFILES,
  RUN_SUPPORTED_CLIENTS,
  type ClientAdapter,
  type RunClient,
  type RunClientProfiles,
  type RunPlaybookPin,
  type RunProcessControl,
  type RunToolsProfile,
} from './adapter';
import { createClaudeAdapter, type ClaudeAdapterDeps } from './claude';
import {
  defaultClaudeClientProbe,
  RUN_CLAUDE_NOT_INSTALLED_ERROR,
  RUN_CLAUDE_NOT_SIGNED_IN_ERROR,
  type ClaudeClientProbe,
} from './claude-probe';
import { createCodexAdapter, type CodexAdapterDeps } from './codex';
import { createCursorAdapter, type CursorAdapterDeps } from './cursor';
import { createMuseAdapter, type MuseAdapterDeps } from './muse';
import { canonicalCwd, resolveResumeProvenance, resumeNeedsProvenance } from './provenance';
import {
  appendRunLogLine,
  collectRunStatus,
  findReceiptDeckMismatch,
  isRunPidAlive,
  listRunInfos,
  metaPathForLog,
  newRunId,
  readRunLog,
  readRunMeta,
  reconcileRunState,
  runPaths,
  runsRoot,
  writeRunMeta,
  type CollectedStatus,
  type LogRead,
  type RunLogLine,
  type RunInspectState,
  type RunMeta,
  type RunResumeOrigin,
  type RunStatusInfo,
} from './records';

/** Grace between SIGTERM and SIGKILL for a canceled run's process group. */
export const RUN_CANCEL_KILL_GRACE_MS = 5000;

/**
 * Stop one run-owned process group: SIGTERM, then SIGKILL after a grace
 * period. Never signals this process's own pid or a non-group id.
 */
export function defaultKillProcessGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) {
    return;
  }
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }, RUN_CANCEL_KILL_GRACE_MS);
  timer.unref();
}

export type RunDeck = { id: string; name: string };

/**
 * What `--playbook-version` validation needs about one pin (NOT-537):
 * which playbook the version snapshot belongs to (null when the version
 * id is unknown) and whether the requested playbook is on the run's deck.
 */
export type PlaybookPinResolution = {
  versionPlaybookId: string | null;
  playbookOnDeck: boolean;
};

/** The deck a working directory is assigned to; empty when unassigned. */
export type RunDeckBinding = { deckId?: string; deckName?: string };

export type RunAdapterDeps = {
  claude?: ClaudeAdapterDeps;
  codex?: CodexAdapterDeps;
  cursor?: CursorAdapterDeps;
  muse?: MuseAdapterDeps;
};

export type AgentRunServiceDeps = {
  /** Agent Deck home; run records live under `<homeDir>/runs/<runId>/`. */
  homeDir: string;
  resolveDeck: (ref: string) => Promise<RunDeck | null>;
  /** Read-only folder assignment lookup. The service never rewrites it. */
  resolveDeckBinding: (cwd: string) => Promise<RunDeckBinding>;
  /** Defaults to the real `claude auth status` probe. */
  claudeProbe?: ClaudeClientProbe;
  /** Process seams for the shipped adapters (spawn, probe, SDK loader, ...). */
  adapters?: RunAdapterDeps;
  /** Replaces adapter construction entirely (fixture adapters in tests). */
  createAdapter?: (client: RunClient) => ClientAdapter;
  /** Signals one run-owned process group (NOT-481); defaults to {@link defaultKillProcessGroup}. */
  killProcessGroup?: (pgid: number) => void;
  /**
   * Version + deck-membership lookup for `--playbook-version` (NOT-537).
   * The CLI resolves it against the local database; a run that carries a
   * pin without a resolver fails closed.
   */
  resolvePlaybookPin?: (input: {
    playbookId: string;
    versionId: string;
    deckId: string;
  }) => Promise<PlaybookPinResolution>;
};

export type AgentRunRequest = {
  /** Deck name or id as the caller named it; used in remedies. */
  deckRef: string;
  client: RunClient;
  /** Absolute working directory on this host. */
  cwd: string;
  /** Brief text (already read from any file by the caller). */
  prompt: string;
  tools: RunToolsProfile;
  /** Continue this client session id under a new run. */
  resumeId?: string;
  /** Pinned playbook version for this run's MCP session (NOT-537). */
  playbookPin?: RunPlaybookPin;
};

export type PreparedRun = {
  request: AgentRunRequest;
  deck: RunDeck;
  /** Trusted origin of `request.resumeId`, when the client requires one. */
  resumedFrom?: RunResumeOrigin;
};

/**
 * Why a run failed closed before any model call. Stable for API mapping;
 * the accompanying message stays CLI-worded for the terminal.
 */
export type AgentRunRejectionCode =
  | 'prompt_empty'
  | 'cwd_not_found'
  | 'cwd_not_directory'
  | 'deck_not_found'
  | 'deck_unassigned'
  | 'deck_mismatch'
  | 'client_unavailable'
  | 'profile_unsupported'
  | 'resume_unverified'
  // NOT-486: a host-owned `beforeStart` gate (finalization baseline capture) failed closed.
  | 'finalization_invalid'
  | 'index_dirty'
  // NOT-537: the `--playbook-version` pin is unknown, mismatched, or off-deck.
  | 'playbook_pin_invalid';

export type AgentRunValidation =
  | { ok: true; deck: RunDeck; resumedFrom?: RunResumeOrigin }
  | { ok: false; code: AgentRunRejectionCode; error: string };
export type RunLaunchOptions = {
  /** Reuse an allocated run id (the CLI's detached child). */
  runId?: string;
  /** Custom log path; meta.json is written next to it. */
  logPath?: string;
  /** Pid recorded in meta.json for liveness checks. Defaults to this process. */
  pid?: number;
  /**
   * Spawn the client as its own process group so {@link AgentRunService.cancel}
   * can stop it (NOT-481). The backend sets this; CLI runs leave it off so a
   * foreground client still receives the terminal's ^C.
   */
  ownProcessGroup?: boolean;
  /**
   * Host gate run after every validation and client preflight, immediately
   * before the run record is written and the adapter starts (NOT-486: the
   * finalization baseline). A rejection fails the launch closed with no model
   * work.
   */
  beforeStart?: () => Promise<{ ok: true } | { ok: false; code: AgentRunRejectionCode; message: string }>;
};

export type FinishedRun = {
  kind: 'finished';
  runId: string;
  logPath: string;
  metaPath: string;
  /** `canceled` when the run was canceled; `died` when abandoned at {@link AgentRunService.shutdown}. */
  state: 'ended' | 'error' | 'canceled' | 'died';
  sessionId: string | null;
  /** Deck token a session receipt named instead of the requested deck. */
  receiptMismatch: string | null;
  /** Adapter/stream failure message recorded as the `error` log line. */
  failure: string | null;
};

/** Failed closed before any run record was written. */
export type RejectedRun = { kind: 'rejected'; code: AgentRunRejectionCode; message: string };

/**
 * A run whose record is written (state `running`) and whose stream continues
 * in the background; `completion` settles at the terminal state and never
 * rejects.
 */
export type LaunchedRun = {
  kind: 'launched';
  runId: string;
  logPath: string;
  metaPath: string;
  completion: Promise<FinishedRun>;
};

export type AgentRunOutcome = RejectedRun | FinishedRun;

export type RunTerminalState = Exclude<RunInspectState, 'running'>;

export type RunCancelOutcome =
  | { kind: 'not_found' }
  /** This call canceled the run: `canceled` is recorded and the owned group signaled. */
  | { kind: 'canceled' }
  /** Already terminal: history is unchanged. */
  | { kind: 'already_terminal'; state: RunTerminalState }
  /** Running under another process that recorded no owned process group. */
  | { kind: 'not_cancelable' };

/** A `running` record that reconciliation moved to a terminal state. */
export type RunReconciliation = {
  runId: string;
  state: RunTerminalState;
  /** The run's orphaned process group was still alive and was signaled. */
  orphanSignaled: boolean;
};

/** A client whose real host preflight passed, with the profiles it can enforce. */
export type RunClientCapability = { client: RunClient } & RunClientProfiles;

export type AgentRunService = {
  /** Everything a run must prove before it may start (shared with detached starters). */
  validate(request: AgentRunRequest): Promise<AgentRunValidation>;
  /** Client preflight, start plan, record, and stream one validated run to a terminal state. */
  execute(prepared: PreparedRun, launch?: RunLaunchOptions): Promise<AgentRunOutcome>;
  /** validate + execute. */
  start(request: AgentRunRequest, launch?: RunLaunchOptions): Promise<AgentRunOutcome>;
  /**
   * validate + client preflight + start plan + run record, then return
   * without waiting for the stream. Every fail-closed gate runs before this
   * resolves, so a `rejected` result means no model work was started.
   */
  launch(request: AgentRunRequest, launch?: RunLaunchOptions): Promise<RejectedRun | LaunchedRun>;
  /** Allocate a run id and record paths without starting anything. */
  allocate(logPath?: string): { runId: string; logPath: string; metaPath: string };
  status(runId: string): CollectedStatus;
  list(limit: number): RunStatusInfo[];
  /** Ordered normalized events from the canonical JSONL log; null for an unknown run. */
  events(runId: string): LogRead | null;
  /**
   * Idempotent cancel (NOT-481): records a terminal `canceled` line and state,
   * suppresses anything the stream would write afterwards, and signals only
   * the run-owned process group.
   */
  cancel(runId: string): RunCancelOutcome;
  /**
   * Restart recovery: every `running` record not owned by this service is
   * re-derived from its owner process and canonical log; terminal results are
   * persisted and orphaned process groups signaled. Still-live runs stay.
   */
  reconcile(): RunReconciliation[];
  /** Clients whose real preflight passes on this host (no model call). */
  capabilities(): Promise<RunClientCapability[]>;
  /** Stop owned process groups without recording an outcome; they reconcile as `died`. */
  shutdown(): void;
};

/** An in-process run this service is streaming. */
type LiveRun = {
  meta: RunMeta;
  metaPath: string;
  logPath: string;
  controller: AbortController;
  sessionId: string | null;
  stopped: 'canceled' | 'abandoned' | null;
};

function recordCanceled(meta: RunMeta, metaPath: string, logPath: string, sessionId: string | null): void {
  const ts = new Date().toISOString();
  appendRunLogLine(logPath, { t: 'canceled', ts, sessionId });
  meta.state = 'canceled';
  meta.canceledAt = ts;
  writeRunMeta(metaPath, meta);
}

export function createRunAdapter(client: RunClient, deps: RunAdapterDeps = {}): ClientAdapter {
  if (client === 'codex') {
    return createCodexAdapter(deps.codex ?? {});
  }
  if (client === 'cursor') {
    return createCursorAdapter(deps.cursor ?? {});
  }
  if (client === 'muse') {
    return createMuseAdapter(deps.muse ?? {});
  }
  return createClaudeAdapter(deps.claude ?? {});
}

export function createAgentRunService(deps: AgentRunServiceDeps): AgentRunService {
  const claudeProbe = deps.claudeProbe ?? defaultClaudeClientProbe;
  const createAdapter =
    deps.createAdapter ?? ((client: RunClient) => createRunAdapter(client, deps.adapters));
  const killGroup = deps.killProcessGroup ?? defaultKillProcessGroup;
  const liveRuns = new Map<string, LiveRun>();

  const allocate = (logPath?: string): { runId: string; logPath: string; metaPath: string } => {
    const runId = newRunId();
    const resolvedLog = logPath ?? runPaths(deps.homeDir, runId).logPath;
    return { runId, logPath: resolvedLog, metaPath: metaPathForLog(resolvedLog) };
  };

  const validate: AgentRunService['validate'] = async (request) => {
    if (!request.prompt.trim()) {
      return {
        ok: false,
        code: 'prompt_empty',
        error: 'Prompt is empty: pass a non-empty --prompt or --prompt-file',
      };
    }

    let cwdStat: fs.Stats;
    try {
      cwdStat = fs.statSync(request.cwd);
    } catch {
      return { ok: false, code: 'cwd_not_found', error: `--cwd does not exist: ${request.cwd}` };
    }
    if (!cwdStat.isDirectory()) {
      return { ok: false, code: 'cwd_not_directory', error: `--cwd is not a directory: ${request.cwd}` };
    }

    const deck = await deps.resolveDeck(request.deckRef);
    if (!deck) {
      return { ok: false, code: 'deck_not_found', error: `Deck not found: ${request.deckRef}` };
    }

    // Fail closed before any model call: the session's MCP launch must already
    // resolve to the requested deck. Never rewrite the folder assignment here.
    const binding = await deps.resolveDeckBinding(request.cwd);
    if (binding.deckId !== deck.id) {
      if (!binding.deckId) {
        return {
          ok: false,
          code: 'deck_unassigned',
          error:
            `No deck assigned in ${request.cwd}: run \`agent-deck use ${request.deckRef}\` there first, then retry. Refusing to start an unbound session.`,
        };
      }
      return {
        ok: false,
        code: 'deck_mismatch',
        error:
          `Folder ${request.cwd} is bound to "${binding.deckName ?? binding.deckId}" (${binding.deckId}), not "${request.deckRef}". ` +
          `Run \`agent-deck use ${request.deckRef}\` in that folder to rebind it, then retry. Refusing to start a mis-bound session.`,
      };
    }

    // The pinned version must exist, belong to the pinned playbook, and sit
    // on the run's deck (NOT-537). Every failure lands before any model work
    // with a one-line error naming the problem.
    if (request.playbookPin) {
      if (!deps.resolvePlaybookPin) {
        return {
          ok: false,
          code: 'playbook_pin_invalid',
          error: 'Playbook pin validation is unavailable: no version resolver is configured',
        };
      }
      const pin = await deps.resolvePlaybookPin({
        playbookId: request.playbookPin.playbookId,
        versionId: request.playbookPin.versionId,
        deckId: deck.id,
      });
      if (!pin.versionPlaybookId) {
        return {
          ok: false,
          code: 'playbook_pin_invalid',
          error: `Unknown playbook version: ${request.playbookPin.versionId}`,
        };
      }
      if (pin.versionPlaybookId !== request.playbookPin.playbookId) {
        return {
          ok: false,
          code: 'playbook_pin_invalid',
          error:
            `Playbook version ${request.playbookPin.versionId} belongs to ${pin.versionPlaybookId}, ` +
            `not ${request.playbookPin.playbookId}`,
        };
      }
      if (!pin.playbookOnDeck) {
        return {
          ok: false,
          code: 'playbook_pin_invalid',
          error: `Playbook ${request.playbookPin.playbookId} is not on deck "${deck.name}"`,
        };
      }
    }

    // Codex resume cannot re-apply a sandbox, so it continues only a session
    // an Agent Deck run started with the same client, deck, canonical cwd,
    // and tool profile (NOT-484).
    let resumedFrom: RunResumeOrigin | undefined;
    if (request.resumeId !== undefined && resumeNeedsProvenance(request.client)) {
      const provenance = resolveResumeProvenance(
        deps.homeDir,
        { client: request.client, cwd: request.cwd, tools: request.tools, resumeId: request.resumeId },
        deck,
      );
      if (!provenance.ok) {
        return { ok: false, code: 'resume_unverified', error: provenance.error };
      }
      resumedFrom = provenance.origin;
    }

    // Last and slowest (it shells out to `claude auth status`): for claude runs,
    // the Claude Code client must be installed and signed in before any model
    // call (NOT-405). Other clients skip this probe; their adapters own their
    // preflight. Shared by every starter, so all fail closed with the same
    // one-line remedy instead of an SDK stack trace.
    if (request.client === 'claude') {
      const client = await claudeProbe();
      if (!client.ok) {
        return {
          ok: false,
          code: 'client_unavailable',
          error:
            client.reason === 'not-installed'
              ? RUN_CLAUDE_NOT_INSTALLED_ERROR
              : RUN_CLAUDE_NOT_SIGNED_IN_ERROR,
        };
      }
    }

    return { ok: true, deck, ...(resumedFrom ? { resumedFrom } : {}) };
  };

  /**
   * Client preflight, start plan, and the `running` record; the returned
   * completion streams the run to its terminal state.
   */
  const begin = async (
    { request, deck, resumedFrom }: PreparedRun,
    launch: RunLaunchOptions = {},
  ): Promise<RejectedRun | LaunchedRun> => {
    const adapter = createAdapter(request.client);
    const preflight = await adapter.preflight();
    if (!preflight.ok) {
      return { kind: 'rejected', code: 'client_unavailable', message: preflight.remedy };
    }
    const startArgs = {
      cwd: request.cwd,
      prompt: request.prompt,
      tools: request.tools,
      ...(request.resumeId ? { resumeId: request.resumeId } : {}),
      ...(resumedFrom ? { resumedFrom } : {}),
      ...(request.playbookPin ? { playbookPin: request.playbookPin } : {}),
    };
    const startPlan = adapter.planStart(startArgs);
    if (!startPlan.ok) {
      return { kind: 'rejected', code: 'profile_unsupported', message: startPlan.remedy };
    }
    if (launch.beforeStart) {
      const gate = await launch.beforeStart();
      if (!gate.ok) {
        return { kind: 'rejected', code: gate.code, message: gate.message };
      }
    }

    const runId = launch.runId ?? newRunId();
    const logPath = launch.logPath ?? runPaths(deps.homeDir, runId).logPath;
    const metaPath = metaPathForLog(logPath);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    const canonical = canonicalCwd(request.cwd);
    const meta: RunMeta = {
      runId,
      deck: deck.id,
      deckName: deck.name,
      client: request.client,
      tools: request.tools,
      cwd: request.cwd,
      ...(canonical ? { canonicalCwd: canonical } : {}),
      pid: launch.pid ?? process.pid,
      startedAt: new Date().toISOString(),
      state: 'running',
      ...(startPlan.trustOverride ? { trustOverride: true as const } : {}),
      ...(resumedFrom ? { resumedFrom } : {}),
      ...(request.playbookPin ? { playbookPin: request.playbookPin } : {}),
    };
    writeRunMeta(metaPath, meta);

    const live: LiveRun = {
      meta,
      metaPath,
      logPath,
      controller: new AbortController(),
      sessionId: request.resumeId ?? null,
      stopped: null,
    };
    liveRuns.set(runId, live);
    const control: RunProcessControl = {
      signal: live.controller.signal,
      onProcessGroup(pgid) {
        if (live.stopped) {
          // Canceled before the client spawned: stop it at once.
          killGroup(pgid);
          return;
        }
        meta.pgid = pgid;
        meta.pgidStartedAt = new Date().toISOString();
        writeRunMeta(metaPath, meta);
      },
    };

    const stream = async (): Promise<FinishedRun> => {
      // Nothing the client still emits after a cancel or shutdown is recorded.
      const appendLine = (line: RunLogLine): void => {
        if (!live.stopped) {
          appendRunLogLine(logPath, line);
        }
      };
      const stoppedResult = (): FinishedRun => ({
        kind: 'finished',
        runId,
        logPath,
        metaPath,
        state: live.stopped === 'canceled' ? 'canceled' : 'died',
        sessionId,
        receiptMismatch: null,
        failure: null,
      });

      let sessionId: string | null = request.resumeId ?? null;
      let metaSessionWritten = false;
      const captureSessionId = (value: unknown): void => {
        if (typeof value === 'string' && value) {
          sessionId = value;
          live.sessionId = value;
          if (!metaSessionWritten) {
            metaSessionWritten = true;
            meta.sessionId = value;
            writeRunMeta(metaPath, meta);
          } else {
            meta.sessionId = value;
          }
        }
      };

      let lastResultSubtype: string | undefined;
      const seenTexts: string[] = [];
      try {
        const adapterArgs = launch.ownProcessGroup ? { ...startArgs, control } : startArgs;
        for await (const event of adapter.start(adapterArgs)) {
          if (live.stopped) {
            break;
          }
          if (event.sessionId !== undefined) {
            captureSessionId(event.sessionId);
          }
          if (event.kind === 'text') {
            seenTexts.push(event.text);
            appendLine({ t: 'text', ts: new Date().toISOString(), text: event.text });
          } else if (event.kind === 'tool') {
            appendLine({ t: 'tool', ts: new Date().toISOString(), name: event.name });
          } else if (event.kind === 'result') {
            lastResultSubtype = event.subtype;
            appendLine({
              t: 'result',
              ts: new Date().toISOString(),
              sessionId,
              subtype: event.subtype,
              result: event.result,
              ...(event.usage !== undefined ? { usage: event.usage } : {}),
            });
          } else {
            appendLine({
              t: 'notice',
              ts: new Date().toISOString(),
              message: event.message,
              sessionId,
            });
          }
        }
        if (live.stopped) {
          return stoppedResult();
        }
        appendLine({ t: 'end', ts: new Date().toISOString(), sessionId });
      } catch (error) {
        if (live.stopped) {
          return stoppedResult();
        }
        const failure = String(error instanceof Error ? error.message : error).slice(0, 500);
        appendLine({ t: 'error', ts: new Date().toISOString(), message: failure, sessionId });
        meta.state = 'error';
        if (sessionId) {
          meta.sessionId = sessionId;
        }
        writeRunMeta(metaPath, meta);
        return {
          kind: 'finished',
          runId,
          logPath,
          metaPath,
          state: 'error',
          sessionId,
          receiptMismatch: null,
          failure,
        };
      }

      let success = lastResultSubtype === 'success';
      let receiptMismatch: string | null = null;
      if (success) {
        receiptMismatch = findReceiptDeckMismatch(seenTexts, deck);
        if (receiptMismatch) {
          success = false;
        }
      }
      meta.state = success ? 'ended' : 'error';
      if (sessionId) {
        meta.sessionId = sessionId;
      }
      writeRunMeta(metaPath, meta);
      return {
        kind: 'finished',
        runId,
        logPath,
        metaPath,
        state: meta.state,
        sessionId,
        receiptMismatch,
        failure: null,
      };
    };

    const completion = stream()
      .finally(() => {
        liveRuns.delete(runId);
      })
      .catch((error: unknown): FinishedRun => {
      // Record bookkeeping itself failed (disk full, removed run dir). Keep
      // the completion promise non-rejecting; status falls back to the pid.
      const failure = String(error instanceof Error ? error.message : error).slice(0, 500);
      return {
        kind: 'finished',
        runId,
        logPath,
        metaPath,
        state: 'error',
        sessionId: request.resumeId ?? null,
        receiptMismatch: null,
        failure,
      };
    });
    return { kind: 'launched', runId, logPath, metaPath, completion };
  };

  const execute: AgentRunService['execute'] = async (prepared, launch) => {
    const begun = await begin(prepared, launch);
    return begun.kind === 'rejected' ? begun : begun.completion;
  };

  const prepare = async (request: AgentRunRequest): Promise<PreparedRun | RejectedRun> => {
    const validation = await validate(request);
    if (!validation.ok) {
      return { kind: 'rejected', code: validation.code, message: validation.error };
    }
    return {
      request,
      deck: validation.deck,
      ...(validation.resumedFrom ? { resumedFrom: validation.resumedFrom } : {}),
    };
  };

  return {
    validate,
    execute,
    async start(request, launch) {
      const prepared = await prepare(request);
      return 'kind' in prepared ? prepared : execute(prepared, launch);
    },
    async launch(request, launch) {
      const prepared = await prepare(request);
      return 'kind' in prepared ? prepared : begin(prepared, launch);
    },
    allocate,
    status: (runId) => collectRunStatus(runId, deps.homeDir),
    list: (limit) => listRunInfos(deps.homeDir, limit),
    events(runId) {
      const { metaPath, logPath } = runPaths(deps.homeDir, runId);
      return fs.existsSync(metaPath) ? readRunLog(logPath) : null;
    },
    cancel(runId) {
      const live = liveRuns.get(runId);
      if (live?.stopped === 'canceled') {
        return { kind: 'already_terminal', state: 'canceled' };
      }
      if (live && !live.stopped) {
        live.stopped = 'canceled';
        recordCanceled(live.meta, live.metaPath, live.logPath, live.sessionId);
        live.controller.abort();
        if (live.meta.pgid !== undefined) {
          killGroup(live.meta.pgid);
        }
        return { kind: 'canceled' };
      }

      const { metaPath, logPath } = runPaths(deps.homeDir, runId);
      if (!fs.existsSync(metaPath)) {
        return { kind: 'not_found' };
      }
      const read = readRunMeta(metaPath);
      if (!read.ok) {
        return { kind: 'already_terminal', state: 'error' };
      }
      const meta = read.meta;
      const log = readRunLog(logPath);
      const state = reconcileRunState(meta, log);
      if (state !== 'running') {
        return { kind: 'already_terminal', state };
      }
      // Live under another process: cancel only through the group it recorded.
      if (meta.pgid !== undefined && isRunPidAlive(meta.pgid, meta.pgidStartedAt ?? meta.startedAt)) {
        recordCanceled(meta, metaPath, logPath, meta.sessionId ?? log.lastSessionId);
        killGroup(meta.pgid);
        return { kind: 'canceled' };
      }
      return { kind: 'not_cancelable' };
    },
    reconcile() {
      let entries: string[];
      try {
        entries = fs.readdirSync(runsRoot(deps.homeDir));
      } catch {
        return [];
      }
      const reconciled: RunReconciliation[] = [];
      for (const runId of entries.sort()) {
        if (liveRuns.has(runId)) {
          continue;
        }
        const { metaPath, logPath } = runPaths(deps.homeDir, runId);
        const read = readRunMeta(metaPath);
        if (!read.ok || read.meta.state !== 'running') {
          continue;
        }
        const meta = read.meta;
        const state = reconcileRunState(meta, readRunLog(logPath));
        if (state === 'running') {
          continue;
        }
        // The owner is gone, so nothing records this group's output any more.
        let orphanSignaled = false;
        if (meta.pgid !== undefined && isRunPidAlive(meta.pgid, meta.pgidStartedAt ?? meta.startedAt)) {
          killGroup(meta.pgid);
          orphanSignaled = true;
        }
        writeRunMeta(metaPath, { ...meta, state });
        reconciled.push({ runId, state, orphanSignaled });
      }
      return reconciled;
    },
    async capabilities() {
      const available: RunClientCapability[] = [];
      for (const client of RUN_SUPPORTED_CLIENTS) {
        // Same gates a launch runs: the Claude sign-in probe, then the adapter preflight.
        if (client === 'claude' && !(await claudeProbe()).ok) {
          continue;
        }
        const preflight = await createAdapter(client).preflight();
        if (preflight.ok) {
          available.push({ client, ...RUN_CLIENT_PROFILES[client] });
        }
      }
      return available;
    },
    shutdown() {
      for (const live of liveRuns.values()) {
        if (live.stopped) {
          continue;
        }
        live.stopped = 'abandoned';
        live.controller.abort();
        if (live.meta.pgid !== undefined) {
          killGroup(live.meta.pgid);
        }
      }
    },
  };
}
