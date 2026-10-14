/**
 * `agent-deck run` — start a local agent session bound to a deck (NOT-400, NOT-404).
 *
 * Productizes the throwaway botmancers runner: one command takes a deck, a
 * working directory, and a brief, streams the session to a JSONL log, and
 * records a small meta.json that later tickets (detach, status) can read.
 * Resume continues the same client session id under a new run log.
 *
 * The execution lifecycle — deck binding gate, client adapters and preflight,
 * tool profiles, the JSONL log, and meta.json — lives in the host-local run
 * service (`@agent-deck/backend/agent-run`, NOT-479) that the backend shares.
 * This file owns arg parsing, the brief file, terminal output, and the CLI
 * host seams (deck lookup, folder assignment, SDK location, test fake).
 *
 * `--detach` (NOT-401) re-executes this same command as a background child;
 * status/log/list (NOT-402) poll the run record the child writes.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  createAgentRunService,
  defaultClaudeClientProbe,
  missingRunClientMessage,
  runClientMessage,
  type AgentRunRequest,
  type AgentRunService,
  type ClaudeAdapterDeps,
  type ClaudeClientProbe,
  type ClientAdapter,
  type CodexAdapterDeps,
  type CursorAdapterDeps,
  type MuseAdapterDeps,
  type RunClient,
  type RunDeck,
  type RunResumeOrigin,
  type RunQueryFn,
  type RunQueryMessage,
  type RunQueryOptions,
  type RunToolsProfile,
} from '@agent-deck/backend/agent-run';

import { createCollectionAdmin } from './backend-runtime';
import { agentDeckHome } from './managed/paths';
import { resolveMcpLaunchPlan } from './mcp-launcher';
import { getCliPackageRoot } from './paths';

// The execution lifecycle (adapters, preflight, run records, status reads)
// lives in the shared host-local run service; re-exported so existing
// `from './run'` imports keep working.
export {
  allowedToolsForProfile,
  CLAUDE_AUTH_LOGIN_COMMAND,
  claudeAuthStatusShowsLogin,
  defaultClaudeClientProbe,
  findExecutableOnPath,
  findReceiptDeckMismatch,
  newRunId,
  RUN_CLAUDE_NOT_INSTALLED_ERROR,
  RUN_CLAUDE_NOT_SIGNED_IN_ERROR,
  RUN_EDIT_TOOLS,
  RUN_PERMISSION_MODE,
  RUN_READONLY_TOOLS,
  RUN_SETTING_SOURCES,
  RUN_TOOL_PROFILES,
  writeRunMeta,
  type ClaudeAdapterDeps,
  type ClaudeClientProbe,
  type ClaudeClientStatus,
  type CodexAdapterDeps,
  type CursorAdapterDeps,
  type MuseAdapterDeps,
  type RunClient,
  type RunLogLine,
  type RunMeta,
  type RunQueryFn,
  type RunQueryMessage,
  type RunQueryOptions,
  type RunToolsProfile,
} from '@agent-deck/backend/agent-run';

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
  if (client !== 'claude' && client !== 'codex' && client !== 'cursor' && client !== 'muse') {
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

export type RunDeps = {
  /** NOT-400 seam, kept for compatibility: injected `query()` for the Claude adapter. */
  query?: RunQueryFn;
  /** Injected in tests; production lazily requires the Claude Agent SDK. */
  claude?: ClaudeAdapterDeps;
  /** Injected in tests; production spawns the real `codex` binary. */
  codex?: CodexAdapterDeps;
  /** Injected in tests; production spawns the real `cursor-agent` binary. */
  cursor?: CursorAdapterDeps;
  /** Injected in tests; production spawns the real `muse` binary. */
  muse?: MuseAdapterDeps;
  resolveDeck?: (ref: string) => Promise<{ id: string; name: string } | null>;
  resolveLaunchPlan?: typeof resolveMcpLaunchPlan;
  homeDir?: string;
  /** Injected in tests; production probes the local Claude Code CLI (NOT-405). */
  claudeProbe?: ClaudeClientProbe;
  /** Injected in tests: replaces every client adapter with a fixture. */
  createAdapter?: (client: RunClient) => ClientAdapter;
};

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

/**
 * The shared run service wired to the CLI host: deck lookup through the local
 * collection, the folder assignment as the MCP launcher reads it, the Claude
 * SDK resolved from this package, and the detach-integration fake.
 */
export function createCliRunService(deps: RunDeps = {}): AgentRunService {
  const resolveLaunchPlan = deps.resolveLaunchPlan ?? resolveMcpLaunchPlan;
  const query = selectClaudeQuery(deps);
  return createAgentRunService({
    homeDir: deps.homeDir ?? agentDeckHome(),
    resolveDeck: selectResolveDeck(deps),
    async resolveDeckBinding(cwd) {
      const plan = await resolveLaunchPlan(cwd);
      return {
        ...(plan.deckId ? { deckId: plan.deckId } : {}),
        ...(plan.deckName ? { deckName: plan.deckName } : {}),
      };
    },
    // Selected per probe so the fake is only consulted for claude runs.
    claudeProbe: () => selectClaudeProbe(deps)(),
    adapters: {
      claude: {
        sdkSearchPaths: [getCliPackageRoot()],
        ...deps.claude,
        ...(query ? { query } : {}),
      },
      codex: deps.codex,
      cursor: deps.cursor,
      muse: deps.muse,
    },
    ...(deps.createAdapter ? { createAdapter: deps.createAdapter } : {}),
  });
}

function runRequest(options: RunOptions, prompt: string): AgentRunRequest {
  return {
    deckRef: options.deckRef,
    client: options.client,
    cwd: options.cwd,
    prompt,
    tools: options.tools,
    ...(options.resume ? { resumeId: options.resume } : {}),
  };
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
): Promise<{ promptText: string; deck: RunDeck; resumedFrom?: RunResumeOrigin } | { error: string }> {
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
  const validated = await createCliRunService(deps).validate(runRequest(options, promptText));
  if (!validated.ok) {
    return { error: validated.error };
  }
  return {
    promptText,
    deck: validated.deck,
    ...(validated.resumedFrom ? { resumedFrom: validated.resumedFrom } : {}),
  };
}

export function printRunHelp(): void {
  console.log(`Usage:
  agent-deck run <deck> --client claude|codex|cursor|muse --cwd <dir> (--prompt <text>|--prompt-file <path>) [--tools readonly|edit] [--log <path>] [--resume <sessionId>] [--detach]
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

  --client claude|codex|cursor|muse
                         Required.
                         codex maps --tools to -s read-only|workspace-write;
                         cursor maps --tools edit to --force (readonly passes
                         no write flag); all log lines land when the run ends;
                         muse maps readonly to --disable-write --disable-shell
                         (edit uses the default bounded permissions).
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
                         it continues only a session an agent-deck run started
                         on this deck, client, and canonical cwd with the same
                         --tools; anything else fails closed before launch.
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
  const prereq = await validateRunPrereqs(options, deps);
  if ('error' in prereq) {
    console.error(prereq.error);
    return 1;
  }
  const { promptText, deck, resumedFrom } = prereq;

  const outcome = await createCliRunService(deps).execute(
    { request: runRequest(options, promptText), deck, ...(resumedFrom ? { resumedFrom } : {}) },
    {
      ...(options.runIdOverride ? { runId: options.runIdOverride } : {}),
      ...(options.log ? { logPath: options.log } : {}),
    },
  );
  if (outcome.kind === 'rejected') {
    console.error(outcome.message);
    return 1;
  }
  if (outcome.receiptMismatch) {
    console.error(
      `Session receipt names deck "${outcome.receiptMismatch}", not "${deck.name}": marking run error. ` +
        `Rebind the folder with \`agent-deck use ${options.deckRef}\` and retry.`,
    );
  }
  console.log(
    `run ${outcome.runId} ${outcome.state}: log ${outcome.logPath} sessionId ${outcome.sessionId ?? 'unknown'}`,
  );
  return outcome.state === 'ended' ? 0 : 1;
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
