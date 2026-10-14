/**
 * Claude adapter for `agent-deck run` (NOT-404).
 *
 * Moved verbatim out of the CLI run.ts (NOT-400): same SDK `query()` params, same
 * message mapping, same missing-SDK remedy. No behavior change.
 */
import {
  allowedToolsForProfile,
  RUN_PERMISSION_MODE,
  RUN_SETTING_SOURCES,
  type AdapterStartArgs,
  type ClientAdapter,
  type NormalizedEvent,
} from './adapter';

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

    planStart() {
      return { ok: true, trustOverride: false };
    },

    async *start(args: AdapterStartArgs): AsyncGenerator<NormalizedEvent> {
      const query = getQuery();
      const stream = query({
        prompt: args.prompt,
        options: {
          cwd: args.cwd,
          ...(args.resumeId ? { resume: args.resumeId } : {}),
          settingSources: [...RUN_SETTING_SOURCES],
          permissionMode: RUN_PERMISSION_MODE,
          allowedTools: [...allowedToolsForProfile(args.tools)],
        },
      });
      for await (const message of stream) {
        const sessionId =
          typeof message.session_id === 'string' && message.session_id
            ? message.session_id
            : undefined;
        const withSession = sessionId ? { sessionId } : {};
        if (message.type === 'assistant') {
          for (const block of message.message?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string') {
              yield { kind: 'text', text: block.text, ...withSession };
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
              yield { kind: 'tool', name: block.name, ...withSession };
            }
          }
        } else if (message.type === 'result') {
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
