import { z } from 'zod';
import {
  AGENT_RUN_EVENTS_MAX_LIMIT,
  AGENT_RUN_WORKSPACE_REQUIRED_MESSAGE,
  StartSessionAgentRunRequestSchema,
  type StartSessionAgentRunRequest,
} from '@agent-deck/shared';

import { BackendApiError } from '../lib/backend-api-error';
import { mcpContractError } from './policy';
import type { McpToolHost } from './register';

/**
 * NOT-539: host-local agent runs from a bound MCP session.
 *
 * The run executes on the Agent Deck host through the backend's one Agent
 * Run service. The deck is the runtime session's live deck (a human-approved
 * session-only switch included) and the cwd is the workspace the launcher
 * bound the session to — so `start_run` takes neither, and an extra `deckId`
 * or `cwd` is rejected before launch. `get_run` and `cancel_run` reach only
 * runs captured on this session's current deck and workspace.
 *
 * The backend is the authority: it reads the workspace frozen on the runtime
 * session row at launch and ignores anything the caller sends. The local
 * check below only fails fast with the same `WORKSPACE_REQUIRED` code.
 */

const GetRunInputSchema = z
  .object({
    runId: z.string().min(1).max(200),
    /** `nextCursor` from a previous `get_run`; omitted reads from the first event. */
    after: z.string().regex(/^\d+$/).optional(),
    limit: z.number().int().min(1).max(AGENT_RUN_EVENTS_MAX_LIMIT).optional(),
  })
  .strict();

const CancelRunInputSchema = z.object({ runId: z.string().min(1).max(200) }).strict();

export function registerRunTools(host: McpToolHost): void {
  const { registerTool: r } = host;

  const executionWorkspace = (): string | undefined =>
    host.sessionBinding.getExecutionWorkspace?.(host.getSessionId());

  const workspaceRequired = () => mcpContractError('WORKSPACE_REQUIRED', AGENT_RUN_WORKSPACE_REQUIRED_MESSAGE);

  const runError = (error: unknown) =>
    error instanceof BackendApiError && error.errorCode
      ? mcpContractError(error.errorCode, error.message)
      : host.toolError(error);

  const runPath = (runId: string) => `/api/trusted-session/agent-runs/${encodeURIComponent(runId)}`;

  r('start_run', {
    title: 'Start Agent Run',
    description:
      'Start (or resume with resumeSessionId) one coding-agent run on the Agent Deck host, in the workspace this session was launched for and on this session\'s current deck. Takes no deck or cwd. tools defaults to "readonly"; prepareFinalization needs tools "edit"; playbookVersion pins one playbook version for the run. Returns { runId, state } — follow with get_run.',
    inputSchema: StartSessionAgentRunRequestSchema,
  }, async (input: StartSessionAgentRunRequest) => {
    if (!executionWorkspace()) {
      return workspaceRequired();
    }
    try {
      const result = await host.callBackendAPI('/api/trusted-session/agent-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return host.toolResult(result);
    } catch (error) {
      return runError(error);
    }
  });

  r('get_run', {
    title: 'Get Agent Run',
    description:
      'Status of one run started from this session\'s deck and workspace, plus the next page of ordered events after the optional cursor. Pass the returned nextCursor as after to continue; the run is finished once state is ended, error, died, or canceled.',
    inputSchema: GetRunInputSchema,
  }, async ({ runId, after, limit }: z.infer<typeof GetRunInputSchema>) => {
    if (!executionWorkspace()) {
      return workspaceRequired();
    }
    try {
      const params = new URLSearchParams();
      if (after !== undefined) {
        params.set('after', after);
      }
      if (limit !== undefined) {
        params.set('limit', String(limit));
      }
      const query = params.toString();
      const result = await host.callBackendAPI(`${runPath(runId)}${query ? `?${query}` : ''}`);
      return host.toolResult(result);
    } catch (error) {
      return runError(error);
    }
  });

  r('cancel_run', {
    title: 'Cancel Agent Run',
    description:
      'Cancel one live run started from this session\'s deck and workspace. Idempotent: a repeated or already-finished cancel returns the current status unchanged.',
    inputSchema: CancelRunInputSchema,
  }, async ({ runId }: z.infer<typeof CancelRunInputSchema>) => {
    if (!executionWorkspace()) {
      return workspaceRequired();
    }
    try {
      const result = await host.callBackendAPI(`${runPath(runId)}/cancel`, {
        method: 'POST',
      });
      return host.toolResult(result);
    } catch (error) {
      return runError(error);
    }
  });
}
