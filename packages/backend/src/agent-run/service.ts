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

import type { ClientAdapter, RunClient, RunToolsProfile } from './adapter';
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
  listRunInfos,
  metaPathForLog,
  newRunId,
  readRunLog,
  runPaths,
  writeRunMeta,
  type CollectedStatus,
  type LogRead,
  type RunLogLine,
  type RunMeta,
  type RunResumeOrigin,
  type RunStatusInfo,
} from './records';

export type RunDeck = { id: string; name: string };

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
  | 'resume_unverified';

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
};

export type FinishedRun = {
  kind: 'finished';
  runId: string;
  logPath: string;
  metaPath: string;
  state: 'ended' | 'error';
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
};

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
    };
    const startPlan = adapter.planStart(startArgs);
    if (!startPlan.ok) {
      return { kind: 'rejected', code: 'profile_unsupported', message: startPlan.remedy };
    }

    const runId = launch.runId ?? newRunId();
    const logPath = launch.logPath ?? runPaths(deps.homeDir, runId).logPath;
    const metaPath = metaPathForLog(logPath);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    const canonical = canonicalCwd(request.cwd);
    const meta: RunMeta = {
      runId,
      deck: deck.id,
      client: request.client,
      tools: request.tools,
      cwd: request.cwd,
      ...(canonical ? { canonicalCwd: canonical } : {}),
      pid: launch.pid ?? process.pid,
      startedAt: new Date().toISOString(),
      state: 'running',
      ...(startPlan.trustOverride ? { trustOverride: true as const } : {}),
      ...(resumedFrom ? { resumedFrom } : {}),
    };
    writeRunMeta(metaPath, meta);

    const stream = async (): Promise<FinishedRun> => {
      const appendLine = (line: RunLogLine): void => appendRunLogLine(logPath, line);

      let sessionId: string | null = request.resumeId ?? null;
      let metaSessionWritten = false;
      const captureSessionId = (value: unknown): void => {
        if (typeof value === 'string' && value) {
          sessionId = value;
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
        for await (const event of adapter.start(startArgs)) {
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
        appendLine({ t: 'end', ts: new Date().toISOString(), sessionId });
      } catch (error) {
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

    const completion = stream().catch((error: unknown): FinishedRun => {
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
  };
}
