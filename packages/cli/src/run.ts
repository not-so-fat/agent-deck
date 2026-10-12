/**
 * `agent-deck run` — start a local Claude Code session bound to a deck (NOT-400).
 *
 * Productizes the throwaway botmancers runner: one command takes a deck, a
 * working directory, and a brief, streams the session to a JSONL log, and
 * records a small meta.json that later tickets (detach, status) can read.
 * Resume continues the same Claude session id under a new run log.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createCollectionAdmin } from './backend-runtime';
import { agentDeckHome } from './managed/paths';
import { resolveMcpLaunchPlan } from './mcp-launcher';
import { getCliPackageRoot } from './paths';

/** Read-only profile: exactly the botmancers prototype allowlist. */
export const RUN_READONLY_TOOLS: readonly string[] = [
  'mcp__agent-deck__*',
  'Read',
  'Glob',
  'Grep',
  'Bash(git log:*)',
  'Bash(git status:*)',
  'Bash(ls:*)',
];

/**
 * Edit profile: readonly plus file writes and git-scoped Bash. No `git push`,
 * no unscoped `Bash`, no network tools. One-line reason per git entry:
 * - `git diff` reviews local changes before staging or committing;
 * - `git add` stages the files the session created or edited;
 * - `git commit` records the work as a commit for handoff;
 * - `git checkout -b` starts delegated work on a fresh branch.
 */
export const RUN_EDIT_TOOLS: readonly string[] = [
  ...RUN_READONLY_TOOLS,
  'Edit',
  'Write',
  'Bash(git diff:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git checkout -b:*)',
];

/** Both profiles run with `acceptEdits`; `bypassPermissions` is never used. */
export const RUN_PERMISSION_MODE = 'acceptEdits';

/** Setting sources copied from the prototype. */
export const RUN_SETTING_SOURCES: readonly string[] = ['project', 'user'];

export const RUN_TOOL_PROFILES = ['readonly', 'edit'] as const;
export type RunToolsProfile = (typeof RUN_TOOL_PROFILES)[number];

export function allowedToolsForProfile(profile: RunToolsProfile): readonly string[] {
  return profile === 'edit' ? RUN_EDIT_TOOLS : RUN_READONLY_TOOLS;
}

export type RunOptions = {
  deckRef: string;
  client: 'claude';
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
    return { error: '--client is required: pass --client claude (codex/cursor adapters are not available yet)' };
  }
  if (client !== 'claude') {
    if (client === 'codex' || client === 'cursor') {
      return { error: `Client adapter "${client}" is not available yet (only --client claude is supported)` };
    }
    return { error: `--client must be "claude" (got "${client}")` };
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
    client: 'claude',
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

/** Minimal structural view of the SDK `query()` surface (the SDK loads lazily). */
export type RunQueryMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: unknown;
  message?: {
    content?: Array<{ type?: string; text?: string; name?: string }>;
  };
};

export type RunQueryOptions = {
  cwd: string;
  resume?: string;
  settingSources: readonly string[];
  permissionMode: string;
  allowedTools: readonly string[];
};

export type RunQueryFn = (params: {
  prompt: string;
  options: RunQueryOptions;
}) => AsyncIterable<RunQueryMessage>;

export type RunLogLine =
  | { t: 'text'; ts: string; text: string }
  | { t: 'tool'; ts: string; name: string }
  | { t: 'result'; ts: string; sessionId: string | null; subtype: string; result: unknown }
  | { t: 'end'; ts: string; sessionId: string | null }
  | { t: 'error'; ts: string; message: string; sessionId: string | null };

export type RunMeta = {
  runId: string;
  deck: string;
  client: 'claude';
  tools: RunToolsProfile;
  cwd: string;
  pid: number;
  startedAt: string;
  state: 'running' | 'ended' | 'error';
  sessionId?: string;
};

export type RunDeps = {
  /** Injected in tests; production lazily requires the Claude Agent SDK. */
  query?: RunQueryFn;
  resolveDeck?: (ref: string) => Promise<{ id: string; name: string } | null>;
  resolveLaunchPlan?: typeof resolveMcpLaunchPlan;
  homeDir?: string;
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

function loadSdkQuery(): RunQueryFn {
  try {
    const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk', {
      paths: [getCliPackageRoot()],
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require(sdkPath) as { query?: unknown };
    if (typeof sdk.query !== 'function') {
      throw new Error('unexpected SDK shape');
    }
    return sdk.query as RunQueryFn;
  } catch {
    throw new Error(
      'The Claude Agent SDK is not installed. Reinstall the CLI (`agent-deck upgrade` or `npm install -g @agent-deck/cli@latest`) so @anthropic-ai/claude-agent-sdk is present, then retry.',
    );
  }
}

function defaultResolveDeck(ref: string): Promise<{ id: string; name: string } | null> {
  return createCollectionAdmin().resolveDeck(ref);
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `run-${stamp}-${randomBytes(3).toString('hex')}`;
}

function writeMeta(metaPath: string, meta: RunMeta): void {
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export type RunPrereqDeps = Pick<RunDeps, 'resolveDeck' | 'resolveLaunchPlan'>;

function selectResolveDeck(
  deps: RunPrereqDeps,
): (ref: string) => Promise<{ id: string; name: string } | null> {
  if (deps.resolveDeck) {
    return deps.resolveDeck;
  }
  const fake = loadRunFakeBehavior();
  return fake ? fakeResolveDeckFromBehavior(fake) : defaultResolveDeck;
}

function selectRunQuery(deps: RunDeps): RunQueryFn {
  if (deps.query) {
    return deps.query;
  }
  const fake = loadRunFakeBehavior();
  return fake ? fakeQueryFromBehavior(fake) : loadSdkQuery();
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

  return { promptText, deck };
}

export function printRunHelp(): void {
  console.log(`Usage:
  agent-deck run <deck> --client claude --cwd <dir> (--prompt <text>|--prompt-file <path>) [--tools readonly|edit] [--log <path>] [--resume <sessionId>] [--detach]
  agent-deck run status <runId> [--json]
  agent-deck run log <runId> [--tail <n>] [--follow] [--json]
  agent-deck run list [--json] [--limit <n>]

Starts a local Claude Code session bound to <deck> and streams a JSONL log.
The folder's assignment must already name <deck> (agent-deck use <deck>);
run never rewrites .agent-deck/use.json and fails closed on a mismatch.

  --client claude        Required. codex/cursor adapters are not available yet.
  --cwd <dir>            Required. Session working directory.
  --prompt <text>        Brief text (exactly one of --prompt/--prompt-file).
  --prompt-file <path>   Brief read from a file.
  --tools readonly|edit  Tool profile, default readonly. edit adds Edit, Write
                         and git-scoped Bash (diff/add/commit/checkout -b).
  --log <path>           Log file. Default: ~/.agent-deck/runs/<runId>/run.jsonl
                         (meta.json sits next to the log in both cases).
  --resume <sessionId>   Continue a previous Claude session id. The profile
                         passed on this invocation applies; nothing is inherited.
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

  const query = selectRunQuery(deps);

  const runId = options.runIdOverride ?? newRunId();
  const logPath = options.log ?? path.join(homeDir, 'runs', runId, 'run.jsonl');
  const metaPath = path.join(path.dirname(logPath), 'meta.json');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  const meta: RunMeta = {
    runId,
    deck: deck.id,
    client: 'claude',
    tools: options.tools,
    cwd: options.cwd,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    state: 'running',
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
  try {
    const stream = query({
      prompt: promptText,
      options: {
        cwd: options.cwd,
        ...(options.resume ? { resume: options.resume } : {}),
        settingSources: [...RUN_SETTING_SOURCES],
        permissionMode: RUN_PERMISSION_MODE,
        allowedTools: [...allowedToolsForProfile(options.tools)],
      },
    });
    for await (const message of stream) {
      captureSessionId(message.session_id);
      if (message.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string') {
            appendLine({ t: 'text', ts: new Date().toISOString(), text: block.text });
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            appendLine({ t: 'tool', ts: new Date().toISOString(), name: block.name });
          }
        }
      } else if (message.type === 'result') {
        lastResultSubtype = message.subtype ?? '';
        appendLine({
          t: 'result',
          ts: new Date().toISOString(),
          sessionId,
          subtype: message.subtype ?? '',
          result: message.result,
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

  const success = lastResultSubtype === 'success';
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
