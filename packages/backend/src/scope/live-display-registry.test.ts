import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_DISPLAY_STALE_MS,
  LiveDisplayRegistry,
  resolveLiveDisplayStaleMs,
} from './live-display-registry';

/** NOT-309: these fixtures model live sessions, so they stay inside the stale bound. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe('LiveDisplayRegistry', () => {
  it('preserves workspaceRoot when a later upsert omits it (init race after bind)', () => {
    const registry = new LiveDisplayRegistry();
    const workspace = path.resolve('/repo/agent-dealer');

    registry.upsert({
      mcpSessionId: 'claude',
      workspaceRoot: workspace,
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'personal-dev',
      source: 'launch',
      cardCounts: { mcp: 2, credentials: 1, playbooks: 11 },
      updatedAt: minutesAgo(2),
    });

    // Late fire-and-forget register from MCP init — no folder on the body.
    registry.upsert({
      mcpSessionId: 'claude',
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'personal-dev',
      source: 'launch',
      cardCounts: { mcp: 2, credentials: 1, playbooks: 11 },
      updatedAt: minutesAgo(1),
    });

    const match = registry.resolveWorkspaceSessions(workspace);
    expect(match.kind).toBe('single');
    if (match.kind === 'single') {
      expect(match.entries[0].deckName).toBe('personal-dev');
    }
    expect(registry.list()[0].workspaceRoot).toBe(workspace);
  });

  it('returns both sessions in deterministic order instead of newest-wins', () => {
    const registry = new LiveDisplayRegistry();
    const workspace = path.resolve('/repo');

    registry.upsert({
      mcpSessionId: 'older',
      workspaceRoot: workspace,
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Older',
      source: 'session_override',
      cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
      updatedAt: minutesAgo(2),
    });
    registry.upsert({
      mcpSessionId: 'newer',
      workspaceRoot: workspace,
      deckId: '22222222-2222-4222-8222-222222222222',
      deckName: 'Newer',
      source: 'session_override',
      cardCounts: { mcp: 2, credentials: 0, playbooks: 0 },
      updatedAt: minutesAgo(1),
    });

    // NOT-296: no latest-updated guess — both matches come back in
    // deterministic mcpSessionId order for the caller to adjudicate.
    const match = registry.resolveWorkspaceSessions(workspace);
    expect(match.kind).toBe('multiple');
    if (match.kind === 'multiple') {
      expect(match.entries.map((entry) => entry.mcpSessionId)).toEqual(['newer', 'older']);
    }
  });

  it('lists a workspace-less (auto-bound) entry but never matches it to a folder', () => {
    const registry = new LiveDisplayRegistry();
    registry.upsert({
      mcpSessionId: 'auto',
      deckId: '33333333-3333-4333-8333-333333333333',
      deckName: 'Dev',
      source: 'session_override',
      cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
      updatedAt: minutesAgo(1),
    });

    // Appears in the dashboard list…
    expect(registry.list().map((e) => e.deckName)).toEqual(['Dev']);
    // …but has no folder, so the per-workspace statusline never picks it up.
    expect(registry.resolveWorkspaceSessions(path.resolve('/repo')).kind).toBe('none');
  });

  it('walks up to parent workspace binds', () => {
    const registry = new LiveDisplayRegistry();
    const workspace = path.resolve('/repo');

    registry.upsert({
      mcpSessionId: 'session-1',
      workspaceRoot: workspace,
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Root Deck',
      source: 'session_override',
      cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
      updatedAt: minutesAgo(1),
    });

    const match = registry.resolveWorkspaceSessions(path.join(workspace, 'packages', 'app'));
    expect(match.kind).toBe('single');
    if (match.kind === 'single') {
      expect(match.entries[0].deckName).toBe('Root Deck');
    }
  });

  it('removes entries when MCP session closes', () => {
    const registry = new LiveDisplayRegistry();
    const workspace = path.resolve('/repo');

    registry.upsert({
      mcpSessionId: 'session-1',
      workspaceRoot: workspace,
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Root Deck',
      source: 'session_override',
      cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
      updatedAt: minutesAgo(1),
    });
    registry.remove('session-1');

    expect(registry.resolveWorkspaceSessions(workspace)).toEqual({ kind: 'none', entries: [] });
  });

  it('assigns distinct badges and preserves a session badge across re-upsert', () => {
    const registry = new LiveDisplayRegistry();
    const base = {
      workspaceRoot: path.resolve('/repo'),
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Deck A',
      source: 'session_override' as const,
      cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
      updatedAt: minutesAgo(2),
    };

    const first = registry.upsert({ ...base, mcpSessionId: 'one' });
    const second = registry.upsert({ ...base, mcpSessionId: 'two' });
    expect(first.badge).not.toBe(second.badge);

    const switched = registry.upsert({
      ...base,
      mcpSessionId: 'one',
      deckName: 'Deck B',
      updatedAt: minutesAgo(1),
    });
    expect(switched.badge).toBe(first.badge);
    expect(switched.deckName).toBe('Deck B');
  });

  it('touch bumps lastActivityAt monotonically and ignores unknown sessions', () => {
    const registry = new LiveDisplayRegistry();
    const t0 = Date.now() - 10 * 60_000;
    const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();
    const entry = registry.upsert({
      mcpSessionId: 'one',
      workspaceRoot: path.resolve('/repo'),
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Deck A',
      source: 'session_override',
      cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
      updatedAt: iso(0),
    });
    expect(entry.lastActivityAt).toBe(iso(0));

    registry.touch('one', iso(5 * 60_000));
    registry.touch('one', iso(60_000));
    registry.touch('ghost', iso(5 * 60_000));
    expect(registry.list()[0].lastActivityAt).toBe(iso(5 * 60_000));
  });

  it('list sorts by lastActivityAt descending', () => {
    const registry = new LiveDisplayRegistry();
    const base = {
      workspaceRoot: path.resolve('/repo'),
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Deck',
      source: 'session_override' as const,
      cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
    };
    registry.upsert({ ...base, mcpSessionId: 'old', updatedAt: minutesAgo(2) });
    registry.upsert({ ...base, mcpSessionId: 'new', updatedAt: minutesAgo(1) });
    expect(registry.list().map((e) => e.mcpSessionId)).toEqual(['new', 'old']);
  });

  it('remove frees the badge for new sessions', () => {
    const registry = new LiveDisplayRegistry();
    const base = {
      workspaceRoot: path.resolve('/repo'),
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Deck',
      source: 'session_override' as const,
      cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
      updatedAt: minutesAgo(1),
    };
    const first = registry.upsert({ ...base, mcpSessionId: 'one' });
    registry.remove('one');
    const next = registry.upsert({ ...base, mcpSessionId: 'two' });
    expect(next.badge).toBe(first.badge);
  });
});

describe('LiveDisplayRegistry staleness bound (NOT-309)', () => {
  const STALE_MS = 60_000;
  const T0 = Date.parse('2026-09-15T12:00:00.000Z');
  let fakeNow: number;

  const fakeClock = () => fakeNow;
  const isoAt = (ms: number) => new Date(ms).toISOString();
  const withFakeClock = (staleMs: number = STALE_MS) =>
    new LiveDisplayRegistry({ nowMs: fakeClock, staleMs });

  const seed = (registry: LiveDisplayRegistry, workspace: string) => {
    const base = {
      workspaceRoot: workspace,
      source: 'launch' as const,
      cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
    };
    registry.upsert({
      ...base,
      mcpSessionId: 'live-a1',
      deckId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      deckName: 'Deck A',
      updatedAt: isoAt(T0),
    });
    registry.upsert({
      ...base,
      mcpSessionId: 'live-a2',
      deckId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      deckName: 'Deck A',
      updatedAt: isoAt(T0),
    });
    registry.upsert({
      ...base,
      mcpSessionId: 'dead-b',
      deckId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      deckName: 'Deck B',
      updatedAt: isoAt(T0 - STALE_MS - 1),
    });
  };

  beforeEach(() => {
    fakeNow = T0;
  });

  it('ignores a stale other-deck entry in resolveWorkspaceSessions', () => {
    const registry = withFakeClock();
    const workspace = path.resolve('/repo');
    seed(registry, workspace);

    const match = registry.resolveWorkspaceSessions(workspace);
    expect(match.kind).toBe('multiple');
    if (match.kind === 'multiple') {
      expect(match.entries).toHaveLength(2);
      expect(match.entries.map((entry) => entry.deckName)).toEqual(['Deck A', 'Deck A']);
      expect(match.entries.map((entry) => entry.mcpSessionId)).toEqual(['live-a1', 'live-a2']);
    }
  });

  it('sweepStale removes the stale entry and list() drops it', () => {
    const registry = withFakeClock();
    const workspace = path.resolve('/repo');
    seed(registry, workspace);

    expect(registry.sweepStale()).toBe(1);
    expect(registry.list().map((entry) => entry.mcpSessionId).sort()).toEqual(['live-a1', 'live-a2']);
    // Lazy sweep on read: a fresh registry with an aged clock drops it on list().
    const lazy = withFakeClock();
    seed(lazy, workspace);
    fakeNow = T0 + 1_000;
    expect(lazy.list().map((entry) => entry.mcpSessionId).sort()).toEqual(['live-a1', 'live-a2']);
  });

  it('keeps an entry at exactly the bound, expires it one millisecond later', () => {
    const registry = withFakeClock();
    const workspace = path.resolve('/repo');
    registry.upsert({
      mcpSessionId: 'edge',
      workspaceRoot: workspace,
      deckId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      deckName: 'Deck A',
      source: 'launch',
      cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
      updatedAt: isoAt(T0 - STALE_MS),
    });

    fakeNow = T0;
    expect(registry.resolveWorkspaceSessions(workspace).kind).toBe('single');
    fakeNow = T0 + 1;
    expect(registry.resolveWorkspaceSessions(workspace)).toEqual({ kind: 'none', entries: [] });
  });

  it('a touch revives an entry that would otherwise go stale', () => {
    const registry = withFakeClock();
    const workspace = path.resolve('/repo');
    registry.upsert({
      mcpSessionId: 'idle',
      workspaceRoot: workspace,
      deckId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      deckName: 'Deck A',
      source: 'launch',
      cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
      updatedAt: isoAt(T0 - STALE_MS + 10_000),
    });

    fakeNow = T0 + 5_000;
    registry.touch('idle', isoAt(fakeNow));
    fakeNow = T0 + STALE_MS;
    expect(registry.resolveWorkspaceSessions(workspace).kind).toBe('single');
  });

  it('staleMs 0 disables expiry entirely', () => {
    const registry = withFakeClock(0);
    const workspace = path.resolve('/repo');
    seed(registry, workspace);
    fakeNow = T0 + 24 * 3_600_000;

    expect(registry.sweepStale()).toBe(0);
    expect(registry.list()).toHaveLength(3);
    const match = registry.resolveWorkspaceSessions(workspace);
    expect(match.kind).toBe('multiple');
    if (match.kind === 'multiple') {
      expect(match.entries).toHaveLength(3);
    }
  });

  it('two recent sessions on different decks still resolve multiple', () => {
    const registry = withFakeClock();
    const workspace = path.resolve('/repo');
    const base = {
      workspaceRoot: workspace,
      source: 'launch' as const,
      cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
      updatedAt: isoAt(T0),
    };
    registry.upsert({
      ...base,
      mcpSessionId: 'live-a',
      deckId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      deckName: 'Deck A',
    });
    registry.upsert({
      ...base,
      mcpSessionId: 'live-b',
      deckId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      deckName: 'Deck B',
    });

    const match = registry.resolveWorkspaceSessions(workspace);
    expect(match.kind).toBe('multiple');
    if (match.kind === 'multiple') {
      expect(match.entries.map((entry) => entry.deckName).sort()).toEqual(['Deck A', 'Deck B']);
    }
  });

  it('startStaleSweep removes stale entries on its timer', async () => {
    const registry = withFakeClock();
    const workspace = path.resolve('/repo');
    seed(registry, workspace);
    const stop = registry.startStaleSweep(10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(registry.list().map((entry) => entry.mcpSessionId).sort()).toEqual([
        'live-a1',
        'live-a2',
      ]);
    } finally {
      stop();
    }
  });

  describe('resolveLiveDisplayStaleMs', () => {
    it('defaults when unset or blank', () => {
      expect(resolveLiveDisplayStaleMs(undefined)).toBe(DEFAULT_LIVE_DISPLAY_STALE_MS);
      expect(resolveLiveDisplayStaleMs('')).toBe(DEFAULT_LIVE_DISPLAY_STALE_MS);
      expect(resolveLiveDisplayStaleMs('   ')).toBe(DEFAULT_LIVE_DISPLAY_STALE_MS);
      expect(new LiveDisplayRegistry({ nowMs: fakeClock }).getStaleMs()).toBe(
        DEFAULT_LIVE_DISPLAY_STALE_MS,
      );
    });

    it('0 disables expiry', () => {
      expect(resolveLiveDisplayStaleMs('0')).toBe(0);
    });

    it('accepts plain and padded values, floors fractions', () => {
      expect(resolveLiveDisplayStaleMs('60000')).toBe(60_000);
      expect(resolveLiveDisplayStaleMs('  60000  ')).toBe(60_000);
      expect(resolveLiveDisplayStaleMs('1500.9')).toBe(1500);
    });

    it('falls back to the default on invalid values', () => {
      for (const raw of ['nope', '-5', 'NaN', 'Infinity', '12px']) {
        expect(resolveLiveDisplayStaleMs(raw)).toBe(DEFAULT_LIVE_DISPLAY_STALE_MS);
      }
    });
  });
});
