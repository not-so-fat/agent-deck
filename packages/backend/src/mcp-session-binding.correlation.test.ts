import { describe, expect, it } from 'vitest';

import {
  AGENT_DECK_CORRELATION_HEADER,
  AGENT_DECK_SESSION_HEADER,
} from '@agent-deck/shared';

import { McpSessionBindingStore } from './mcp-session-binding';

const CORRELATION = '123e4567-e89b-42d3-a456-426614174000';
const OTHER = 'dealer-run_other001';

function launch(store: McpSessionBindingStore, session: string, deck: string) {
  store.setLaunchSession(session, {
    runtimeSessionId: `ses_${session}`,
    deckId: deck,
    workspaceRoot: '/tmp/work',
    mode: 'normal',
  });
}

describe('McpSessionBindingStore correlation id (NOT-304)', () => {
  it('adopts the first valid value and ignores later changes', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');

    expect(store.setCorrelationId('s1', CORRELATION)).toBe(CORRELATION);
    expect(store.getCorrelationId('s1')).toBe(CORRELATION);
    // A later header change — valid or not — never moves the session value.
    expect(store.setCorrelationId('s1', OTHER)).toBe(CORRELATION);
    expect(store.setCorrelationId('s1', 'not-so-fat/agent_deck')).toBe(CORRELATION);
    expect(store.getCorrelationId('s1')).toBe(CORRELATION);
  });

  it('drops invalid values without storing anything', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');

    expect(store.setCorrelationId('s1', 'Fix the login bug')).toBeUndefined();
    expect(store.setCorrelationId('s1', '')).toBeUndefined();
    expect(store.setCorrelationId('s1', null)).toBeUndefined();
    expect(store.getCorrelationId('s1')).toBeUndefined();
    // A later valid value can still attach when nothing stuck yet.
    expect(store.setCorrelationId('s1', CORRELATION)).toBe(CORRELATION);
  });

  it('keeps sessions independent', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');
    launch(store, 's2', 'deck-a');

    store.setCorrelationId('s1', CORRELATION);
    expect(store.getCorrelationId('s2')).toBeUndefined();
    store.setCorrelationId('s2', OTHER);
    expect(store.getCorrelationId('s1')).toBe(CORRELATION);
  });

  it('forwards the correlation header alongside the session header', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');
    store.setCorrelationId('s1', CORRELATION);

    const headers = store.getAgentHeaders('s1');
    expect(headers[AGENT_DECK_SESSION_HEADER]).toBe('ses_s1');
    expect(headers[AGENT_DECK_CORRELATION_HEADER]).toBe(CORRELATION);
  });

  it('omits the correlation header when the session has none', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');

    const headers = store.getAgentHeaders('s1');
    expect(headers[AGENT_DECK_SESSION_HEADER]).toBe('ses_s1');
    expect(headers[AGENT_DECK_CORRELATION_HEADER]).toBeUndefined();
  });

  it('reports the correlation id in the binding snapshot without touching authority', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');
    store.setCorrelationId('s1', CORRELATION);

    const snapshot = store.getBinding('s1');
    expect(snapshot.correlationId).toBe(CORRELATION);
    // Deck, workspace, mode, source, and trusted identity are unchanged.
    expect(snapshot.deckId).toBe('deck-a');
    expect(snapshot.workspaceRoot).toBe('/tmp/work');
    expect(snapshot.mode).toBe('normal');
    expect(snapshot.deckSource).toBe('launch');
    expect(snapshot.runtimeSessionId).toBe('ses_s1');
  });

  it('refreshing the trusted session preserves the correlation id', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');
    store.setCorrelationId('s1', CORRELATION);

    store.setTrustedSession('s1', {
      runtimeSessionId: 'ses_s1',
      deckId: 'deck-a',
      workspaceRoot: '/tmp/work',
      mode: 'agent-admin',
    });
    expect(store.getCorrelationId('s1')).toBe(CORRELATION);
    expect(store.getMode('s1')).toBe('agent-admin');
  });

  it('clearSession and markUnassigned drop the correlation id', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');
    launch(store, 's2', 'deck-a');
    store.setCorrelationId('s1', CORRELATION);
    store.setCorrelationId('s2', OTHER);

    store.clearSession('s1');
    expect(store.getCorrelationId('s1')).toBeUndefined();
    expect(store.getBinding('s1').correlationId).toBeUndefined();

    store.markUnassigned('s2');
    expect(store.getCorrelationId('s2')).toBeUndefined();
  });
});
