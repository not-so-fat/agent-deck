/**
 * NOT-213: host-native MCP form elicitation for deck-switch approval.
 *
 * Presentation order (deck-switching redesign spec 2.3): host-native MCP
 * form first, bootstrapped browser approval second, menubar pending-request
 * recovery third. This adapter is the first surface: after `switch_deck`
 * creates a pending request, it presents This session only, Decline, and —
 * when the request carries a workspaceRoot — This workspace by default,
 * through the host's structured input UI when the connected client
 * advertises form elicitation. Launch/remote sessions without a writable
 * workspace omit the workspace-default choice (NOT-298).
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
 * - Unsupported capability, transport error, malformed response, or an
 *   unavailable commit path all degrade to the browser-fallback
 *   presentation hint with the deck unchanged.
 *
 * Two timers (NOT-638):
 * - Tool-call wait (`DECK_SWITCH_ELICITATION_TIMEOUT_MS`, 5 minutes): how
 *   long the `switch_deck` call blocks on the form. When it ends with no
 *   answer, the call returns a `pending` payload that says the form timed
 *   out for this call and how the human can still approve.
 * - Form lifetime: the time left until the request's `expiresAt`, at least
 *   the tool-call wait and at most `DECK_SWITCH_REQUEST_TTL_MS`. The
 *   elicitation request (and its SDK response handler) stays open that
 *   long, so a late answer in the same form still applies through the
 *   same pinned-id/scope validation and resolve API as an on-time answer.
 *   When the form lifetime ends unanswered the SDK sends
 *   `notifications/cancelled` for the elicitation. A late answer that
 *   cannot be applied (resolved elsewhere, expired, transport closed,
 *   malformed) is logged and dropped — never thrown.
 */

import { readAdminSecretFromEnvOrFile } from '../trusted-session/admin-secret';
import { DECK_SWITCH_REQUEST_TTL_MS } from '../trusted-session/store';

/**
 * Tool-call wait: how long the `switch_deck` call waits for the human to
 * answer the native form — 5 minutes (NOT-636). After this the call returns
 * `pending` with a timed-out message, but the form itself stays live
 * (NOT-638): its lifetime is the time left until the request's `expiresAt`
 * (capped at `DECK_SWITCH_REQUEST_TTL_MS`, 30 minutes, and never shorter
 * than this wait), so a late answer in the same form still applies. See
 * `deckSwitchFormLifetimeMs`.
 */
export const DECK_SWITCH_ELICITATION_TIMEOUT_MS = 300_000;

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

/**
 * NOT-298: workspace-default is only offered when the pending request has a
 * writable workspaceRoot. Launch/remote sessions without one get session +
 * decline only — the approval API still rejects a forged workspace-default.
 */
export function deckSwitchHasWorkspaceRoot(creation: DeckSwitchCreationResult): boolean {
  return typeof creation.workspaceRoot === 'string' && creation.workspaceRoot.trim().length > 0;
}

export function deckSwitchApprovalScopes(
  creation: DeckSwitchCreationResult,
): DeckSwitchApprovalScope[] {
  if (deckSwitchHasWorkspaceRoot(creation)) {
    return ['session', 'workspace-default', 'decline'];
  }
  return ['session', 'decline'];
}

export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export type ElicitationResult = {
  action: ElicitationAction;
  content?: Record<string, unknown>;
};

/**
 * NOT-638: per-call elicitation options. `timeoutMs` is the form lifetime
 * the SDK request stays open for (its response handler lives that long);
 * `signal` lets the adapter cancel the open form. Both end the request
 * with `notifications/cancelled`. Omitted options keep the provider's
 * default (the tool-call wait), which other callers rely on.
 */
export type ElicitFormOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ElicitFormFn = (
  input: {
    message: string;
    requestedSchema: Record<string, unknown>;
  },
  options?: ElicitFormOptions,
) => Promise<ElicitationResult>;

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
 * scope enum with the applicable human labels. No URLs, no secrets.
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
  const scopes = deckSwitchApprovalScopes(creation);
  const hasWorkspace = deckSwitchHasWorkspaceRoot(creation);
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
          description: hasWorkspace
            ? `Approve the switch to "${requested}" for this session only or as the workspace default, or decline it.`
            : `Approve the switch to "${requested}" for this session only, or decline it. This session has no writable workspace default.`,
          enum: [...scopes],
          enumNames: scopes.map((scope) => DECK_SWITCH_SCOPE_LABELS[scope]),
        },
      },
      required: ['requestId', 'scope'],
    },
  };
}

/**
 * Cancel payload: the request is still pending, the deck is unchanged,
 * and the agent gets a secret-free note explaining where the human can
 * reopen the decision: the absolute browser approval link (NOT-632, carried
 * from the creation response) or the menubar inbox.
 */
export function buildCancelRecoveryPayload(creation: DeckSwitchCreationResult): Record<string, unknown> {
  const requestId = String(creation.requestId ?? '');
  const current = typeof creation.currentDeckName === 'string' ? creation.currentDeckName : 'current deck';
  const requested = typeof creation.requestedDeckName === 'string' ? creation.requestedDeckName : 'requested deck';
  const approvalUrl = typeof creation.approvalUrl === 'string' && creation.approvalUrl ? creation.approvalUrl : null;
  const scopeHint = deckSwitchHasWorkspaceRoot(creation)
    ? '"This session only" or "This workspace by default"'
    : '"This session only"';
  const where = approvalUrl
    ? `at ${approvalUrl} (browser approval page) or from the menubar pending-requests inbox`
    : 'from the browser approval page or the menubar pending-requests inbox';
  return {
    requestId,
    status: 'pending',
    currentDeckName: creation.currentDeckName,
    requestedDeckName: creation.requestedDeckName,
    expiresAt: creation.expiresAt,
    channel: 'browser',
    ...(approvalUrl ? { approvalUrl } : {}),
    message:
      `Approval dismissed with no decision. Request ${requestId} is still pending and the active deck ` +
      `("${current}") is unchanged. Approve the switch to "${requested}" (${scopeHint}) or decline it ` +
      `${where}.`,
  };
}

/** "5 minutes", "90 seconds", "50 ms" — for agent-facing messages. */
export function formatWaitDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (ms >= 1_000 && ms % 1_000 === 0) {
    const seconds = ms / 1_000;
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}

/**
 * NOT-638: payload for a form that got no answer within the tool-call wait.
 * The request is still pending, the deck is unchanged, and the same form
 * (still open in the client) remains a valid way to approve, alongside the
 * absolute approval link and the menubar inbox.
 */
export function buildTimedOutRecoveryPayload(
  creation: DeckSwitchCreationResult,
  toolCallWaitMs: number = DECK_SWITCH_ELICITATION_TIMEOUT_MS,
): Record<string, unknown> {
  const requestId = String(creation.requestId ?? '');
  const current = typeof creation.currentDeckName === 'string' ? creation.currentDeckName : 'current deck';
  const requested = typeof creation.requestedDeckName === 'string' ? creation.requestedDeckName : 'requested deck';
  const approvalUrl = typeof creation.approvalUrl === 'string' && creation.approvalUrl ? creation.approvalUrl : null;
  const expiresAt = typeof creation.expiresAt === 'string' && creation.expiresAt ? creation.expiresAt : null;
  const until = expiresAt ? ` until ${expiresAt}` : '';
  const where = approvalUrl ? `at ${approvalUrl}` : 'at the browser approval page';
  return {
    requestId,
    status: 'pending',
    currentDeckName: creation.currentDeckName,
    requestedDeckName: creation.requestedDeckName,
    expiresAt: creation.expiresAt,
    ...(approvalUrl ? { approvalUrl } : {}),
    message:
      `The approval form for this switch_deck call got no answer within ${formatWaitDuration(toolCallWaitMs)}, ` +
      `so this call returns pending. Request ${requestId} is still pending and the active deck ` +
      `("${current}") is unchanged${until}. The human can still approve the switch to "${requested}" by ` +
      `answering the form if it is still open in their client, ${where}, or from the menubar ` +
      `pending-requests inbox. After approval, call get_session_context.`,
  };
}

/**
 * NOT-638: how long the form (the SDK elicitation request) stays open —
 * the time left until the request's `expiresAt`, never shorter than the
 * tool-call wait and never longer than the request TTL. An unparseable
 * `expiresAt` uses the TTL.
 */
export function deckSwitchFormLifetimeMs(
  expiresAt: unknown,
  toolCallWaitMs: number = DECK_SWITCH_ELICITATION_TIMEOUT_MS,
  now: number = Date.now(),
): number {
  const ceiling = Math.max(DECK_SWITCH_REQUEST_TTL_MS, toolCallWaitMs);
  const parsed = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  const remaining = Number.isFinite(parsed) ? parsed - now : ceiling;
  return Math.min(ceiling, Math.max(toolCallWaitMs, remaining));
}

/**
 * Translate one elicitation answer into an action, pinned to the request
 * just created. Shared by on-time and late answers so both apply exactly
 * the same validation.
 */
type InterpretedAnswer =
  | { kind: 'submit'; decision: DeckSwitchApprovalScope }
  | { kind: 'cancel' }
  | { kind: 'invalid'; reason: string };

function interpretDeckSwitchAnswer(result: unknown, requestId: string): InterpretedAnswer {
  if (!result || typeof result !== 'object' || typeof (result as { action?: unknown }).action !== 'string') {
    return { kind: 'invalid', reason: 'malformed elicitation result' };
  }
  const { action, content } = result as ElicitationResult;
  if (action === 'cancel') {
    return { kind: 'cancel' };
  }
  if (action === 'decline') {
    // Host-level decline without a submitted scope: the human declined
    // the switch itself.
    return { kind: 'submit', decision: 'decline' };
  }
  if (action !== 'accept') {
    return { kind: 'invalid', reason: `unknown action ${String(action)}` };
  }
  if (!content || typeof content !== 'object') {
    return { kind: 'invalid', reason: 'accept without content' };
  }
  // Pin the echoed request id to the request just created: a forged or
  // mismatched id must never commit, here or elsewhere.
  if (typeof content.requestId !== 'string' || content.requestId !== requestId) {
    return { kind: 'invalid', reason: 'mismatched request id' };
  }
  if (!isDeckSwitchApprovalScope(content.scope)) {
    return { kind: 'invalid', reason: 'invalid scope' };
  }
  return { kind: 'submit', decision: content.scope };
}

export type DeckSwitchLateAnswerLog = (message: string, detail?: Record<string, unknown>) => void;

const defaultLateAnswerLog: DeckSwitchLateAnswerLog = (message, detail) => {
  console.warn(`[agent-deck] ${message}`, detail ?? {});
};

function errorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const status = (error as { statusCode?: unknown; status?: unknown }).statusCode ??
      (error as { status?: unknown }).status;
    const code = (error as { errorCode?: unknown; code?: unknown }).errorCode ??
      (error as { code?: unknown }).code;
    return {
      error: error.name,
      message: error.message,
      ...(status !== undefined ? { status } : {}),
      ...(code !== undefined ? { code } : {}),
    };
  }
  return { error: String(error) };
}

/**
 * NOT-638: apply an answer that arrived after the tool call already
 * returned `pending`. Same validation and submit path as an on-time
 * answer; every failure is logged and dropped. Never rejects.
 */
async function applyLateDeckSwitchAnswer(args: {
  settled: { ok: true; result: ElicitationResult } | { ok: false; error: unknown };
  requestId: string;
  runtimeSessionId: string;
  submitApproval: SubmitApprovalFn;
  log: DeckSwitchLateAnswerLog;
}): Promise<void> {
  const { settled, requestId, runtimeSessionId, log } = args;
  try {
    if (!settled.ok) {
      log('switch_deck: approval form closed without a late answer; request left as is', {
        requestId,
        ...errorSummary(settled.error),
      });
      return;
    }
    const answer = interpretDeckSwitchAnswer(settled.result, requestId);
    if (answer.kind === 'cancel') {
      log('switch_deck: late approval form dismissed; request stays pending', { requestId });
      return;
    }
    if (answer.kind === 'invalid') {
      log('switch_deck: late approval answer dropped', { requestId, reason: answer.reason });
      return;
    }
    await args.submitApproval({ requestId, runtimeSessionId, decision: answer.decision });
    log('switch_deck: late approval answer applied', { requestId, decision: answer.decision });
  } catch (error) {
    // Resolved elsewhere (409), expired, session invalid, no commit
    // credential — the request is no longer ours to decide here.
    try {
      log('switch_deck: late approval answer could not be applied', {
        requestId,
        ...errorSummary(error),
      });
    } catch {
      // A failing logger must not turn into an unhandled rejection.
    }
  }
}

/**
 * Present one pending deck-switch request through the host-native form.
 * Never throws for elicitation-level failures: those degrade to the
 * browser-fallback payload. Approval API rejections propagate so the
 * caller surfaces them without retrying.
 *
 * NOT-638: the form stays open for the form lifetime while the call waits
 * only `toolCallWaitMs`. If the wait ends first, the call returns the
 * timed-out `pending-recovery` payload and a late answer is applied in the
 * background (`lateAnswer` resolves when that work is done — tests await
 * it; production ignores it).
 */
export async function presentDeckSwitchApproval(deps: {
  creation: DeckSwitchCreationResult;
  runtimeSessionId: string;
  supportsFormElicitation: () => boolean;
  elicitForm: ElicitFormFn;
  submitApproval: SubmitApprovalFn;
  /** Tool-call wait (default `DECK_SWITCH_ELICITATION_TIMEOUT_MS`). */
  toolCallWaitMs?: number;
  /** Form lifetime override; default derives from the request's `expiresAt`. */
  formLifetimeMs?: number;
  now?: () => number;
  log?: DeckSwitchLateAnswerLog;
  /** Receives the background late-answer task when the wait ends first. */
  onLateAnswer?: (task: Promise<void>) => void;
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

  const requestId = String(creation.requestId ?? '');
  const toolCallWaitMs = deps.toolCallWaitMs ?? DECK_SWITCH_ELICITATION_TIMEOUT_MS;
  const formLifetimeMs =
    deps.formLifetimeMs ??
    deckSwitchFormLifetimeMs(creation.expiresAt, toolCallWaitMs, (deps.now ?? Date.now)());

  // The signal cancels the open form when its lifetime ends (the SDK
  // timeout carries the same deadline; whichever fires first sends
  // `notifications/cancelled`). It is never aborted after the form settles,
  // so an answered form gets no spurious cancellation.
  const controller = new AbortController();
  let formSettled = false;
  const lifetimeTimer = setTimeout(() => {
    if (!formSettled) {
      controller.abort(new Error('Deck-switch approval form lifetime ended'));
    }
  }, formLifetimeMs);
  lifetimeTimer.unref?.();

  type Settled = { ok: true; result: ElicitationResult } | { ok: false; error: unknown };
  let started: Promise<ElicitationResult>;
  try {
    started = deps.elicitForm(buildDeckSwitchElicitationInput(creation), {
      timeoutMs: formLifetimeMs,
      signal: controller.signal,
    });
  } catch (error) {
    started = Promise.reject(error);
  }
  // Never rejects: errors become values, so a form that fails after the
  // call returned cannot surface as an unhandled rejection.
  const form: Promise<Settled> = Promise.resolve(started).then(
    (result): Settled => ({ ok: true, result }),
    (error: unknown): Settled => ({ ok: false, error }),
  ).finally(() => {
    formSettled = true;
    clearTimeout(lifetimeTimer);
  });

  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const waitEnded = new Promise<'wait-ended'>((resolve) => {
    waitTimer = setTimeout(() => resolve('wait-ended'), toolCallWaitMs);
  });
  const first = await Promise.race([form, waitEnded]);
  clearTimeout(waitTimer);

  if (first === 'wait-ended') {
    const task = form.then((settled) =>
      applyLateDeckSwitchAnswer({
        settled,
        requestId,
        runtimeSessionId,
        submitApproval: deps.submitApproval,
        log: deps.log ?? defaultLateAnswerLog,
      }),
    );
    deps.onLateAnswer?.(task);
    return {
      handled: 'pending-recovery',
      payload: buildTimedOutRecoveryPayload(creation, toolCallWaitMs),
    };
  }

  if (!first.ok) {
    // Transport error, form lifetime ended, or schema mismatch (SDK
    // validates the accepted content against requestedSchema and throws
    // McpError).
    return { handled: 'fallback', payload: creation };
  }

  const answer = interpretDeckSwitchAnswer(first.result, requestId);
  if (answer.kind === 'cancel') {
    return { handled: 'pending-recovery', payload: buildCancelRecoveryPayload(creation) };
  }
  if (answer.kind === 'invalid') {
    return { handled: 'fallback', payload: creation };
  }
  try {
    const payload = await deps.submitApproval({ requestId, runtimeSessionId, decision: answer.decision });
    return { handled: 'resolved', payload };
  } catch (error) {
    // The server cannot submit (no commit credential): the request is
    // still pending, so the browser fallback is the honest answer.
    if (error instanceof DeckSwitchApprovalCommitUnavailable) {
      return { handled: 'fallback', payload: creation };
    }
    throw error;
  }
}

/**
 * NOT-638: the production elicitation provider over an SDK server (kept
 * structural so this module stays SDK-free). Passes the SDK both the form
 * lifetime as `timeout` and the adapter's `AbortSignal`, so the response
 * handler outlives the tool-call wait and the SDK sends
 * `notifications/cancelled` when the form lifetime ends. Calls without
 * options (deck assignment) keep the tool-call wait as their timeout.
 */
export type SdkElicitingServer = {
  getClientCapabilities(): unknown;
  elicitInput(
    params: { message: string; requestedSchema: any },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<{ action: ElicitationAction; content?: Record<string, unknown> }>;
};

export function createSdkElicitationProvider(
  server: SdkElicitingServer,
  options?: { toolCallWaitMs?: number; formLifetimeMs?: number },
): {
  supportsFormElicitation(): boolean;
  elicitForm: ElicitFormFn;
  toolCallWaitMs?: number;
  formLifetimeMs?: number;
} {
  return {
    supportsFormElicitation: () => supportsFormElicitation(server.getClientCapabilities()),
    elicitForm: async (input, elicitOptions) => {
      const result = await server.elicitInput(
        { message: input.message, requestedSchema: input.requestedSchema },
        {
          timeout: elicitOptions?.timeoutMs ?? DECK_SWITCH_ELICITATION_TIMEOUT_MS,
          ...(elicitOptions?.signal ? { signal: elicitOptions.signal } : {}),
        },
      );
      return {
        action: result.action,
        ...(result.content ? { content: { ...result.content } } : {}),
      };
    },
    ...(options?.toolCallWaitMs !== undefined ? { toolCallWaitMs: options.toolCallWaitMs } : {}),
    ...(options?.formLifetimeMs !== undefined ? { formLifetimeMs: options.formLifetimeMs } : {}),
  };
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
  /** NOT-632: the client's permission prompt was the human approval. */
  approvedVia?: 'client';
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
      body: JSON.stringify({
        runtimeSessionId: deps.runtimeSessionId,
        decision: deps.decision,
        ...(deps.approvedVia ? { approvedVia: deps.approvedVia } : {}),
      }),
    },
  );
}
