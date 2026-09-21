/**
 * NOT-213: host-native MCP form elicitation for deck-switch approval.
 *
 * Presentation order (deck-switching redesign spec 2.3): host-native MCP
 * form first, bootstrapped browser approval second, menubar pending-request
 * recovery third. This adapter is the first surface: after `switch_deck`
 * creates a pending request, it presents one choice — This session only,
 * This workspace by default, or Decline — through the host's structured
 * input UI when the connected client advertises form elicitation.
 *
 * Design notes:
 * - The adapter is transport-agnostic and SDK-free: capability detection
 *   takes the client's reported capabilities object, and elicitation /
 *   approval submission are injected. The production provider lives in
 *   mcp-server.ts (per-session McpServer) and register.ts.
 * - Decision and commit authority stay server-side. The form carries only
 *   the opaque request id (echoed back) and the chosen scope; the adapter
 *   pins both to the request it just created before submitting, and the
 *   approval API re-validates ownership, scope, and pending status. A
 *   forged scope or request id is rejected there (400/404/403).
 * - Cancellation (dismissed form) never touches the approval API: the
 *   request stays pending for browser/menubar recovery and the response
 *   explains how to reopen it.
 * - Unsupported capability, timeout, transport error, malformed response,
 *   or an unavailable commit path all degrade to the browser-fallback
 *   presentation hint with the deck unchanged.
 */

import { readAdminSecretFromEnvOrFile } from '../trusted-session/admin-secret';

/** How long the tool call waits for the human to answer the native form. */
export const DECK_SWITCH_ELICITATION_TIMEOUT_MS = 60_000;

/** Commit scopes the approval API accepts (NOT-207). */
export type DeckSwitchApprovalScope = 'session' | 'workspace-default' | 'decline';

const APPROVAL_SCOPES: ReadonlySet<string> = new Set([
  'session',
  'workspace-default',
  'decline',
]);

export function isDeckSwitchApprovalScope(value: unknown): value is DeckSwitchApprovalScope {
  return typeof value === 'string' && APPROVAL_SCOPES.has(value);
}

/** Human labels shown in the native form (enumNames). */
export const DECK_SWITCH_SCOPE_LABELS: Record<DeckSwitchApprovalScope, string> = {
  session: 'This session only',
  'workspace-default': 'This workspace by default',
  decline: 'Decline',
};

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export type ElicitationResult = {
  action: ElicitationAction;
  content?: Record<string, unknown>;
};

export type ElicitFormFn = (input: {
  message: string;
  requestedSchema: Record<string, unknown>;
}) => Promise<ElicitationResult>;

export type SubmitApprovalFn = (args: {
  requestId: string;
  runtimeSessionId: string;
  decision: DeckSwitchApprovalScope;
}) => Promise<unknown>;

/** Minimal structural view of the NOT-209 creation result. */
export type DeckSwitchCreationResult = {
  requestId?: unknown;
  status?: unknown;
  currentDeckId?: unknown;
  currentDeckName?: unknown;
  requestedDeckId?: unknown;
  requestedDeckName?: unknown;
  expiresAt?: unknown;
  presentation?: {
    title?: unknown;
    body?: unknown;
    status?: unknown;
    expiresAt?: unknown;
  } & Record<string, unknown>;
} & Record<string, unknown>;

export type DeckSwitchApprovalOutcome =
  | { handled: 'resolved'; payload: unknown }
  | { handled: 'fallback'; payload: unknown }
  | { handled: 'pending-recovery'; payload: unknown };

/**
 * Capability gate: true only when the connected client advertises
 * `elicitation.form` (SDK ClientCapabilities shape). Anything else —
 * missing, malformed, or url-only — means the browser fallback owns
 * the approval.
 */
export function supportsFormElicitation(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') {
    return false;
  }
  const elicitation = (capabilities as { elicitation?: unknown }).elicitation;
  if (!elicitation || typeof elicitation !== 'object') {
    return false;
  }
  const form = (elicitation as { form?: unknown }).form;
  return !!form && typeof form === 'object';
}

/**
 * Build the `elicitation/create` form params for one pending request.
 * The message reuses the creation response's display-safe labels; the
 * schema carries only the opaque request id (as the default) and the
 * scope enum with all three human labels. No URLs, no secrets.
 */
export function buildDeckSwitchElicitationInput(creation: DeckSwitchCreationResult): {
  message: string;
  requestedSchema: Record<string, unknown>;
} {
  const requestId = String(creation.requestId ?? '');
  const current = typeof creation.currentDeckName === 'string' ? creation.currentDeckName : 'current deck';
  const requested = typeof creation.requestedDeckName === 'string' ? creation.requestedDeckName : 'requested deck';
  const body = typeof creation.presentation?.body === 'string' ? creation.presentation.body : null;
  const message = body ?? `Agent requested a deck switch from "${current}" to "${requested}". The active deck is unchanged until a human approves.`;
  return {
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          title: 'Request ID',
          description: 'Pending deck-switch request this decision applies to.',
          default: requestId,
        },
        scope: {
          type: 'string',
          title: 'Approval scope',
          description: `Approve the switch to "${requested}" for this session only or as the workspace default, or decline it.`,
          enum: ['session', 'workspace-default', 'decline'],
          enumNames: [
            DECK_SWITCH_SCOPE_LABELS.session,
            DECK_SWITCH_SCOPE_LABELS['workspace-default'],
            DECK_SWITCH_SCOPE_LABELS.decline,
          ],
        },
      },
      required: ['requestId', 'scope'],
    },
  };
}

/**
 * Cancel payload: the request is still pending, the deck is unchanged,
 * and the agent gets a secret-free, URL-free note explaining where the
 * human can reopen the decision (browser approval page, menubar inbox).
 */
export function buildCancelRecoveryPayload(creation: DeckSwitchCreationResult): Record<string, unknown> {
  const requestId = String(creation.requestId ?? '');
  const current = typeof creation.currentDeckName === 'string' ? creation.currentDeckName : 'current deck';
  const requested = typeof creation.requestedDeckName === 'string' ? creation.requestedDeckName : 'requested deck';
  return {
    requestId,
    status: 'pending',
    currentDeckName: creation.currentDeckName,
    requestedDeckName: creation.requestedDeckName,
    expiresAt: creation.expiresAt,
    channel: 'browser',
    message:
      `Approval dismissed with no decision. Request ${requestId} is still pending and the active deck ` +
      `("${current}") is unchanged. Approve the switch to "${requested}" ("This session only" or ` +
      `"This workspace by default") or decline it from the browser approval page or the menubar ` +
      `pending-requests inbox.`,
  };
}

/**
 * Present one pending deck-switch request through the host-native form.
 * Never throws for elicitation-level failures: those degrade to the
 * browser-fallback payload. Approval API rejections propagate so the
 * caller surfaces them without retrying.
 */
export async function presentDeckSwitchApproval(deps: {
  creation: DeckSwitchCreationResult;
  runtimeSessionId: string;
  supportsFormElicitation: () => boolean;
  elicitForm: ElicitFormFn;
  submitApproval: SubmitApprovalFn;
}): Promise<DeckSwitchApprovalOutcome> {
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

  let result: ElicitationResult;
  try {
    result = await deps.elicitForm(buildDeckSwitchElicitationInput(creation));
  } catch {
    // Timeout, transport error, or schema mismatch (SDK validates the
    // accepted content against requestedSchema and throws McpError).
    return { handled: 'fallback', payload: creation };
  }
  if (!result || typeof result !== 'object' || typeof result.action !== 'string') {
    return { handled: 'fallback', payload: creation };
  }

  const requestId = String(creation.requestId ?? '');
  if (result.action === 'cancel') {
    return { handled: 'pending-recovery', payload: buildCancelRecoveryPayload(creation) };
  }

  const submit = async (decision: DeckSwitchApprovalScope): Promise<DeckSwitchApprovalOutcome> => {
    try {
      const payload = await deps.submitApproval({ requestId, runtimeSessionId, decision });
      return { handled: 'resolved', payload };
    } catch (error) {
      // The server cannot submit (no commit credential): the request is
      // still pending, so the browser fallback is the honest answer.
      if (error instanceof DeckSwitchApprovalCommitUnavailable) {
        return { handled: 'fallback', payload: creation };
      }
      throw error;
    }
  };

  if (result.action === 'decline') {
    // Host-level decline without a submitted scope: the human declined
    // the switch itself.
    return submit('decline');
  }

  if (result.action !== 'accept') {
    return { handled: 'fallback', payload: creation };
  }
  const content = result.content;
  if (!content || typeof content !== 'object') {
    return { handled: 'fallback', payload: creation };
  }
  // Pin the echoed request id to the request just created: a forged or
  // mismatched id must never commit, here or elsewhere.
  if (typeof content.requestId !== 'string' || content.requestId !== requestId) {
    return { handled: 'fallback', payload: creation };
  }
  if (!isDeckSwitchApprovalScope(content.scope)) {
    return { handled: 'fallback', payload: creation };
  }
  return submit(content.scope);
}

/** The server holds no credential that the approval API accepts. */
export class DeckSwitchApprovalCommitUnavailable extends Error {
  constructor(message = 'Deck-switch approval commit unavailable: no server credential for the approval API') {
    super(message);
    this.name = 'DeckSwitchApprovalCommitUnavailable';
  }
}

/**
 * Submit one elicited decision to the NOT-207 resolve endpoint. The MCP
 * server authenticates as a dashboard principal with the host's admin
 * secret (same credential the backend itself accepts for dashboard
 * callers); the endpoint still enforces request ownership, scope, and
 * pending status, so forged ids/scopes are rejected there.
 */
export async function submitDeckSwitchApprovalViaBackend(deps: {
  callBackendAPI: (endpoint: string, init?: RequestInit) => Promise<any>;
  requestId: string;
  runtimeSessionId: string;
  decision: DeckSwitchApprovalScope;
  readSecret?: () => Promise<string | null>;
}): Promise<unknown> {
  const secret = await (deps.readSecret ?? readAdminSecretFromEnvOrFile)();
  if (!secret) {
    throw new DeckSwitchApprovalCommitUnavailable();
  }
  return deps.callBackendAPI(
    `/api/trusted-session/deck-switch/${encodeURIComponent(deps.requestId)}/resolve`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ runtimeSessionId: deps.runtimeSessionId, decision: deps.decision }),
    },
  );
}
