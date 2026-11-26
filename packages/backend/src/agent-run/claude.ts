/**
 * Claude adapter for `agent-deck run` (NOT-404).
 *
 * Moved verbatim out of the CLI run.ts (NOT-400): same SDK `query()` params, same
 * message mapping, same missing-SDK remedy. No behavior change.
 *
 * Worker-profile enforcement (NOT-672, policy in `claude-policy.ts`): every
 * start and resume runs isolated (`settingSources: []`, no skills), under
 * `dontAsk` with the profile's explicit allow/ask/deny rules as flag-layer
 * settings. `allow` pre-approves exact tools only; shell (both profiles)
 * and file writes (edit) route through `ask` to the `canUseTool` host gate
 * deciding from the same policy, so no call executes without its per-call
 * verdict. Exactly one MCP server connects (the per-run inline `agent-deck`
 * entry with the worker headers, `strictMcpConfig`). Client-reported
 * denials — streaming `permission_denied` frames and the authoritative
 * `result.permission_denials` list — become `denial` normalized events the
 * run service records with the effective profile. Resume re-applies the
 * requested profile's options and additionally requires trusted
 * same-profile provenance (a resumed SDK session must never keep another
 * profile's permissions).
 */
import os from 'node:os';

import {
  defaultWorkerHomeDir,
  formatRunPlaybookPin,
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
  type RunPlaybookPin,
  type RunToolsProfile,
} from './adapter';
import {
  CLAUDE_WORKER_MCP_SERVER,
  CLAUDE_WORKER_PERMISSION_MODE,
  CLAUDE_WORKER_SETTING_SOURCES,
  CLAUDE_WORKER_SKILLS,
  claudeAllowedToolsForProfile,
  claudeDenialKindForTool,
  claudeSettingsForProfile,
  decideClaudeToolCall,
} from './claude-policy';

/** Minimal structural view of the SDK `query()` surface (the SDK loads lazily). */
export type RunQueryMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: unknown;
  /**
   * Assistant message content blocks. A `permission_denied` system message
   * instead carries a plain-text `message` (see below).
   */
  message?:
    | {
        content?: Array<{ type?: string; text?: string; name?: string }>;
      }
    | string;
  /** `system`/`permission_denied` frame fields (NOT-672 denial events). */
  tool_name?: string;
  tool_use_id?: string;
  decision_reason?: string;
  /** Authoritative per-result denial record (NOT-672 denial events). */
  permission_denials?: Array<{ tool_name?: string; tool_use_id?: string }>;
};

/**
 * Minimal structural view of the SDK `canUseTool` permission handler (the
 * real signature takes a third options argument, which the worker handler
 * ignores). Returned for every consulted tool call; the SDK executes the
 * call on `allow` (with `updatedInput` when present) and refuses it on
 * `deny`, surfacing a `permission_denied` frame the adapter maps back.
 */
export type RunCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
>;

/** Minimal structural view of the flag-layer worker settings. */
export type RunWorkerSettings = {
  permissions: {
    allow: string[];
    deny: string[];
    ask: string[];
    defaultMode: string;
    additionalDirectories: string[];
  };
};

/**
 * Inline HTTP MCP server for this session (NOT-537). Minimal view of the
 * SDK's `McpHttpServerConfig`: only what a pinned run passes.
 */
export type RunPinHttpMcpServer = {
  type: 'http';
  url: string;
  headers: Record<string, string>;
};

export type RunQueryOptions = {
  cwd: string;
  resume?: string;
  settingSources: readonly string[];
  permissionMode: string;
  allowedTools: readonly string[];
  /** Aborts the SDK session when the run is canceled (NOT-481). */
  abortController?: AbortController;
  /** Inline MCP servers for this session (NOT-537). */
  mcpServers?: Record<string, RunPinHttpMcpServer>;
  /** Ignore every configured MCP server except `mcpServers` (NOT-537). */
  strictMcpConfig?: boolean;
  /** Flag-layer worker settings: explicit allow/ask/deny, never a human (NOT-672). */
  settings?: RunWorkerSettings;
  /** Tools removed from the model context (NOT-672: always empty — denied tools stay visible so attempts are recorded). */
  disallowedTools?: readonly string[];
  /** Skills enabled for the session (NOT-672: always none on workers). */
  skills?: readonly string[] | 'all';
  /** Extra working directories file tools may touch (NOT-672: home + temp). */
  additionalDirectories?: readonly string[];
  /** Host permission handler deciding from the worker policy (NOT-672). */
  canUseTool?: RunCanUseTool;
};

/**
 * The `canUseTool` handler for one worker run (NOT-672): every consulted
 * call is decided by `decideClaudeToolCall` against the run's profile —
 * synchronously answered, so nothing ever waits on a human. A readonly
 * `git` call the classifier hardens runs with the rewritten command.
 */
export function createClaudeWorkerCanUseTool(input: {
  cwd: string;
  homeDir: string;
  tmpDir: string;
  tools: RunToolsProfile;
}): RunCanUseTool {
  return async (toolName, toolInput) => {
    const verdict = decideClaudeToolCall(
      toolName,
      toolInput,
      { profile: input.tools, cwd: input.cwd, homeDir: input.homeDir, tmpDir: input.tmpDir },
    );
    if (verdict.decision === 'allow') {
      return verdict.updatedCommand !== undefined
        ? { behavior: 'allow', updatedInput: { ...toolInput, command: verdict.updatedCommand } }
        : { behavior: 'allow' };
    }
    return { behavior: 'deny', message: verdict.reason };
  };
}

/**
 * Header names the pinned server sends. Literals (not `@agent-deck/shared` —
 * this module imports node built-ins and siblings only, NOT-479); they must
 * match `AGENT_DECK_WORKSPACE_HEADER` / `AGENT_DECK_PLAYBOOK_PIN_HEADER`.
 */
export const CLAUDE_PIN_WORKSPACE_HEADER = 'x-agent-deck-workspace';
export const CLAUDE_PIN_PLAYBOOK_PIN_HEADER = 'x-agent-deck-playbook-pin';
/** Must match `AGENT_DECK_DECK_ID_HEADER`. */
export const CLAUDE_LAUNCH_DECK_HEADER = 'x-agent-deck-deck-id';
/** Must match `AGENT_DECK_RUN_TOKEN_HEADER`. */
export const CLAUDE_RUN_TOKEN_HEADER = 'x-agent-deck-run-token';

/**
 * Inline `agent-deck` MCP server carrying the run's playbook pin (NOT-537),
 * in pure-HTTP form (NOT-566): the daemon resolves the deck from the folder
 * assignment named by the workspace header (NOT-562) and reads the pin
 * header for the playbook version — no launcher process is involved.
 */
export function buildClaudePinMcpServer(
  pin: RunPlaybookPin,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): RunPinHttpMcpServer {
  return buildClaudeRunMcpServer({ cwd, playbookPin: pin }, env);
}

/**
 * The run's inline `agent-deck` server: the workspace header, plus the
 * playbook pin, the launch deck header, and/or the worker token header when
 * the run has them. The launch deck header makes the daemon bind the run's
 * deck directly instead of re-resolving it from the folder assignment or
 * the user default; the worker token header binds the MCP session to the
 * run's effective worker profile (NOT-669).
 */
export function buildClaudeRunMcpServer(
  input: { cwd: string; playbookPin?: RunPlaybookPin; launchDeckId?: string; runToken?: string },
  env: NodeJS.ProcessEnv = process.env,
): RunPinHttpMcpServer {
  const port = env.AGENT_DECK_MCP_PORT?.trim() || '1110';
  const host = env.AGENT_DECK_HOST?.trim() || '127.0.0.1';
  return {
    type: 'http',
    url: `http://${host}:${port}/mcp`,
    headers: {
      [CLAUDE_PIN_WORKSPACE_HEADER]: input.cwd,
      ...(input.playbookPin
        ? { [CLAUDE_PIN_PLAYBOOK_PIN_HEADER]: formatRunPlaybookPin(input.playbookPin) }
        : {}),
      ...(input.launchDeckId ? { [CLAUDE_LAUNCH_DECK_HEADER]: input.launchDeckId } : {}),
      ...(input.runToken ? { [CLAUDE_RUN_TOKEN_HEADER]: input.runToken } : {}),
    },
  };
}

export type RunQueryFn = (params: {
  prompt: string;
  options: RunQueryOptions;
}) => AsyncIterable<RunQueryMessage>;

/**
 * Resolve the SDK from `searchPaths` (the CLI passes its own package root,
 * which declares the SDK dependency) or, when omitted, from this module.
 */
export function loadClaudeSdkQuery(searchPaths?: readonly string[]): RunQueryFn {
  try {
    const sdkPath = require.resolve(
      '@anthropic-ai/claude-agent-sdk',
      searchPaths ? { paths: [...searchPaths] } : undefined,
    );
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

export type ClaudeAdapterDeps = {
  /** Injected in tests; production lazily requires the Claude Agent SDK. */
  query?: RunQueryFn;
  /** Override the SDK loader (tests use this to fail preflight deterministically). */
  loadQuery?: () => RunQueryFn;
  /** Where the default loader resolves the SDK from (see {@link loadClaudeSdkQuery}). */
  sdkSearchPaths?: readonly string[];
  /** Agent user's home for the edit file-write scope; defaults to `os.homedir()`. */
  homeDir?: string;
  /** OS temp dir for the edit file-write scope; defaults to `os.tmpdir()`. */
  tmpDir?: string;
};

export function createClaudeAdapter(deps: ClaudeAdapterDeps = {}): ClientAdapter {
  let cachedQuery: RunQueryFn | undefined = deps.query;
  const loadQuery = deps.loadQuery ?? (() => loadClaudeSdkQuery(deps.sdkSearchPaths));
  const getQuery = (): RunQueryFn => {
    if (!cachedQuery) {
      cachedQuery = loadQuery();
    }
    return cachedQuery;
  };
  const homeDir = deps.homeDir ?? defaultWorkerHomeDir();
  const tmpDir = deps.tmpDir ?? os.tmpdir();

  return {
    id: 'claude',

    async preflight() {
      try {
        getQuery();
        return { ok: true };
      } catch (error) {
        return { ok: false, remedy: error instanceof Error ? error.message : String(error) };
      }
    },

    planStart(args: AdapterStartArgs) {
      // NOT-672: a resumed SDK session must never keep another profile's
      // permissions, so a resume continues only a session an Agent Deck
      // run started with the same profile (provenance resolved by the run
      // service, as for codex). The requested profile's options are still
      // passed on resume and govern wherever the SDK applies them.
      if (args.resumeId !== undefined) {
        const origin = args.resumedFrom;
        if (!origin || origin.sessionId !== args.resumeId) {
          return {
            ok: false,
            remedy:
              `Cannot resume claude session ${args.resumeId}: no trusted Agent Deck run is known to have started it. ` +
              'Resume a sessionId printed by `agent-deck run`, or start a new run.',
          };
        }
        if (origin.tools !== args.tools) {
          return {
            ok: false,
            remedy:
              `Cannot resume claude session ${args.resumeId} with --tools ${args.tools}: run ${origin.runId} started it with ` +
              `--tools ${origin.tools}. Resume with --tools ${origin.tools}, or start a new run.`,
          };
        }
      }
      return { ok: true, trustOverride: false };
    },

    profileEnforcement(args: AdapterStartArgs) {
      // NOT-672: the mapping is implemented (isolated settings, dontAsk,
      // explicit lists and rules, canUseTool, worker-only MCP) and the
      // resume gate re-checks provenance behind planStart.
      if (args.resumeId !== undefined) {
        const origin = args.resumedFrom;
        if (!origin || origin.sessionId !== args.resumeId || origin.tools !== args.tools) {
          return {
            ok: false,
            remedy:
              `Cannot resume claude session ${args.resumeId}: no trusted Agent Deck run is known to have started it with ` +
              `--tools ${args.tools}. Resume a sessionId printed by \`agent-deck run\`, or start a new run.`,
          };
        }
      }
      return { ok: true };
    },

    async *start(args: AdapterStartArgs): AsyncGenerator<NormalizedEvent> {
      const query = getQuery();
      // planStart rejects a resume without a matching resumedFrom.
      if (args.resumeId !== undefined && args.resumedFrom) {
        yield {
          kind: 'notice',
          message:
            `Resuming claude session ${args.resumeId} started by run ${args.resumedFrom.runId}: ` +
            `the requested profile (--tools ${args.tools}) is re-applied to the resumed session.`,
          sessionId: args.resumeId,
        };
      }
      let abortController: AbortController | undefined;
      if (args.control) {
        abortController = new AbortController();
        const controller = abortController;
        if (args.control.signal.aborted) {
          controller.abort();
        } else {
          args.control.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
      }
      // NOT-537: the run's own pure-HTTP `agent-deck` MCP server (NOT-566)
      // with the pin in the explicit per-server headers (inherited process
      // env never reaches an MCP server started with a restricted env) and
      // `strictMcpConfig` so exactly that one server connects — no
      // same-name merge ambiguity with the configured entry. NOT-669: the
      // same inline server carries the worker token header binding the MCP
      // session to the run's effective profile. NOT-672: the inline server
      // rides on every run, and the session is isolated (`settingSources:
      // []`, no skills), non-interactive (`dontAsk`), explicitly listed
      // (`allowedTools` plus flag-layer allow/ask/deny rules — `allow`
      // pre-approves exact tools only, shell and edit writes route through
      // `ask`), and host-gated (`canUseTool` from the same policy).
      const stream = query({
        prompt: args.prompt,
        options: {
          cwd: args.cwd,
          ...(args.resumeId ? { resume: args.resumeId } : {}),
          settingSources: [...CLAUDE_WORKER_SETTING_SOURCES],
          permissionMode: CLAUDE_WORKER_PERMISSION_MODE,
          allowedTools: [...claudeAllowedToolsForProfile(args.tools)],
          disallowedTools: [],
          skills: [...CLAUDE_WORKER_SKILLS],
          settings: claudeSettingsForProfile(args.tools, { homeDir, tmpDir }),
          additionalDirectories: [homeDir, tmpDir],
          canUseTool: createClaudeWorkerCanUseTool({
            cwd: args.cwd,
            homeDir,
            tmpDir,
            tools: args.tools,
          }),
          ...(abortController ? { abortController } : {}),
          mcpServers: {
            [CLAUDE_WORKER_MCP_SERVER]: buildClaudeRunMcpServer({
              cwd: args.cwd,
              ...(args.playbookPin ? { playbookPin: args.playbookPin } : {}),
              ...(args.launchDeckId ? { launchDeckId: args.launchDeckId } : {}),
              ...(args.runToken ? { runToken: args.runToken } : {}),
            }),
          },
          strictMcpConfig: true,
        },
      });
      // `permission_denied` frames stream live; `result.permission_denials`
      // is the authoritative record and may repeat them — one event per
      // tool_use_id, whichever arrives first.
      const seenDenials = new Set<string>();
      const denialKey = (toolUseId: string | undefined, toolName: string): string =>
        toolUseId ? `id:${toolUseId}` : `name:${toolName}`;
      for await (const message of stream) {
        const sessionId =
          typeof message.session_id === 'string' && message.session_id ? message.session_id : undefined;
        const withSession = sessionId ? { sessionId } : {};
        if (message.type === 'assistant' && typeof message.message === 'object') {
          for (const block of message.message?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string') {
              yield { kind: 'text', text: block.text, ...withSession };
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
              yield { kind: 'tool', name: block.name, ...withSession };
            }
          }
        } else if (message.type === 'system' && message.subtype === 'permission_denied') {
          const toolName = typeof message.tool_name === 'string' ? message.tool_name : 'unknown';
          const key = denialKey(
            typeof message.tool_use_id === 'string' ? message.tool_use_id : undefined,
            toolName,
          );
          if (!seenDenials.has(key)) {
            seenDenials.add(key);
            const reason =
              (typeof message.decision_reason === 'string' && message.decision_reason) ||
              (typeof message.message === 'string' && message.message) ||
              `worker profile "${args.tools}" denied ${toolName}`;
            yield {
              kind: 'denial',
              target: toolName,
              reason: reason.slice(0, 500),
              denialKind: claudeDenialKindForTool(toolName),
              ...withSession,
            };
          }
        } else if (message.type === 'result') {
          for (const denial of message.permission_denials ?? []) {
            const toolName = typeof denial.tool_name === 'string' ? denial.tool_name : 'unknown';
            const key = denialKey(
              typeof denial.tool_use_id === 'string' ? denial.tool_use_id : undefined,
              toolName,
            );
            if (!seenDenials.has(key)) {
              seenDenials.add(key);
              yield {
                kind: 'denial',
                target: toolName,
                reason: `worker profile "${args.tools}" denied ${toolName}`,
                denialKind: claudeDenialKindForTool(toolName),
                ...withSession,
              };
            }
          }
          yield {
            kind: 'result',
            subtype: message.subtype ?? '',
            result: message.result,
            ...withSession,
          };
        }
      }
    },
  };
}
