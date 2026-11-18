import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { BackendApiError } from '../lib/backend-api-error';
import { DECK_SWITCH_REQUEST_TTL_MS } from '../trusted-session/store';
import {
  buildTimedOutRecoveryPayload,
  DECK_SWITCH_ELICITATION_TIMEOUT_MS,
  deckSwitchFormLifetimeMs,
  presentDeckSwitchApproval,
  type DeckSwitchCreationResult,
  type ElicitationResult,
  type ElicitFormOptions,
  type SubmitApprovalFn,
} from './elicitation';

describe('DECK_SWITCH_ELICITATION_TIMEOUT_MS (NOT-636)', () => {
  it('gives the human 5 minutes to answer the switch_deck approval form', () => {
    expect(DECK_SWITCH_ELICITATION_TIMEOUT_MS).toBe(300_000);
  });
});

const APPROVAL_URL = 'https://deck.example.test/deck-switch/approve?request=req_1&session=rs_owner';
const WAIT_MS = 50;

const CREATION: DeckSwitchCreationResult = {
  requestId: 'req_1',
  status: 'pending',
  expiresAt: '2026-09-21T00:30:00.000Z',
  currentDeckId: 'deck_a',
  currentDeckName: 'alpha',
  requestedDeckId: 'deck_b',
  requestedDeckName: 'beta',
  approvalUrl: APPROVAL_URL,
};

type SubmitArgs = Parameters<SubmitApprovalFn>[0];

/**
 * An elicitForm whose answer the test controls: the form stays open until
 * `answer` or `fail` is called, as when the human leaves it on screen.
 */
function deferredForm() {
  let resolve!: (result: ElicitationResult) => void;
  let reject!: (error: unknown) => void;
  const pending = new Promise<ElicitationResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const calls: Array<{ input: unknown; options?: ElicitFormOptions }> = [];
  return {
    calls,
    elicitForm: (input: { message: string; requestedSchema: Record<string, unknown> }, options?: ElicitFormOptions) => {
      calls.push({ input, options });
      return pending;
    },
    answer: (result: ElicitationResult) => resolve(result),
    fail: (error: unknown) => reject(error),
  };
}

function timedOutDeps(overrides?: {
  submit?: (args: SubmitArgs) => Promise<unknown>;
  creation?: DeckSwitchCreationResult;
}) {
  const form = deferredForm();
  const submitCalls: SubmitArgs[] = [];
  const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
  let lateAnswer: Promise<void> | undefined;
  const deps = {
    creation: overrides?.creation ?? CREATION,
    runtimeSessionId: 'rs_owner',
    supportsFormElicitation: () => true,
    elicitForm: form.elicitForm,
    submitApproval: async (args: SubmitArgs) => {
      submitCalls.push(args);
      if (overrides?.submit) {
        return overrides.submit(args);
      }
      return { requestId: args.requestId, decision: args.decision, status: 'consumed' };
    },
    toolCallWaitMs: WAIT_MS,
    formLifetimeMs: 60_000,
    log: (message: string, detail?: Record<string, unknown>) => {
      logs.push({ message, detail });
    },
    onLateAnswer: (task: Promise<void>) => {
      lateAnswer = task;
    },
  };
  return {
    deps,
    form,
    submitCalls,
    logs,
    lateAnswer: () => {
      if (!lateAnswer) {
        throw new Error('no late-answer task was started');
      }
      return lateAnswer;
    },
  };
}

describe('timed-out pending outcome (NOT-638)', () => {
  it('returns the timed-out pending payload after the tool-call wait while the form is still open', async () => {
    const { deps, form, submitCalls } = timedOutDeps();
    const started = Date.now();

    const outcome = await presentDeckSwitchApproval(deps);

    expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 5);
    expect(outcome.handled).toBe('pending-recovery');
    expect(outcome.payload).toMatchObject({
      status: 'pending',
      requestId: 'req_1',
      expiresAt: CREATION.expiresAt,
      approvalUrl: APPROVAL_URL,
      currentDeckName: 'alpha',
      requestedDeckName: 'beta',
    });
    const message = String((outcome.payload as { message: string }).message);
    expect(message).toContain('no answer within');
    expect(message).toContain(APPROVAL_URL);
    expect(message).toContain('get_session_context');
    expect(message).toContain('still open in their client');
    expect(message).toContain('menubar');
    expect(submitCalls).toHaveLength(0);
    // The form stays open with the form lifetime and a cancel signal.
    expect(form.calls).toHaveLength(1);
    expect(form.calls[0].options?.timeoutMs).toBe(60_000);
    expect(form.calls[0].options?.signal).toBeInstanceOf(AbortSignal);
    expect(form.calls[0].options?.signal?.aborted).toBe(false);
  });

  it('timed-out pending message names the 5-minute wait and the expiry in production form', () => {
    const payload = buildTimedOutRecoveryPayload(CREATION);
    expect(payload.message).toBe(
      'The approval form for this switch_deck call got no answer within 5 minutes, so this call returns pending. ' +
        'Request req_1 is still pending and the active deck ("alpha") is unchanged until 2026-09-21T00:30:00.000Z. ' +
        'The human can still approve the switch to "beta" by answering the form if it is still open in their client, ' +
        `at ${APPROVAL_URL}, or from the menubar pending-requests inbox. After approval, call get_session_context.`,
    );
  });

  it('timed-out pending payload without a creation link stays link-free', () => {
    const { approvalUrl: _omit, ...legacy } = CREATION;
    const payload = buildTimedOutRecoveryPayload(legacy);
    expect(payload).not.toHaveProperty('approvalUrl');
    expect(String(payload.message)).toContain('browser approval page');
    expect(JSON.stringify(payload)).not.toMatch(/https?:\/\//);
  });
});

describe('form lifetime (NOT-638)', () => {
  const now = Date.parse('2026-11-18T00:00:00.000Z');

  it('is the time left until expiresAt', () => {
    const expiresAt = new Date(now + 20 * 60_000).toISOString();
    expect(deckSwitchFormLifetimeMs(expiresAt, DECK_SWITCH_ELICITATION_TIMEOUT_MS, now)).toBe(20 * 60_000);
  });

  it('is never shorter than the tool-call wait', () => {
    const expiresAt = new Date(now + 1_000).toISOString();
    expect(deckSwitchFormLifetimeMs(expiresAt, DECK_SWITCH_ELICITATION_TIMEOUT_MS, now)).toBe(
      DECK_SWITCH_ELICITATION_TIMEOUT_MS,
    );
    expect(deckSwitchFormLifetimeMs('2020-01-01T00:00:00.000Z', WAIT_MS, now)).toBe(WAIT_MS);
  });

  it('is capped at the request TTL and uses it for an unparseable expiresAt', () => {
    const expiresAt = new Date(now + 2 * DECK_SWITCH_REQUEST_TTL_MS).toISOString();
    expect(deckSwitchFormLifetimeMs(expiresAt, DECK_SWITCH_ELICITATION_TIMEOUT_MS, now)).toBe(
      DECK_SWITCH_REQUEST_TTL_MS,
    );
    expect(deckSwitchFormLifetimeMs(undefined, DECK_SWITCH_ELICITATION_TIMEOUT_MS, now)).toBe(
      DECK_SWITCH_REQUEST_TTL_MS,
    );
    expect(deckSwitchFormLifetimeMs('not a date', DECK_SWITCH_ELICITATION_TIMEOUT_MS, now)).toBe(
      DECK_SWITCH_REQUEST_TTL_MS,
    );
  });

  it('is derived from the creation expiresAt when not overridden', async () => {
    const form = deferredForm();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const outcome = await presentDeckSwitchApproval({
      creation: { ...CREATION, expiresAt },
      runtimeSessionId: 'rs_owner',
      supportsFormElicitation: () => true,
      elicitForm: form.elicitForm,
      submitApproval: async () => ({}),
      toolCallWaitMs: WAIT_MS,
      log: () => {},
    });
    expect(outcome.handled).toBe('pending-recovery');
    const lifetime = form.calls[0].options?.timeoutMs ?? 0;
    expect(lifetime).toBeGreaterThan(10 * 60_000 - 5_000);
    expect(lifetime).toBeLessThanOrEqual(10 * 60_000);
    form.answer({ action: 'cancel' });
  });

  it('aborts the signal when the form lifetime ends unanswered', async () => {
    const form = deferredForm();
    await presentDeckSwitchApproval({
      creation: CREATION,
      runtimeSessionId: 'rs_owner',
      supportsFormElicitation: () => true,
      elicitForm: form.elicitForm,
      submitApproval: async () => ({}),
      toolCallWaitMs: WAIT_MS,
      formLifetimeMs: WAIT_MS * 2,
      log: () => {},
    });
    const signal = form.calls[0].options?.signal;
    expect(signal?.aborted).toBe(false);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 1_000 });
  });

  /** An elicitForm that rejects when its signal aborts, like the SDK does. */
  function abortRejectingForm() {
    const calls: Array<{ options?: ElicitFormOptions }> = [];
    return {
      calls,
      elicitForm: (_input: unknown, options?: ElicitFormOptions) => {
        calls.push({ options });
        return new Promise<ElicitationResult>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        });
      },
    };
  }

  it.each([
    ['equal to the tool-call wait', WAIT_MS],
    ['shorter than the tool-call wait', WAIT_MS / 5],
  ])(
    'returns the timed-out pending payload, not the raw fallback, when the form lifetime is %s',
    async (_label, formLifetimeMs) => {
      const form = abortRejectingForm();
      const submitCalls: unknown[] = [];
      const outcome = await presentDeckSwitchApproval({
        creation: CREATION,
        runtimeSessionId: 'rs_owner',
        supportsFormElicitation: () => true,
        elicitForm: form.elicitForm,
        submitApproval: async (args) => {
          submitCalls.push(args);
          return {};
        },
        toolCallWaitMs: WAIT_MS,
        formLifetimeMs,
        log: () => {},
      });
      expect(outcome.handled).toBe('pending-recovery');
      expect(outcome.payload).toMatchObject({ status: 'pending', requestId: 'req_1', approvalUrl: APPROVAL_URL });
      expect(String((outcome.payload as { message: string }).message)).toContain('no answer within');
      expect(form.calls[0].options?.timeoutMs).toBe(formLifetimeMs);
      expect(submitCalls).toHaveLength(0);
    },
  );

  it('returns the timed-out pending payload when expiresAt is closer than the wait (derived equal lifetime)', async () => {
    const form = abortRejectingForm();
    const outcome = await presentDeckSwitchApproval({
      // A reused pending request that expires before the wait would end.
      creation: { ...CREATION, expiresAt: new Date(Date.now() + 5).toISOString() },
      runtimeSessionId: 'rs_owner',
      supportsFormElicitation: () => true,
      elicitForm: form.elicitForm,
      submitApproval: async () => ({}),
      toolCallWaitMs: WAIT_MS,
      log: () => {},
    });
    expect(form.calls[0].options?.timeoutMs).toBe(WAIT_MS);
    expect(outcome.handled).toBe('pending-recovery');
    expect(String((outcome.payload as { message: string }).message)).toContain('no answer within');
  });

  it('never aborts the signal of a form answered in time', async () => {
    const form = deferredForm();
    const pending = presentDeckSwitchApproval({
      creation: CREATION,
      runtimeSessionId: 'rs_owner',
      supportsFormElicitation: () => true,
      elicitForm: form.elicitForm,
      submitApproval: async () => ({ status: 'consumed' }),
      toolCallWaitMs: WAIT_MS * 4,
      formLifetimeMs: WAIT_MS * 4,
      log: () => {},
    });
    form.answer({ action: 'accept', content: { requestId: 'req_1', scope: 'session' } });
    expect((await pending).handled).toBe('resolved');
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS * 6));
    expect(form.calls[0].options?.signal?.aborted).toBe(false);
  });
});

describe('late answers after the timed-out outcome (NOT-638)', () => {
  it.each([
    ['accept session', { action: 'accept', content: { requestId: 'req_1', scope: 'session' } }, 'session'],
    [
      'accept workspace-default',
      { action: 'accept', content: { requestId: 'req_1', scope: 'workspace-default' } },
      'workspace-default',
    ],
    ['accept decline scope', { action: 'accept', content: { requestId: 'req_1', scope: 'decline' } }, 'decline'],
    ['host-level decline', { action: 'decline' }, 'decline'],
  ] as const)('late %s submits exactly once with the pinned request', async (_label, answer, decision) => {
    const { deps, form, submitCalls, lateAnswer } = timedOutDeps();

    const outcome = await presentDeckSwitchApproval(deps);
    expect(outcome.handled).toBe('pending-recovery');
    expect(submitCalls).toHaveLength(0);

    form.answer(answer as ElicitationResult);
    await lateAnswer();

    expect(submitCalls).toEqual([{ requestId: 'req_1', runtimeSessionId: 'rs_owner', decision }]);
  });

  it.each([
    ['cancel', { action: 'cancel' }],
    ['mismatched request id', { action: 'accept', content: { requestId: 'req_other', scope: 'session' } }],
    ['missing request id', { action: 'accept', content: { scope: 'session' } }],
    ['invalid scope', { action: 'accept', content: { requestId: 'req_1', scope: 'approve' } }],
    ['missing content', { action: 'accept' }],
    ['unknown action', { action: 'submit' }],
  ])('late %s submits nothing', async (_label, answer) => {
    const { deps, form, submitCalls, lateAnswer, logs } = timedOutDeps();

    await presentDeckSwitchApproval(deps);
    form.answer(answer as ElicitationResult);
    await lateAnswer();

    expect(submitCalls).toHaveLength(0);
    expect(logs).toHaveLength(1);
  });
});

describe('late answers that cannot be applied (NOT-638)', () => {
  const unhandled = vi.fn();

  beforeEach(() => {
    unhandled.mockReset();
    process.on('unhandledRejection', unhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', unhandled);
  });

  async function settleTurns(): Promise<void> {
    // Let any stray rejection reach the unhandledRejection hook.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it.each([
    ['409 already resolved', new BackendApiError('Deck-switch request already resolved', 409, 'DECK_SWITCH_CONSUMED')],
    ['expired', new BackendApiError('Deck-switch request expired', 410, 'DECK_SWITCH_EXPIRED')],
    ['session invalid', new BackendApiError('Runtime session absent or expired', 401, 'SESSION_INVALID')],
  ])('a late answer whose submit rejects (%s) is logged and dropped', async (_label, error) => {
    const { deps, form, submitCalls, lateAnswer, logs } = timedOutDeps({
      submit: async () => {
        throw error;
      },
    });

    await presentDeckSwitchApproval(deps);
    form.answer({ action: 'accept', content: { requestId: 'req_1', scope: 'session' } });
    await expect(lateAnswer()).resolves.toBeUndefined();
    await settleTurns();

    expect(submitCalls).toHaveLength(1);
    expect(logs.at(-1)?.message).toContain('could not be applied');
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('a late elicitation that rejects with ConnectionClosed is logged and dropped', async () => {
    const { deps, form, submitCalls, lateAnswer, logs } = timedOutDeps();

    await presentDeckSwitchApproval(deps);
    form.fail(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'));
    await expect(lateAnswer()).resolves.toBeUndefined();
    await settleTurns();

    expect(submitCalls).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0].detail).toMatchObject({ requestId: 'req_1', code: ErrorCode.ConnectionClosed });
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('a late answer with a throwing logger still never rejects', async () => {
    const { deps, form, lateAnswer } = timedOutDeps({
      submit: async () => {
        throw new BackendApiError('Deck-switch request already resolved', 409);
      },
    });
    deps.log = () => {
      throw new Error('logger down');
    };

    await presentDeckSwitchApproval(deps);
    form.answer({ action: 'accept', content: { requestId: 'req_1', scope: 'session' } });
    await expect(lateAnswer()).resolves.toBeUndefined();
    await settleTurns();

    expect(unhandled).not.toHaveBeenCalled();
  });

  it('without an onLateAnswer hook a failing late answer still produces no unhandled rejection', async () => {
    const { deps, form } = timedOutDeps({
      submit: async () => {
        throw new BackendApiError('Deck-switch request expired', 410);
      },
    });
    const { onLateAnswer: _omit, ...withoutHook } = deps;

    await presentDeckSwitchApproval(withoutHook);
    form.answer({ action: 'accept', content: { requestId: 'req_1', scope: 'session' } });
    await settleTurns();

    expect(unhandled).not.toHaveBeenCalled();
  });
});
