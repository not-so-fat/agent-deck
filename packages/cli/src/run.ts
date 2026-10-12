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
 */
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
import { createClaudeAdapter, type ClaudeAdapterDeps, type RunQueryFn } from './run-claude';
import { createCodexAdapter, type CodexAdapterDeps } from './run-codex';

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

export type RunOptions = {
  deckRef: string;
  client: RunClient;
  cwd: string;
  prompt?: string;
  promptFile?: string;
  tools: RunToolsProfile;
  log?: string;
  resume?: string;
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
  if (client !== 'claude' && client !== 'codex') {
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
  resolveDeck?: (ref: string) => Promise<{ id: string; name: string } | null>;
  resolveLaunchPlan?: typeof resolveMcpLaunchPlan;
  homeDir?: string;
};

function defaultResolveDeck(ref: string): Promise<{ id: string; name: string } | null> {
  return createCollectionAdmin().resolveDeck(ref);
}

function resolveAdapter(client: RunClient, deps: RunDeps): ClientAdapter {
  if (client === 'codex') {
    return createCodexAdapter(deps.codex ?? {});
  }
  return createClaudeAdapter({
    ...deps.claude,
    ...(deps.query ? { query: deps.query } : {}),
  });
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `run-${stamp}-${randomBytes(3).toString('hex')}`;
}

function writeMeta(metaPath: string, meta: RunMeta): void {
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
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

export function printRunHelp(): void {
  console.log(`Usage:
  agent-deck run <deck> --client claude|codex --cwd <dir> (--prompt <text>|--prompt-file <path>) [--tools readonly|edit] [--log <path>] [--resume <sessionId>]

Starts a local agent session bound to <deck> and streams a JSONL log.
The folder's assignment must already name <deck> (agent-deck use <deck>);
run never rewrites .agent-deck/use.json and fails closed on a mismatch.

  --client claude|codex  Required. cursor and muse adapters are not available yet.
                         codex maps --tools to -s read-only|workspace-write.
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
                         --tools edit cannot be resumed and fails closed.`);
}

export async function runRun(options: RunOptions, deps: RunDeps = {}): Promise<number> {
  const resolveDeck = deps.resolveDeck ?? defaultResolveDeck;
  const resolveLaunchPlan = deps.resolveLaunchPlan ?? resolveMcpLaunchPlan;
  const homeDir = deps.homeDir ?? agentDeckHome();

  let promptText: string;
  if (options.promptFile !== undefined) {
    try {
      promptText = fs.readFileSync(options.promptFile, 'utf8');
    } catch {
      console.error(`Cannot read prompt file: ${options.promptFile}`);
      return 1;
    }
  } else {
    promptText = options.prompt ?? '';
  }
  if (!promptText.trim()) {
    console.error('Prompt is empty: pass a non-empty --prompt or --prompt-file');
    return 1;
  }

  let cwdStat: fs.Stats;
  try {
    cwdStat = fs.statSync(options.cwd);
  } catch {
    console.error(`--cwd does not exist: ${options.cwd}`);
    return 1;
  }
  if (!cwdStat.isDirectory()) {
    console.error(`--cwd is not a directory: ${options.cwd}`);
    return 1;
  }

  const deck = await resolveDeck(options.deckRef);
  if (!deck) {
    console.error(`Deck not found: ${options.deckRef}`);
    return 1;
  }

  // Fail closed before any model call: the session's MCP launch must already
  // resolve to the requested deck. Never rewrite the folder assignment here.
  const plan = await resolveLaunchPlan(options.cwd);
  if (plan.deckId !== deck.id) {
    if (!plan.deckId) {
      console.error(
        `No deck assigned in ${options.cwd}: run \`agent-deck use ${options.deckRef}\` there first, then retry. Refusing to start an unbound session.`,
      );
    } else {
      console.error(
        `Folder ${options.cwd} is bound to "${plan.deckName ?? plan.deckId}" (${plan.deckId}), not "${options.deckRef}". ` +
          `Run \`agent-deck use ${options.deckRef}\` in that folder to rebind it, then retry. Refusing to start a mis-bound session.`,
      );
    }
    return 1;
  }

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

  const runId = newRunId();
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

export async function runRunCommand(args: string[], deps: RunDeps = {}): Promise<number> {
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
    return await runRun(parsed, deps);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}
