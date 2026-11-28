import {
  RunWithCredentialsRequestSchema,
  type RunWithCredentialsRequest,
} from '@agent-deck/shared';

import { mcpToolDenialReason } from '../agent-run/profiles';
import { readAdminSecretFromEnvOrFile } from '../trusted-session/admin-secret';
import {
  DeckSwitchApprovalCommitUnavailable,
  type ElicitFormFn,
  type ElicitationResult,
} from './elicitation';
import { mcpPolicyErrorWithMessage } from './policy';
import type { McpToolHost } from './register';

/**
 * Owner-approved daemon-side credential runs (`run_with_credentials`).
 *
 * A leader agent runs a command that needs deck credentials without the
 * secrets ever reaching the agent. The tool POSTs the request to the
 * backend, which resolves the deck server-side, opens a pending owner
 * approval, and — on an identical retry after approval — resolves secrets
 * from the daemon vault, spawns `argv` directly, and returns redacted
 * output. Approval surfaces mirror `switch_deck`: the client's own
 * permission prompt when the host opts into client approval, else the
 * host-native elicitation form, else the browser/menubar pending request.
 *
 * Workers never reach this tool: the server choke point denies it via
 * `WORKER_SHARED_DENY_MCP_TOOLS`, and the handler below re-checks before
 * any backend contact — so a denied call never opens an approval and never
 * resolves a secret.
 */

/** How long the tool call waits for the host-native approval form. */
export const CREDENTIAL_RUN_ELICITATION_TIMEOUT_MS = 300_000;

/**
 * Same host setting as `switch_deck` client approval: the connecting
 * client's own permission prompt is the human approval, so an approved
 * tool call executes without a further form. Unset (default) keeps host
 * elicitation, then browser/menubar approval.
 */
export function credentialRunClientApprovalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_DECK_DECK_SWITCH_APPROVAL?.trim().toLowerCase() === 'client';
}

export type CredentialRunDecision = 'approve' | 'decline';

const APPROVAL_DECISIONS: ReadonlySet<string> = new Set(['approve', 'decline']);

function isCredentialRunDecision(value: unknown): value is CredentialRunDecision {
  return typeof value === 'string' && APPROVAL_DECISIONS.has(value);
}

export type CredentialRunCreation = {
  requestId?: unknown;
  status?: unknown;
  expiresAt?: unknown;
  approvalUrl?: unknown;
} & Record<string, unknown>;

export type CredentialRunApprovalOutcome =
  | { handled: 'resolved'; payload: unknown }
  | { handled: 'fallback'; payload: unknown }
  | { handled: 'pending-recovery'; payload: unknown };

/**
 * Submit one elicited (or client-relayed) decision to the resolve endpoint.
 * The MCP server authenticates as a dashboard principal with the host's
 * admin secret; the endpoint still enforces request ownership and pending
 * status, so forged ids are rejected there. Execution itself happens on the
 * agent's identical retry, which single-use consumes the approval.
 */
export async function submitCredentialRunApprovalViaBackend(deps: {
  callBackendAPI: (endpoint: string, init?: RequestInit) => Promise<any>;
  requestId: string;
  runtimeSessionId: string;
  decision: CredentialRunDecision;
  readSecret?: () => Promise<string | null>;
  /** The client's permission prompt was the human approval. */
  approvedVia?: 'client';
}): Promise<unknown> {
  const secret = await (deps.readSecret ?? readAdminSecretFromEnvOrFile)();
  if (!secret) {
    throw new DeckSwitchApprovalCommitUnavailable(
      'Credential-run approval unavailable: no server credential for the approval API',
    );
  }
  return deps.callBackendAPI(
    `/api/trusted-session/credential-run/${encodeURIComponent(deps.requestId)}/resolve`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        runtimeSessionId: deps.runtimeSessionId,
        decision: deps.decision,
        ...(deps.approvedVia ? { approvedVia: deps.approvedVia } : {}),
      }),
    },
  );
}

function truncateDisplay(value: string, max = 4000): string {
  return value.length > max ? `${value.slice(0, max)}…(truncated)` : value;
}

/**
 * Build the host-native approval form for one pending request. The message
 * names the exact binding under approval (command, credential ids, env
 * aliases, cwd) so the owner decides on what will actually execute.
 */
export function buildCredentialRunElicitationInput(
  input: RunWithCredentialsRequest,
  creation: CredentialRunCreation,
  workspaceRoot?: string,
): { message: string; requestedSchema: Record<string, unknown> } {
  const requestId = String(creation.requestId ?? '');
  const lines = [
    'Agent requested a daemon-side run with deck credentials. Nothing has executed; approving runs this exact command with the secrets in its environment (the agent never sees the values).',
    '',
    `command: ${truncateDisplay(JSON.stringify(input.argv))}`,
    `credentials: ${truncateDisplay(input.credentials.join(', '))}`,
    `env: ${truncateDisplay(JSON.stringify(input.env ?? '(each credential under its own envName)'))}`,
    `cwd: ${truncateDisplay(input.cwd ?? workspaceRoot ?? '(session workspace)')}`,
    `timeout: ${input.timeoutSec ?? 300}s`,
  ];
  return {
    message: lines.join('\n'),
    requestedSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          title: 'Request ID',
          description: 'Pending credential-run request this decision applies to.',
          default: requestId,
        },
        decision: {
          type: 'string',
          title: 'Decision',
          description: 'Approve this exact credential run, or decline it.',
          enum: ['approve', 'decline'],
          enumNames: ['Approve and run', 'Decline'],
        },
      },
      required: ['requestId', 'decision'],
    },
  };
}

function pendingRecoveryPayload(
  creation: CredentialRunCreation,
  note: string,
): Record<string, unknown> {
  const requestId = String(creation.requestId ?? '');
  const approvalUrl =
    typeof creation.approvalUrl === 'string' && creation.approvalUrl
      ? creation.approvalUrl
      : null;
  const where = approvalUrl
    ? `at ${approvalUrl} (browser approval page) or from the menubar pending-requests inbox`
    : 'from the browser approval page or the menubar pending-requests inbox';
  return {
    requestId,
    status: 'pending',
    expiresAt: creation.expiresAt,
    ...(approvalUrl ? { approvalUrl } : {}),
    message:
      `${note} Request ${requestId} is still pending and nothing has executed. ` +
      `The human can still approve or decline it ${where}. ` +
      'After approval, call run_with_credentials again with identical input to execute.',
  };
}

/**
 * Present one pending credential-run request through the host-native form.
 * Never throws for elicitation-level failures: those degrade to the
 * browser-fallback payload with the run unexecuted. Approval API
 * rejections propagate so the caller surfaces them without retrying.
 */
export async function presentCredentialRunApproval(deps: {
  creation: CredentialRunCreation;
  input: RunWithCredentialsRequest;
  workspaceRoot?: string;
  runtimeSessionId: string;
  supportsFormElicitation: () => boolean;
  elicitForm: ElicitFormFn;
  submitApproval: (args: {
    requestId: string;
    runtimeSessionId: string;
    decision: CredentialRunDecision;
  }) => Promise<unknown>;
  /** Tool-call wait (default `CREDENTIAL_RUN_ELICITATION_TIMEOUT_MS`). */
  toolCallWaitMs?: number;
}): Promise<CredentialRunApprovalOutcome> {
  const { creation, runtimeSessionId } = deps;

  let supported = false;
  try {
    supported = deps.supportsFormElicitation();
  } catch {
    supported = false;
  }
  if (!supported) {
    return { handled: 'fallback', payload: creation };
  }

  const requestId = String(creation.requestId ?? '');
  const toolCallWaitMs = deps.toolCallWaitMs ?? CREDENTIAL_RUN_ELICITATION_TIMEOUT_MS;
  let form: Promise<ElicitationResult>;
  try {
    form = deps.elicitForm(
      buildCredentialRunElicitationInput(deps.input, creation, deps.workspaceRoot),
    );
  } catch {
    return { handled: 'fallback', payload: creation };
  }
  // Never rejects: errors become values, so a form that fails after the
  // wait already ended cannot surface as an unhandled rejection.
  const settled = Promise.resolve(form).then(
    (result): { ok: true; result: ElicitationResult } => ({ ok: true, result }),
    (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
  );
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const waitEnded = new Promise<'wait-ended'>((resolve) => {
    waitTimer = setTimeout(() => resolve('wait-ended'), toolCallWaitMs);
  });
  const first = await Promise.race([settled, waitEnded]);
  clearTimeout(waitTimer);

  if (first === 'wait-ended') {
    return {
      handled: 'pending-recovery',
      payload: pendingRecoveryPayload(
        creation,
        'The approval form got no answer in time, so this call returns pending.',
      ),
    };
  }
  if (!first.ok) {
    return { handled: 'fallback', payload: creation };
  }
  const { action, content } = first.result;
  if (action === 'cancel') {
    return {
      handled: 'pending-recovery',
      payload: pendingRecoveryPayload(creation, 'Approval dismissed with no decision.'),
    };
  }
  if (action === 'decline') {
    const payload = await deps.submitApproval({ requestId, runtimeSessionId, decision: 'decline' });
    return { handled: 'resolved', payload };
  }
  if (action !== 'accept' || !content || typeof content !== 'object') {
    return { handled: 'fallback', payload: creation };
  }
  // Pin the echoed request id to the request just created: a forged or
  // mismatched id must never approve, here or elsewhere.
  if (typeof content.requestId !== 'string' || content.requestId !== requestId) {
    return { handled: 'fallback', payload: creation };
  }
  if (!isCredentialRunDecision(content.decision)) {
    return { handled: 'fallback', payload: creation };
  }
  try {
    const payload = await deps.submitApproval({
      requestId,
      runtimeSessionId,
      decision: content.decision,
    });
    return { handled: 'resolved', payload };
  } catch (error) {
    if (error instanceof DeckSwitchApprovalCommitUnavailable) {
      return { handled: 'fallback', payload: creation };
    }
    throw error;
  }
}

const CREDENTIAL_RUN_BEFORE_BIND_MESSAGE =
  'This MCP session has not bound yet. Call bind_workspace (or get_session_binding) first, then retry run_with_credentials.';

const CREDENTIAL_RUN_DESCRIPTION_CORE =
  'argv is spawned directly with no shell (pass each argument separately; metacharacters are never interpreted). ' +
  'credentials lists deck credential ids (each must sit on this session\'s deck); env optionally renames targets ' +
  '({"HF_TOKEN":"cred_huggingface"}; listed credentials without an alias keep their credential envName). ' +
  'cwd must stay inside the session workspace; timeoutSec defaults to 300 (max 3600). ' +
  'Secrets resolve daemon-side and never reach the agent. ' +
  'Returns exitCode plus redacted stdout/stderr (secret values replaced with [REDACTED], 64 KiB per stream).';

export function registerCredentialRunTools(host: McpToolHost): void {
  const { registerTool: r } = host;

  // Captured at registration so the behavior always matches the
  // description the client showed the human.
  const clientApproval = credentialRunClientApprovalEnabled();

  r('run_with_credentials', {
    title: clientApproval
      ? 'Run Command With Deck Credentials (executes on approval)'
      : 'Run Command With Deck Credentials',
    description: clientApproval
      ? `Run one command on the Agent Deck host with deck credentials in its environment: on this host, approving this tool call in your client IS the human approval and the command executes as soon as the call returns. ${CREDENTIAL_RUN_DESCRIPTION_CORE}`
      : `Run one command on the Agent Deck host with deck credentials in its environment, without the secrets ever reaching the agent. ${CREDENTIAL_RUN_DESCRIPTION_CORE} ` +
        'Owner approval is required per call: this call opens a pending request (host approval form when supported, else the browser approval link), ' +
        'and after the owner approves you MUST call run_with_credentials again with identical input to execute — approvals are single-use and expire after 10 minutes.',
    inputSchema: RunWithCredentialsRequestSchema,
  }, async (input: RunWithCredentialsRequest) => {
    try {
      const sessionId = host.getSessionId();
      // Worker deny before any backend contact: no approval is opened and
      // no secret is resolved. (The server choke point denies first via
      // WORKER_SHARED_DENY_MCP_TOOLS; this re-check covers direct handler
      // dispatch.)
      const worker = host.sessionBinding.getWorkerSession?.(sessionId);
      if (worker) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              code: 'PROFILE_DENIED',
              profile: worker.profile,
              tool: 'run_with_credentials',
              reason: mcpToolDenialReason(worker.profile, 'run_with_credentials'),
            }),
          }],
          isError: true,
        };
      }
      const snapshot = host.sessionBinding.getBinding(sessionId);
      if (!snapshot.runtimeSessionId) {
        return mcpPolicyErrorWithMessage('GRANT_REQUIRED', CREDENTIAL_RUN_BEFORE_BIND_MESSAGE);
      }
      const runtimeSessionId = snapshot.runtimeSessionId;
      // The caller is a leader (workers were denied above), so no
      // worker-profile marker is sent; the backend route denies any
      // execution call that carries one.
      const postRun = () =>
        host.callBackendAPI('/api/trusted-session/credential-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
      const result = await postRun();
      if (result && typeof result === 'object' && (result as { status?: unknown }).status === 'executed') {
        return host.toolResult(result);
      }
      // Client approval: the caller's permission prompt was the human
      // approval, so a pending request from a local (non-grant) session is
      // approved right away and the identical retry executes immediately.
      if (
        clientApproval &&
        host.sessionBinding.isGrantSession?.(sessionId) === false &&
        result &&
        typeof result === 'object' &&
        (result as { status?: unknown }).status === 'pending' &&
        typeof (result as { requestId?: unknown }).requestId === 'string'
      ) {
        try {
          await submitCredentialRunApprovalViaBackend({
            callBackendAPI: (endpoint, init) => host.callBackendAPI(endpoint, init),
            requestId: (result as { requestId: string }).requestId,
            runtimeSessionId,
            decision: 'approve',
            approvedVia: 'client',
          });
          return host.toolResult(await postRun());
        } catch (error) {
          // No commit secret on this host: the request stays pending and
          // the normal approval surfaces below take over.
          if (!(error instanceof DeckSwitchApprovalCommitUnavailable)) {
            throw error;
          }
        }
      }
      // Host-native form first; every other outcome returns the pending
      // creation so the browser/menubar path owns the approval.
      if (
        host.elicitation &&
        result &&
        typeof result === 'object' &&
        (result as { status?: unknown }).status === 'pending' &&
        typeof (result as { requestId?: unknown }).requestId === 'string'
      ) {
        const elicitation = host.elicitation;
        const outcome = await presentCredentialRunApproval({
          creation: result as CredentialRunCreation,
          input,
          workspaceRoot: snapshot.workspaceRoot,
          runtimeSessionId,
          supportsFormElicitation: () => elicitation.supportsFormElicitation(),
          elicitForm: (formInput, options) => elicitation.elicitForm(formInput, options),
          ...(elicitation.toolCallWaitMs !== undefined ? { toolCallWaitMs: elicitation.toolCallWaitMs } : {}),
          submitApproval: ({ requestId, runtimeSessionId: owner, decision }) =>
            submitCredentialRunApprovalViaBackend({
              callBackendAPI: (endpoint, init) => host.callBackendAPI(endpoint, init),
              requestId,
              runtimeSessionId: owner,
              decision,
            }),
        });
        if (outcome.handled === 'resolved') {
          const payload = outcome.payload as { status?: unknown };
          // An approval through the form executes on the identical retry
          // right away; a decline (or anything else) returns as-is.
          if (payload && typeof payload === 'object' && payload.status === 'approved') {
            return host.toolResult(await postRun());
          }
          return host.toolResult(outcome.payload);
        }
        return host.toolResult(outcome.payload);
      }
      return host.toolResult(result);
    } catch (error) {
      return host.toolError(error);
    }
  });
}
