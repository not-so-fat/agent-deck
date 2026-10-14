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

export type RunValidation =
  | { ok: true; deck: RunDeck; resumedFrom?: RunResumeOrigin }
  | { ok: false; error: string };

export type RunLaunchOptions = {
  /** Reuse an allocated run id (the CLI's detached child). */
  runId?: string;
  /** Custom log path; meta.json is written next to it. */
  logPath?: string;
  /** Pid recorded in meta.json for liveness checks. Defaults to this process. */
  pid?: number;
};

export type AgentRunOutcome =
  /** Failed closed before any run record was written. */
  | { kind: 'rejected'; message: string }
  | {
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

export type AgentRunService = {
  /** Everything a run must prove before it may start (shared with detached starters). */
  validate(request: AgentRunRequest): Promise<RunValidation>;
  /** Client preflight, start plan, record, and stream one validated run to a terminal state. */
  execute(prepared: PreparedRun, launch?: RunLaunchOptions): Promise<AgentRunOutcome>;
  /** validate + execute. */
  start(request: AgentRunRequest, launch?: RunLaunchOptions): Promise<AgentRunOutcome>;
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
      return { ok: false, error: 'Prompt is empty: pass a non-empty --prompt or --prompt-file' };
    }

    let cwdStat: fs.Stats;
    try {
      cwdStat = fs.statSync(request.cwd);
    } catch {
      return { ok: false, error: `--cwd does not exist: ${request.cwd}` };
    }
    if (!cwdStat.isDirectory()) {
      return { ok: false, error: `--cwd is not a directory: ${request.cwd}` };
    }

    const deck = await deps.resolveDeck(request.deckRef);
    if (!deck) {
      return { ok: false, error: `Deck not found: ${request.deckRef}` };
    }

    // Fail closed before any model call: the session's MCP launch must already
    // resolve to the requested deck. Never rewrite the folder assignment here.
    const binding = await deps.resolveDeckBinding(request.cwd);
    if (binding.deckId !== deck.id) {
      if (!binding.deckId) {
        return {
          ok: false,
          error:
            `No deck assigned in ${request.cwd}: run \`agent-deck use ${request.deckRef}\` there first, then retry. Refusing to start an unbound session.`,
        };
      }
      return {
        ok: false,
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
        return { ok: false, error: provenance.error };
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
          error:
            client.reason === 'not-installed'
              ? RUN_CLAUDE_NOT_INSTALLED_ERROR
              : RUN_CLAUDE_NOT_SIGNED_IN_ERROR,
        };
      }
    }

    return { ok: true, deck, ...(resumedFrom ? { resumedFrom } : {}) };
  };

  const execute: AgentRunService['execute'] = async ({ request, deck, resumedFrom }, launch = {}) => {
    const adapter = createAdapter(request.client);
    const preflight = await adapter.preflight();
    if (!preflight.ok) {
      return { kind: 'rejected', message: preflight.remedy };
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
      return { kind: 'rejected', message: startPlan.remedy };
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

  return {
    validate,
    execute,
    async start(request, launch) {
      const prepared = await validate(request);
      if (!prepared.ok) {
        return { kind: 'rejected', message: prepared.error };
      }
      return execute(
        { request, deck: prepared.deck, ...(prepared.resumedFrom ? { resumedFrom: prepared.resumedFrom } : {}) },
        launch,
      );
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
