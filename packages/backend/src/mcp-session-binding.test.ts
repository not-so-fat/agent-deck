import { describe, expect, it } from 'vitest';
import {
  AGENT_DECK_SESSION_HEADER,
  AGENT_DECK_WORKSPACE_HEADER,
} from '@agent-deck/shared';
import {
  McpSessionBindingStore,
  resolveBindingActiveSource,
  resolveDeckBindingSource,
} from './mcp-session-binding';

describe('McpSessionBindingStore', () => {
  it('stores independent workspace and deck overrides per session', () => {
    const store = new McpSessionBindingStore();
    store.setWorkspace('session-a', '/Users/me');
    store.setDeckId('session-a', '11111111-1111-4111-8111-111111111111');
    store.setWorkspace('session-b', '/Users/me');
    store.setDeckId('session-b', '22222222-2222-4222-8222-222222222222');

    expect(store.getDeckOverride('session-a')).toBe('11111111-1111-4111-8111-111111111111');
    expect(store.getDeckOverride('session-b')).toBe('22222222-2222-4222-8222-222222222222');
    expect(store.getWorkspace('session-a')).toBe('/Users/me');
    expect(store.getWorkspace('session-b')).toBe('/Users/me');
  });

  it('sends runtime session header when trusted session is set', () => {
    const store = new McpSessionBindingStore();
    store.setTrustedSession('s1', {
      runtimeSessionId: 'ses_test',
      deckId: '11111111-1111-4111-8111-111111111111',
      workspaceRoot: '/Users/me',
      mode: 'normal',
    });

    const headers = store.getAgentHeaders('s1');
    expect(headers[AGENT_DECK_WORKSPACE_HEADER]).toBe('/Users/me');
    expect(headers[AGENT_DECK_SESSION_HEADER]).toBe('ses_test');
  });

  it('omits session header after clearSession', () => {
    const store = new McpSessionBindingStore();
    store.setTrustedSession('s1', {
      runtimeSessionId: 'ses_test',
      deckId: '11111111-1111-4111-8111-111111111111',
      workspaceRoot: '/Users/me',
    });
    store.clearSession('s1');

    const headers = store.getAgentHeaders('s1');
    expect(headers[AGENT_DECK_WORKSPACE_HEADER]).toBeUndefined();
    expect(headers[AGENT_DECK_SESSION_HEADER]).toBeUndefined();
  });

  it('uses env defaults for the default session id', () => {
    const store = new McpSessionBindingStore({
      workspace: '/env/root',
      deckId: '33333333-3333-4333-8333-333333333333',
    });

    expect(store.getBinding('default')).toEqual({
      workspaceRoot: '/env/root',
      deckId: '33333333-3333-4333-8333-333333333333',
      deckSource: 'env',
    });
  });

  it('clears session state on disconnect', () => {
    const store = new McpSessionBindingStore();
    store.setWorkspace('s1', '/Users/me');
    store.setDeckId('s1', '11111111-1111-4111-8111-111111111111');
    store.clearSession('s1');

    expect(store.getWorkspace('s1')).toBeUndefined();
    expect(store.getDeckOverride('s1')).toBeUndefined();
  });

  it('setTrustedSession keeps the launch flag (NOT-105)', () => {
    const store = new McpSessionBindingStore();
    store.setLaunchSession('s1', {
      runtimeSessionId: 'ses_launch',
      deckId: '11111111-1111-4111-8111-111111111111',
    });
    expect(store.isLaunchSession('s1')).toBe(true);
    expect(store.getBinding('s1').deckSource).toBe('launch');

    store.setTrustedSession('s1', {
      runtimeSessionId: 'ses_launch',
      deckId: '11111111-1111-4111-8111-111111111111',
      workspaceRoot: '/tmp/work',
    });
    expect(store.isLaunchSession('s1')).toBe(true);
    expect(store.getBinding('s1').deckSource).toBe('launch');
  });

  it('clearSession removes the launch flag', () => {
    const store = new McpSessionBindingStore();
    store.setLaunchSession('s1', {
      runtimeSessionId: 'ses_launch',
      deckId: '11111111-1111-4111-8111-111111111111',
    });
    store.clearSession('s1');
    expect(store.isLaunchSession('s1')).toBe(false);
  });
});

describe('McpSessionBindingStore playbook pin (NOT-537)', () => {
  const PIN = 'pb_baseline=123e4567-e89b-42d3-a456-426614174000';
  const OTHER = 'pb_other=223e4567-e89b-42d3-a456-426614174001';

  function launch(store: McpSessionBindingStore, session: string, deck: string) {
    store.setLaunchSession(session, {
      runtimeSessionId: `ses_${session}`,
      deckId: deck,
      workspaceRoot: '/tmp/work',
      mode: 'normal',
    });
  }

  it('adopts the first valid pin and ignores later changes', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');

    expect(store.setPlaybookPin('s1', PIN)).toEqual({
      playbookId: 'pb_baseline',
      versionId: '123e4567-e89b-42d3-a456-426614174000',
    });
    // A second request sending a different value never moves the session pin.
    expect(store.setPlaybookPin('s1', OTHER)).toEqual({
      playbookId: 'pb_baseline',
      versionId: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(store.setPlaybookPin('s1', 'not a pin')).toEqual({
      playbookId: 'pb_baseline',
      versionId: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(store.getPlaybookPin('s1')).toEqual({
      playbookId: 'pb_baseline',
      versionId: '123e4567-e89b-42d3-a456-426614174000',
    });
  });

  it('drops invalid pins without storing anything', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');

    expect(store.setPlaybookPin('s1', 'Fix the login bug')).toBeUndefined();
    expect(store.setPlaybookPin('s1', 'pb_baseline=not-a-uuid')).toBeUndefined();
    expect(store.setPlaybookPin('s1', '')).toBeUndefined();
    expect(store.getPlaybookPin('s1')).toBeUndefined();
    // A later valid value can still attach when nothing stuck yet.
    expect(store.setPlaybookPin('s1', PIN)).toEqual({
      playbookId: 'pb_baseline',
      versionId: '123e4567-e89b-42d3-a456-426614174000',
    });
  });

  it('keeps sessions independent and reports the pin in the snapshot', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');
    launch(store, 's2', 'deck-a');

    store.setPlaybookPin('s1', PIN);
    expect(store.getPlaybookPin('s2')).toBeUndefined();

    const snapshot = store.getBinding('s1');
    expect(snapshot.playbookPin).toEqual({
      playbookId: 'pb_baseline',
      versionId: '123e4567-e89b-42d3-a456-426614174000',
    });
    // Deck, workspace, mode, source, and trusted identity are unchanged.
    expect(snapshot.deckId).toBe('deck-a');
    expect(snapshot.deckSource).toBe('launch');
  });

  it('clearSession and markUnassigned drop the pin', () => {
    const store = new McpSessionBindingStore();
    launch(store, 's1', 'deck-a');
    launch(store, 's2', 'deck-a');
    store.setPlaybookPin('s1', PIN);
    store.setPlaybookPin('s2', OTHER);

    store.clearSession('s1');
    expect(store.getPlaybookPin('s1')).toBeUndefined();

    store.markUnassigned('s2');
    expect(store.getPlaybookPin('s2')).toBeUndefined();
  });
});

describe('resolveBindingActiveSource (NOT-211)', () => {
  const deckA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const deckB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('returns session when the active deck differs from the workspace default', () => {
    expect(
      resolveBindingActiveSource({
        isLaunchSession: false,
        activeDeckId: deckB,
        workspaceDefaultDeckId: deckA,
      }),
    ).toBe('session');
  });

  it('returns workspace when the active deck equals the workspace default', () => {
    expect(
      resolveBindingActiveSource({
        isLaunchSession: false,
        activeDeckId: deckA,
        workspaceDefaultDeckId: deckA,
      }),
    ).toBe('workspace');
  });

  it('returns workspace when active is unset but a default exists', () => {
    expect(
      resolveBindingActiveSource({
        isLaunchSession: false,
        activeDeckId: null,
        workspaceDefaultDeckId: deckA,
      }),
    ).toBe('workspace');
  });

  it('prefers the default comparison over the launch flag', () => {
    expect(
      resolveBindingActiveSource({
        isLaunchSession: true,
        activeDeckId: deckB,
        workspaceDefaultDeckId: deckA,
      }),
    ).toBe('session');
    expect(
      resolveBindingActiveSource({
        isLaunchSession: true,
        activeDeckId: deckA,
        workspaceDefaultDeckId: deckA,
      }),
    ).toBe('workspace');
  });

  it('returns launch for a launch-selected deck with no assignment file', () => {
    expect(
      resolveBindingActiveSource({
        isLaunchSession: true,
        activeDeckId: deckB,
        workspaceDefaultDeckId: null,
      }),
    ).toBe('launch');
  });

  it('returns session for a bound deck with no saved default outside launch', () => {
    expect(
      resolveBindingActiveSource({
        isLaunchSession: false,
        activeDeckId: deckB,
        workspaceDefaultDeckId: null,
      }),
    ).toBe('session');
  });

  it('returns workspace when nothing is bound and no default exists', () => {
    expect(
      resolveBindingActiveSource({
        isLaunchSession: false,
        activeDeckId: null,
        workspaceDefaultDeckId: null,
      }),
    ).toBe('workspace');
  });
});

describe('resolveDeckBindingSource', () => {
  it('returns session_override when set on binding', () => {
    expect(
      resolveDeckBindingSource({
        deckId: '11111111-1111-4111-8111-111111111111',
        deckSource: 'session_override',
      }),
    ).toBe('session_override');
  });

  it('returns env when binding comes from env default', () => {
    expect(
      resolveDeckBindingSource({
        deckId: '22222222-2222-4222-8222-222222222222',
        deckSource: 'env',
      }),
    ).toBe('env');
  });

  it('returns launch when binding is a launch session', () => {
    expect(
      resolveDeckBindingSource({
        deckId: '11111111-1111-4111-8111-111111111111',
        deckSource: 'launch',
      }),
    ).toBe('launch');
  });
});

describe('launch-bound execution workspace (NOT-539)', () => {
  const launch = { runtimeSessionId: 'ses_rt', deckId: 'deck-a' };

  it('adopts the first launch value and never moves with bind_workspace or later headers', () => {
    const store = new McpSessionBindingStore();
    store.setLaunchSession('mcp-1', { ...launch, workspaceRoot: '/work/role-a' });
    expect(store.setExecutionWorkspace('mcp-1', '/work/role-a')).toBe('/work/role-a');

    store.setWorkspace('mcp-1', '/somewhere/else');
    store.setTrustedSession('mcp-1', { ...launch, workspaceRoot: '/somewhere/else' });
    expect(store.setExecutionWorkspace('mcp-1', '/work/role-b')).toBe('/work/role-a');
    expect(store.getExecutionWorkspace('mcp-1')).toBe('/work/role-a');
    expect(store.getBinding('mcp-1').workspaceRoot).toBe('/somewhere/else');
  });

  it('is absent for non-launch, remote-grant, relative, and cleared sessions', () => {
    const store = new McpSessionBindingStore({ workspace: '/env/default' });
    store.setTrustedSession('plain', launch);
    expect(store.setExecutionWorkspace('plain', '/work/a')).toBeUndefined();

    store.setGrantSession('grant', {
      ...launch,
      grantId: 'ag_1',
      label: 'remote',
      defaultDeck: 'deck-a',
      allowedDecks: ['deck-a'],
    });
    expect(store.setExecutionWorkspace('grant', '/work/a')).toBeUndefined();

    store.setLaunchSession('relative', launch);
    expect(store.setExecutionWorkspace('relative', 'work/a')).toBeUndefined();
    expect(store.setExecutionWorkspace('relative', undefined)).toBeUndefined();

    store.setLaunchSession('cleared', launch);
    store.setExecutionWorkspace('cleared', '/work/a');
    store.clearSession('cleared');
    expect(store.getExecutionWorkspace('cleared')).toBeUndefined();
  });
});
