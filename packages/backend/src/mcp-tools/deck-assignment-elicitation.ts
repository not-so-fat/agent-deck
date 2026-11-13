/**
 * NOT-597: host-native MCP form elicitation for deck-assignment approval.
 *
 * Mirrors the deck-switch adapter (`elicitation.ts`) but the human picks
 * the deck: the form carries the opaque request id, a deck picker
 * (server-fetched deck list — never visible to the agent), and the scope
 * enum. The folder path rides the message in full; the path is only
 * trusted after the user approves the panel displaying it.
 *
 * Design notes (same as switch):
 * - Decision and commit authority stay server-side. The adapter pins the
 *   request id and validates the deck id against the list it just
 *   fetched before submitting; the approval API re-validates.
 * - Cancellation never touches the approval API: the request stays
 *   pending for browser/menubar recovery.
 * - Unsupported capability, timeout, transport error, malformed
 *   response, or an unavailable commit path all degrade to the
 *   browser-fallback presentation hint with the session unassigned.
 */
import { readAdminSecretFromEnvOrFile } from '../trusted-session/admin-secret';
import {
  DECK_SWITCH_ELICITATION_TIMEOUT_MS,
  DECK_SWITCH_SCOPE_LABELS,
  DeckSwitchApprovalScope,
  ElicitFormFn,
  ElicitationResult,
  isDeckSwitchApprovalScope,
} from './elicitation';

export type DeckAssignmentApprovalScope = DeckSwitchApprovalScope;

export type DeckAssignmentDeckOption = {
  id: string;
  name: string;
};

/** Minimal structural view of the NOT-597 creation result. */
export type DeckAssignmentCreationResult = {
  requestId?: unknown;
  status?: unknown;
  workspaceRoot?: unknown;
  expiresAt?: unknown;
  presentation?: {
    title?: unknown;
    body?: unknown;
    status?: unknown;
    expiresAt?: unknown;
  } & Record<string, unknown>;
} & Record<string, unknown>;

export type DeckAssignmentApprovalOutcome =
  | { handled: 'resolved'; payload: unknown }
  | { handled: 'fallback'; payload: unknown }
  | { handled: 'pending-recovery'; payload: unknown };

export type SubmitAssignmentApprovalFn = (args: {
  requestId: string;
  deckId?: string;
  decision: DeckAssignmentApprovalScope;
}) => Promise<unknown>;

/**
 * Build the `elicitation/create` form params for one pending assignment.
 * The message names the full folder path; the schema carries only the
 * opaque request id (as the default), the deck picker, and the scope
 * enum. No URLs, no secrets.
 */
export function buildDeckAssignmentElicitationInput(
  creation: DeckAssignmentCreationResult,
  decks: DeckAssignmentDeckOption[],
): {
  message: string;
  requestedSchema: Record<string, unknown>;
} {
  const requestId = String(creation.requestId ?? '');
  const workspaceRoot =
    typeof creation.workspaceRoot === 'string' && creation.workspaceRoot.trim()
      ? creation.workspaceRoot.trim()
      : typeof creation.presentation?.body === 'string'
        ? ''
        : 'this folder';
  const body =
    typeof creation.presentation?.body === 'string' ? creation.presentation.body : null;
  const message =
    body ??
    `Agent requested a deck assignment for folder "${workspaceRoot}". Pick the deck — the session stays unassigned until a human approves.`;
  const scopes: DeckAssignmentApprovalScope[] = ['session', 'workspace-default', 'decline'];
  return {
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          title: 'Request ID',
          description: 'Pending deck-assignment request this decision applies to.',
          default: requestId,
        },
        deckId: {
          type: 'string',
          title: 'Deck',
          description: `Deck to assign to "${workspaceRoot || 'this folder'}". Ignored when declining.`,
          enum: decks.map((deck) => deck.id),
          enumNames: decks.map((deck) => deck.name),
        },
        scope: {
          type: 'string',
          title: 'Approval scope',
          description:
            'Approve the assignment for this session only or as the workspace default (writes .agent-deck/use.json plus the per-folder host entry), or decline it.',
          enum: [...scopes],
          enumNames: scopes.map((scope) => DECK_SWITCH_SCOPE_LABELS[scope]),
        },
      },
      required: ['requestId', 'deckId', 'scope'],
    },
  };
}

/**
 * Cancel payload: the request is still pending, the session stays
 * unassigned, and the agent gets a secret-free note explaining where
 * the human can reopen the decision.
 */
export function buildAssignmentCancelRecoveryPayload(
  creation: DeckAssignmentCreationResult,
): Record<string, unknown> {
  const requestId = String(creation.requestId ?? '');
  const workspaceRoot =
    typeof creation.workspaceRoot === 'string' ? creation.workspaceRoot : 'this folder';
  return {
    requestId,
    status: 'pending',
    workspaceRoot: creation.workspaceRoot,
    expiresAt: creation.expiresAt,
    channel: 'browser',
    message:
      `Approval dismissed with no decision. Request ${requestId} for folder "${workspaceRoot}" ` +
      `is still pending and the session stays unassigned. Pick a deck ("This session only" or ` +
      `"This workspace by default") or decline it from the browser approval page or the menubar pending-requests inbox.`,
  };
}

/**
 * Present one pending deck-assignment request through the host-native form.
 * Never throws for elicitation-level failures: those degrade to the
 * browser-fallback payload. Approval API rejections propagate so the
 * caller surfaces them without retrying.
 */
export async function presentDeckAssignmentApproval(deps: {
  creation: DeckAssignmentCreationResult;
  decks: DeckAssignmentDeckOption[];
  supportsFormElicitation: () => boolean;
  elicitForm: ElicitFormFn;
  submitApproval: SubmitAssignmentApprovalFn;
}): Promise<DeckAssignmentApprovalOutcome> {
  const { creation, decks } = deps;

  let supported = false;
  try {
    supported = deps.supportsFormElicitation();
  } catch {
    supported = false;
  }
  if (!supported || decks.length === 0) {
    return { handled: 'fallback', payload: creation };
  }

  let result: ElicitationResult;
  try {
    result = await deps.elicitForm(buildDeckAssignmentElicitationInput(creation, decks));
  } catch {
    return { handled: 'fallback', payload: creation };
  }
  if (!result || typeof result !== 'object' || typeof result.action !== 'string') {
    return { handled: 'fallback', payload: creation };
  }

  const requestId = String(creation.requestId ?? '');
  if (result.action === 'cancel') {
    return { handled: 'pending-recovery', payload: buildAssignmentCancelRecoveryPayload(creation) };
  }

  const submit = async (
    decision: DeckAssignmentApprovalScope,
    deckId?: string,
  ): Promise<DeckAssignmentApprovalOutcome> => {
    try {
      const payload = await deps.submitApproval({ requestId, deckId, decision });
      return { handled: 'resolved', payload };
    } catch (error) {
      if (error instanceof DeckAssignmentApprovalCommitUnavailable) {
        return { handled: 'fallback', payload: creation };
      }
      throw error;
    }
  };

  if (result.action === 'decline') {
    return submit('decline');
  }

  if (result.action !== 'accept') {
    return { handled: 'fallback', payload: creation };
  }
  const content = result.content;
  if (!content || typeof content !== 'object') {
    return { handled: 'fallback', payload: creation };
  }
  if (typeof content.requestId !== 'string' || content.requestId !== requestId) {
    return { handled: 'fallback', payload: creation };
  }
  if (!isDeckSwitchApprovalScope(content.scope)) {
    return { handled: 'fallback', payload: creation };
  }
  const scope = content.scope as DeckAssignmentApprovalScope;
  if (scope === 'decline') {
    return submit('decline');
  }
  if (typeof content.deckId !== 'string' || !decks.some((deck) => deck.id === content.deckId)) {
    return { handled: 'fallback', payload: creation };
  }
  return submit(scope, content.deckId);
}

/** The server holds no credential that the approval API accepts. */
export class DeckAssignmentApprovalCommitUnavailable extends Error {
  constructor(message = 'Deck-assignment approval commit unavailable: no server credential for the approval API') {
    super(message);
    this.name = 'DeckAssignmentApprovalCommitUnavailable';
  }
}

/**
 * Submit one elicited decision to the NOT-597 resolve endpoint. The MCP
 * server authenticates as a dashboard principal with the host's admin
 * secret; the endpoint still enforces pending status and deck existence.
 */
export async function submitDeckAssignmentApprovalViaBackend(deps: {
  callBackendAPI: (endpoint: string, init?: RequestInit) => Promise<any>;
  requestId: string;
  deckId?: string;
  decision: DeckAssignmentApprovalScope;
  readSecret?: () => Promise<string | null>;
}): Promise<unknown> {
  const secret = await (deps.readSecret ?? readAdminSecretFromEnvOrFile)();
  if (!secret) {
    throw new DeckAssignmentApprovalCommitUnavailable();
  }
  return deps.callBackendAPI(
    `/api/trusted-session/deck-assignment/${encodeURIComponent(deps.requestId)}/resolve`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(
        deps.decision === 'decline'
          ? { decision: deps.decision }
          : { deckId: deps.deckId, decision: deps.decision },
      ),
    },
  );
}

/**
 * Fetch the deck list for the elicitation picker as a dashboard
 * principal (admin secret). Returns null when the server holds no
 * credential or the fetch fails — the caller then keeps the browser
 * fallback, where the dashboard lists decks itself.
 */
export async function fetchDecksForAssignmentElicitation(deps: {
  callBackendAPI: (endpoint: string, init?: RequestInit) => Promise<any>;
  readSecret?: () => Promise<string | null>;
}): Promise<DeckAssignmentDeckOption[] | null> {
  const secret = await (deps.readSecret ?? readAdminSecretFromEnvOrFile)();
  if (!secret) {
    return null;
  }
  try {
    const decks = await deps.callBackendAPI('/api/decks', {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!Array.isArray(decks)) {
      return null;
    }
    const options = (decks as Array<{ id?: unknown; name?: unknown }>)
      .filter((deck) => typeof deck.id === 'string' && typeof deck.name === 'string')
      .map((deck) => ({ id: deck.id as string, name: deck.name as string }));
    return options.length > 0 ? options : null;
  } catch {
    return null;
  }
}

export { DECK_SWITCH_ELICITATION_TIMEOUT_MS };
