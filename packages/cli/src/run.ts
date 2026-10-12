/**
 * `agent-deck run` — start a local agent session bound to a deck (NOT-400, NOT-404).
 *
 * Productizes the throwaway botmancers runner: one command takes a deck, a
 * working directory, and a brief, streams the session to a JSONL log, and
 * records a small meta.json that later tickets (detach, status) can read.
 * Resume continues the same client session id under a new run log.
 *
 * Client-specific launching lives behind the {@link ClientAdapter} interface
 * (`run-adapter.ts`); this file owns arg parsing, the deck binding gate,
 * tool profiles, the JSONL log, and meta.json. New adapters plug in without
 * touching this file's run/log/status paths.
 *
 * `--detach` (NOT-401) re-executes this same command as a background child;
 * status/log/list (NOT-402) poll the run record the child writes.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createCollectionAdmin } from './backend-runtime';
import { agentDeckHome } from './managed/paths';
import { resolveMcpLaunchPlan } from './mcp-launcher';
import {
  missingRunClientMessage,
  runClientMessage,
  type ClientAdapter,
  type RunClient,
  type RunToolsProfile,
} from './run-adapter';
import {
  createClaudeAdapter,
  type ClaudeAdapterDeps,
  type RunQueryFn,
  type RunQueryMessage,
  type RunQueryOptions,
} from './run-claude';
import { createCodexAdapter, type CodexAdapterDeps } from './run-codex';
import { createCursorAdapter, type CursorAdapterDeps } from './run-cursor';

// Tool profiles stay owned by the shared run code (re-exported so existing
// `from './run'` imports keep working).
export {
  allowedToolsForProfile,
  RUN_EDIT_TOOLS,
  RUN_PERMISSION_MODE,
  RUN_READONLY_TOOLS,
  RUN_SETTING_SOURCES,
  RUN_TOOL_PROFILES,
  type RunToolsProfile,
} from './run-adapter';
export type { RunClient } from './run-adapter';
export type { ClaudeAdapterDeps, RunQueryFn, RunQueryMessage, RunQueryOptions } from './run-claude';
export type { CodexAdapterDeps } from './run-codex';
export type { CursorAdapterDeps } from './run-cursor';

export type RunOptions = {
  deckRef: string;
  client: RunClient;
  cwd: string;
  prompt?: string;
  promptFile?: string;
  tools: RunToolsProfile;
  log?: string;
  resume?: string;
  detach: boolean;
  /** Internal: the starter passes the allocated run id so the child reuses it. */
  runIdOverride?: string;
};

export function parseRunArgs(args: string[]): RunOptions | { error: string } {
  let deckRef: string | undefined;
  let client: string | undefined;
  let cwd: string | undefined;
  let prompt: string | undefined;
  let promptFile: string | undefined;
  let tools = 'readonly';
  let log: string | undefined;
  let resume: string | undefined;
  let detach = false;
  let runIdOverride: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--client') {
      client = args[++i];
    } else if (arg === '--cwd') {
      cwd = args[++i];
    } else if (arg === '--prompt') {
      prompt = args[++i];
    } else if (arg === '--prompt-file') {
      promptFile = args[++i];
    } else if (arg === '--tools') {
      tools = args[++i] ?? '';
    } else if (arg === '--log') {
      log = args[++i];
    } else if (arg === '--resume') {
      resume = args[++i];
    } else if (arg === '--detach') {
      detach = true;
    } else if (arg === '--_run-id') {
      runIdOverride = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      return { error: 'help' };
    } else if (arg.startsWith('-')) {
      return { error: `Unknown run option: ${arg}` };
    } else if (!deckRef) {
      deckRef = arg;
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
  }

  if (!deckRef) {
    return { error: 'deck name or id is required' };
  }
  if (!client) {
    return { error: missingRunClientMessage() };
  }
  if (client !== 'claude' && client !== 'codex' && client !== 'cursor') {
    return { error: runClientMessage(client) };
  }
  if (!cwd) {
    return { error: '--cwd is required' };
  }
  if (prompt !== undefined && promptFile !== undefined) {
    return { error: 'Pass exactly one of --prompt or --prompt-file' };
  }
  if (prompt === undefined && promptFile === undefined) {
    return { error: 'A brief is required: pass --prompt <text> or --prompt-file <path>' };
  }
  if (tools !== 'readonly' && tools !== 'edit') {
    return { error: `--tools must be one of: readonly, edit (got "${tools}")` };
  }

  return {
    deckRef,
    client,
    cwd: path.resolve(cwd),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(promptFile !== undefined ? { promptFile } : {}),
    tools,
    ...(log ? { log: path.resolve(log) } : {}),
    ...(resume ? { resume } : {}),
    detach,
    ...(runIdOverride ? { runIdOverride } : {}),
  };
}

export type RunLogLine =
  | { t: 'text'; ts: string; text: string }
  | { t: 'tool'; ts: string; name: string }
  | { t: 'result'; ts: string; sessionId: string | null; subtype: string; result: unknown }
  | { t: 'end'; ts: string; sessionId: string | null }
  | { t: 'notice'; ts: string; message: string; sessionId: string | null }
  | { t: 'error'; ts: string; message: string; sessionId: string | null };

export type RunMeta = {
  runId: string;
  deck: string;
  client: RunClient;
  tools: RunToolsProfile;
  cwd: string;
  pid: number;
  startedAt: string;
  state: 'running' | 'ended' | 'error';
  sessionId?: string;
  /** Present only when the launch bypassed a client workspace-trust guard. */
  trustOverride?: true;
};

export type RunDeps = {
  /** NOT-400 seam, kept for compatibility: injected `query()` for the Claude adapter. */
  query?: RunQueryFn;
  /** Injected in tests; production lazily requires the Claude Agent SDK. */
  claude?: ClaudeAdapterDeps;
  /** Injected in tests; production spawns the real `codex` binary. */
  codex?: CodexAdapterDeps;
  /** Injected in tests; production spawns the real `cursor-agent` binary. */
  cursor?: CursorAdapterDeps;
  resolveDeck?: (ref: string) => Promise<{ id: string; name: string } | null>;
  resolveLaunchPlan?: typeof resolveMcpLaunchPlan;
  homeDir?: string;
  /** Injected in tests; production probes the local Claude Code CLI (NOT-405). */
  claudeProbe?: ClaudeClientProbe;
};

/** Outcome of the Claude Code client probe: installed and signed in, or why not. */
export type ClaudeClientStatus =
  | { ok: true }
  | { ok: false; reason: 'not-installed' | 'not-signed-in' };

export type ClaudeClientProbe = () => Promise<ClaudeClientStatus> | ClaudeClientStatus;

/** The one fix command both preflight remedies name. Verified against `claude auth --help`. */
export const CLAUDE_AUTH_LOGIN_COMMAND = 'claude auth login';

export const RUN_CLAUDE_NOT_INSTALLED_ERROR =
  `Claude Code is not installed (no \`claude\` on PATH). Install Claude Code, then run \`${CLAUDE_AUTH_LOGIN_COMMAND}\` to sign in, then retry.`;

export const RUN_CLAUDE_NOT_SIGNED_IN_ERROR =
  `Claude Code is not signed in. Run \`${CLAUDE_AUTH_LOGIN_COMMAND}\` to sign in with your own account, then retry.`;

/** First executable `name` on `pathEnv`, or null. Pure apart from the fs check. */
export function findExecutableOnPath(name: string, pathEnv = process.env.PATH ?? ''): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here; keep scanning.
    }
  }
  return null;
}

/**
 * True only when `claude auth status` JSON reports a login. Never throws:
 * garbage, an empty string, or a logged-out report all read as signed out.
 */
export function claudeAuthStatusShowsLogin(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Default Claude Code preflight: the `claude` CLI must be on PATH and
 * `claude auth status` must report a login. Local only — no model call.
 * An explicit ANTHROPIC_API_KEY passes without the OAuth check once the
 * `claude` CLI is found on PATH (API-key onboarding stays out of scope;
 * the friend path signs in via `claude auth login`). Any other failure —
 * logged out, unparseable output, a hung or crashed `claude` — reads as
 * not signed in; re-running the login is the remedy in every case.
 */
export async function defaultClaudeClientProbe(): Promise<ClaudeClientStatus> {
  const claudePath = findExecutableOnPath('claude');
  if (!claudePath) {
    return { ok: false, reason: 'not-installed' };
  }
  if ((process.env.ANTHROPIC_API_KEY ?? '').trim()) {
    return { ok: true };
  }
  try {
    const out = execFileSync(claudePath, ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return claudeAuthStatusShowsLogin(out)
      ? { ok: true }
      : { ok: false, reason: 'not-signed-in' };
  } catch (error) {
    // The binary vanished between the PATH scan and the exec.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: false, reason: 'not-installed' };
    }
    return { ok: false, reason: 'not-signed-in' };
  }
}

/**
 * Test-only fake runner for the `run --detach` integration suite. The detached
 * child is a real process, so dependency injection cannot reach it; instead the
 * suite points AGENT_DECK_RUN_FAKE at a JSON behavior file and both the starter
 * (deck lookup) and the child (deck lookup + model stream) honor it. Explicit
 * `deps` always win, so unit tests are unaffected. Never set in production.
 */
export const RUN_FAKE_ENV = 'AGENT_DECK_RUN_FAKE';

export type RunFakeBehavior = {
  deckId?: string;
  deckName?: string;
  /** success: yield text then a success result; fail: throw; crash: exit silently-ish. */
  mode?: 'success' | 'fail' | 'crash';
  lineDelayMs?: number;
  endDelayMs?: number;
  sessionId?: string;
  text?: string;
  error?: string;
  exitCode?: number;
  crashStderr?: string;
  /** When set, the received { prompt, options } are recorded here as JSON. */
  recordOptionsPath?: string;
};

export function loadRunFakeBehavior(): RunFakeBehavior | null {
  const file = process.env[RUN_FAKE_ENV]?.trim();
  if (!file) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RunFakeBehavior;
  } catch {
    throw new Error(`Cannot read ${RUN_FAKE_ENV} behavior file: ${file}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeQueryFromBehavior(behavior: RunFakeBehavior): RunQueryFn {
  const sessionId = behavior.sessionId ?? 'ses_fake';
  return async function* ({ prompt, options }: {
    prompt: string;
    options: RunQueryOptions;
  }): AsyncGenerator<RunQueryMessage> {
    if (behavior.recordOptionsPath) {
      fs.mkdirSync(path.dirname(behavior.recordOptionsPath), { recursive: true });
      fs.writeFileSync(
        behavior.recordOptionsPath,
        `${JSON.stringify({ prompt, options }, null, 2)}\n`,
        'utf8',
      );
    }
    if (behavior.mode === 'crash') {
      // A crash leaves no log line behind: sync write, then out with no yield.
      fs.writeSync(2, `${behavior.crashStderr ?? 'fake runner crashed'}\n`);
      process.exit(behavior.exitCode ?? 1);
    }
    if (behavior.lineDelayMs) {
      await sleep(behavior.lineDelayMs);
    }
    if (behavior.mode === 'fail') {
      throw new Error(behavior.error ?? 'fake runner failed');
    }
    yield {
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: behavior.text ?? 'fake runner here' }] },
    };
    if (behavior.endDelayMs) {
      await sleep(behavior.endDelayMs);
    }
    yield { type: 'result', subtype: 'success', session_id: sessionId, result: 'fake ok' };
  };
}

function fakeResolveDeckFromBehavior(
  behavior: RunFakeBehavior,
): (ref: string) => Promise<{ id: string; name: string } | null> {
  return async (ref: string) => ({
    id: behavior.deckId ?? 'deck-fake',
    name: behavior.deckName ?? ref,
  });
}

function defaultResolveDeck(ref: string): Promise<{ id: string; name: string } | null> {
  return createCollectionAdmin().resolveDeck(ref);
}

export type RunPrereqDeps = Pick<RunDeps, 'resolveDeck' | 'resolveLaunchPlan' | 'claudeProbe'>;

function selectResolveDeck(
  deps: RunPrereqDeps,
): (ref: string) => Promise<{ id: string; name: string } | null> {
  if (deps.resolveDeck) {
    return deps.resolveDeck;
  }
  const fake = loadRunFakeBehavior();
  return fake ? fakeResolveDeckFromBehavior(fake) : defaultResolveDeck;
}

function selectClaudeProbe(deps: RunPrereqDeps): ClaudeClientProbe {
  if (deps.claudeProbe) {
    return deps.claudeProbe;
  }
  // The fake runner brings its own working client, like it brings its own
  // deck and model stream; the real probe only guards the real transport.
  if (loadRunFakeBehavior()) {
    return async () => ({ ok: true });
  }
  return defaultClaudeClientProbe;
}

/**
 * `query()` for the Claude adapter: explicit deps win, then the NOT-401
 * detach-integration fake (the detached child is a real process, so the
 * AGENT_DECK_RUN_FAKE behavior file is its only seam), then undefined so the
 * adapter lazily requires the real Claude Agent SDK.
 */
function selectClaudeQuery(deps: RunDeps): RunQueryFn | undefined {
  if (deps.query) {
    return deps.query;
  }
  if (deps.claude?.query) {
    return deps.claude.query;
  }
  const fake = loadRunFakeBehavior();
  return fake ? fakeQueryFromBehavior(fake) : undefined;
}

function resolveAdapter(client: RunClient, deps: RunDeps): ClientAdapter {
  if (client === 'codex') {
    return createCodexAdapter(deps.codex ?? {});
  }
  if (client === 'cursor') {
    return createCursorAdapter(deps.cursor ?? {});
  }
  const query = selectClaudeQuery(deps);
  return createClaudeAdapter({
    ...deps.claude,
    ...(query ? { query } : {}),
  });
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `run-${stamp}-${randomBytes(3).toString('hex')}`;
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

function writeMeta(metaPath: string, meta: RunMeta): void {
  writeRunMeta(metaPath, meta);
}

/**
 * Session receipt check: the agent harness prints the bound deck as one
 * `get_session_context` receipt line rendering `display_summary`
 * (e.g. `◆ dev · 2 MCP · 0 keys · 1 playbooks`). Returns the mismatching deck
 * token when the log positively shows a deck other than the requested one;
 * a missing receipt is not a mismatch (the pre-start assignment gate is the
 * fail-closed check; this is a second net for a mis-bound session).
 */
export function findReceiptDeckMismatch(
  texts: readonly string[],
  deck: { id: string; name: string },
): string | null {
  for (const text of texts) {
    const pattern = /◆\s*([^·\r\n]+?)\s*·/g;
    for (const match of text.matchAll(pattern)) {
      const token = match[1].trim();
      if (token && token !== deck.name && token !== deck.id) {
        return token;
      }
    }
  }
  return null;
}

/**
 * Everything a run must prove before it may start streaming: a readable brief,
 * an existing cwd, a known deck, and a folder assignment already bound to that
 * deck. Shared by the foreground run and the `--detach` starter so both fail
 * closed on the same inputs with the same messages.
 */
export async function validateRunPrereqs(
  options: RunOptions,
  deps: RunPrereqDeps = {},
): Promise<
  { promptText: string; deck: { id: string; name: string } } | { error: string }
> {
  const resolveDeck = selectResolveDeck(deps);
  const resolveLaunchPlan = deps.resolveLaunchPlan ?? resolveMcpLaunchPlan;

  let promptText: string;
  if (options.promptFile !== undefined) {
    try {
      promptText = fs.readFileSync(options.promptFile, 'utf8');
    } catch {
      return { error: `Cannot read prompt file: ${options.promptFile}` };
    }
  } else {
    promptText = options.prompt ?? '';
  }
  if (!promptText.trim()) {
    return { error: 'Prompt is empty: pass a non-empty --prompt or --prompt-file' };
  }

  let cwdStat: fs.Stats;
  try {
    cwdStat = fs.statSync(options.cwd);
  } catch {
    return { error: `--cwd does not exist: ${options.cwd}` };
  }
  if (!cwdStat.isDirectory()) {
    return { error: `--cwd is not a directory: ${options.cwd}` };
  }

  const deck = await resolveDeck(options.deckRef);
  if (!deck) {
    return { error: `Deck not found: ${options.deckRef}` };
  }

  // Fail closed before any model call: the session's MCP launch must already
  // resolve to the requested deck. Never rewrite the folder assignment here.
  const plan = await resolveLaunchPlan(options.cwd);
  if (plan.deckId !== deck.id) {
    if (!plan.deckId) {
      return {
        error:
          `No deck assigned in ${options.cwd}: run \`agent-deck use ${options.deckRef}\` there first, then retry. Refusing to start an unbound session.`,
      };
    }
    return {
      error:
        `Folder ${options.cwd} is bound to "${plan.deckName ?? plan.deckId}" (${plan.deckId}), not "${options.deckRef}". ` +
        `Run \`agent-deck use ${options.deckRef}\` in that folder to rebind it, then retry. Refusing to start a mis-bound session.`,
    };
  }

  // Last and slowest (it shells out to `claude auth status`): for claude runs,
  // the Claude Code client must be installed and signed in before any model
  // call (NOT-405). Other clients (codex) skip this probe; their adapters own
  // their preflight. Shared by the foreground run and the `--detach` starter,
  // so both fail closed with the same one-line remedy instead of an SDK
  // stack trace.
  if (options.client === 'claude') {
    const client = await selectClaudeProbe(deps)();
    if (!client.ok) {
      return {
        error:
          client.reason === 'not-installed'
            ? RUN_CLAUDE_NOT_INSTALLED_ERROR
            : RUN_CLAUDE_NOT_SIGNED_IN_ERROR,
      };
    }
  }

  return { promptText, deck };
}

export function printRunHelp(): void {
  console.log(`Usage:
  agent-deck run <deck> --client claude|codex|cursor --cwd <dir> (--prompt <text>|--prompt-file <path>) [--tools readonly|edit] [--log <path>] [--resume <sessionId>] [--detach]
  agent-deck run status <runId> [--json]
  agent-deck run log <runId> [--tail <n>] [--follow] [--json]
  agent-deck run list [--json] [--limit <n>]

Starts a local agent session bound to <deck> and streams a JSONL log.
The folder's assignment must already name <deck> (agent-deck use <deck>);
run never rewrites .agent-deck/use.json and fails closed on a mismatch.
Claude runs require the Claude Code CLI on this machine, signed in
('claude auth login'); otherwise run fails before any model call.
A set ANTHROPIC_API_KEY skips the sign-in check (the SDK accepts the
key instead); API-key setup is otherwise out of scope for this path.

  --client claude|codex|cursor  Required. muse adapter is not available yet.
                         codex maps --tools to -s read-only|workspace-write.
                         cursor maps --tools edit to --force (readonly passes
                         no write flag); all log lines land when the run ends.
  --cwd <dir>            Required. Session working directory.
  --prompt <text>        Brief text (exactly one of --prompt/--prompt-file).
  --prompt-file <path>   Brief read from a file.
  --tools readonly|edit  Tool profile, default readonly. edit adds Edit, Write
                         and git-scoped Bash (diff/add/commit/checkout -b).
  --log <path>           Log file. Default: ~/.agent-deck/runs/<runId>/run.jsonl
                         (meta.json sits next to the log in both cases).
  --resume <sessionId>   Continue a previous session id. The profile
                         passed on this invocation applies; nothing is inherited.
                         codex resume keeps the thread's original sandbox, so
                         --tools edit cannot be resumed and fails closed.
  --detach             Start in the background in a new session, so the run
                         survives this shell disconnecting. Prints runId, pid,
                         and the log path, then exits. Every other flag is
                         passed to the run unchanged. Stop it with kill <pid>.

Poll a run without parsing files by hand:

  status <runId>         State (running|ended|error|died), sessionId, log path.
  log <runId>            One readable line per event; --json prints raw JSONL.
  list                   Recent runs, newest first (default limit 20).`);
}

export async function runRun(options: RunOptions, deps: RunDeps = {}): Promise<number> {
  const homeDir = deps.homeDir ?? agentDeckHome();

  const prereq = await validateRunPrereqs(options, deps);
  if ('error' in prereq) {
    console.error(prereq.error);
    return 1;
  }
  const { promptText, deck } = prereq;

  const adapter = resolveAdapter(options.client, deps);
  const preflight = await adapter.preflight();
  if (!preflight.ok) {
    console.error(preflight.remedy);
    return 1;
  }
  const startPlan = adapter.planStart({
    cwd: options.cwd,
    prompt: promptText,
    tools: options.tools,
    ...(options.resume ? { resumeId: options.resume } : {}),
  });
  if (!startPlan.ok) {
    console.error(startPlan.remedy);
    return 1;
  }

  const runId = options.runIdOverride ?? newRunId();
  const logPath = options.log ?? path.join(homeDir, 'runs', runId, 'run.jsonl');
  const metaPath = path.join(path.dirname(logPath), 'meta.json');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const meta: RunMeta = {
    runId,
    deck: deck.id,
    client: options.client,
    tools: options.tools,
    cwd: options.cwd,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    state: 'running',
    ...(startPlan.trustOverride ? { trustOverride: true as const } : {}),
  };
  writeMeta(metaPath, meta);

  const appendLine = (line: RunLogLine): void => {
    fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`, 'utf8');
  };

  let sessionId: string | null = options.resume ?? null;
  let metaSessionWritten = false;
  const captureSessionId = (value: unknown): void => {
    if (typeof value === 'string' && value) {
      sessionId = value;
      if (!metaSessionWritten) {
        metaSessionWritten = true;
        meta.sessionId = value;
        writeMeta(metaPath, meta);
      } else {
        meta.sessionId = value;
      }
    }
  };

  let lastResultSubtype: string | undefined;
  const seenTexts: string[] = [];
  try {
    const stream = adapter.start({
      cwd: options.cwd,
      prompt: promptText,
      tools: options.tools,
      ...(options.resume ? { resumeId: options.resume } : {}),
    });
    for await (const event of stream) {
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
    appendLine({
      t: 'error',
      ts: new Date().toISOString(),
      message: String(error instanceof Error ? error.message : error).slice(0, 500),
      sessionId,
    });
    meta.state = 'error';
    if (sessionId) {
      meta.sessionId = sessionId;
    }
    writeMeta(metaPath, meta);
    console.log(`run ${runId} error: log ${logPath} sessionId ${sessionId ?? 'unknown'}`);
    return 1;
  }

  let success = lastResultSubtype === 'success';
  if (success) {
    const mismatch = findReceiptDeckMismatch(seenTexts, deck);
    if (mismatch) {
      success = false;
      console.error(
        `Session receipt names deck "${mismatch}", not "${deck.name}": marking run error. ` +
          `Rebind the folder with \`agent-deck use ${options.deckRef}\` and retry.`,
      );
    }
  }
  meta.state = success ? 'ended' : 'error';
  if (sessionId) {
    meta.sessionId = sessionId;
  }
  writeMeta(metaPath, meta);
  console.log(`run ${runId} ${meta.state}: log ${logPath} sessionId ${sessionId ?? 'unknown'}`);
  return success ? 0 : 1;
}

export async function runRunCommand(
  args: string[],
  deps: RunDeps & { followPollMs?: number } = {},
): Promise<number> {
  // Poll subcommands (NOT-402) share the `run` prefix with launch (NOT-400).
  const [head, ...tail] = args;
  if (head === 'status' || head === 'log' || head === 'list') {
    const inspect = await import('./run-status');
    if (head === 'status') {
      return inspect.runRunStatusCommand(tail, { homeDir: deps.homeDir });
    }
    if (head === 'log') {
      return inspect.runRunLogCommand(tail, {
        homeDir: deps.homeDir,
        ...(deps.followPollMs !== undefined ? { followPollMs: deps.followPollMs } : {}),
      });
    }
    return inspect.runRunListCommand(tail, { homeDir: deps.homeDir });
  }
  const parsed = parseRunArgs(args);
  if ('error' in parsed) {
    if (parsed.error === 'help') {
      printRunHelp();
      return 0;
    }
    console.error(parsed.error);
    return 1;
  }
  try {
    if (parsed.detach) {
      const { startDetachedRun } = await import('./run-detach');
      return await startDetachedRun(args, parsed, deps);
    }
    return await runRun(parsed, deps);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}
