import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LiveDisplayRegistry } from './live-display-registry';

describe('LiveDisplayRegistry', () => {
  it('finds the newest bind for an exact workspace', () => {
    const registry = new LiveDisplayRegistry();
    const workspace = path.resolve('/repo');

    registry.upsert({
      mcpSessionId: 'older',
      workspaceRoot: workspace,
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Older',
      source: 'session_override',
      cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    registry.upsert({
      mcpSessionId: 'newer',
      workspaceRoot: workspace,
      deckId: '22222222-2222-4222-8222-222222222222',
      deckName: 'Newer',
      source: 'session_override',
      cardCounts: { mcp: 2, credentials: 0, playbooks: 0 },
      updatedAt: '2026-07-02T15:33:00.000Z',
    });

    expect(registry.findForWorkspace(workspace)?.deckName).toBe('Newer');
  });

  it('lists a workspace-less (auto-bound) entry but never matches it to a folder', () => {
    const registry = new LiveDisplayRegistry();
    registry.upsert({
      mcpSessionId: 'auto',
      deckId: '33333333-3333-4333-8333-333333333333',
      deckName: 'Dev',
      source: 'session_override',
      cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
      updatedAt: '2026-07-02T15:33:00.000Z',
    });

    // Appears in the dashboard list…
    expect(registry.list().map((e) => e.deckName)).toEqual(['Dev']);
    // …but has no folder, so the per-workspace statusline never picks it up.
    expect(registry.findForWorkspace(path.resolve('/repo'))).toBeNull();
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
      updatedAt: '2026-07-02T15:33:00.000Z',
    });

    expect(registry.findForWorkspace(path.join(workspace, 'packages', 'app'))?.deckName).toBe(
      'Root Deck',
    );
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
      updatedAt: '2026-07-02T15:33:00.000Z',
    });
    registry.remove('session-1');

    expect(registry.findForWorkspace(workspace)).toBeNull();
  });

  it('assigns distinct badges and preserves a session badge across re-upsert', () => {
    const registry = new LiveDisplayRegistry();
    const base = {
      workspaceRoot: path.resolve('/repo'),
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Deck A',
      source: 'session_override' as const,
      cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
      updatedAt: '2026-07-03T00:00:00.000Z',
    };

    const first = registry.upsert({ ...base, mcpSessionId: 'one' });
    const second = registry.upsert({ ...base, mcpSessionId: 'two' });
    expect(first.badge).not.toBe(second.badge);

    const switched = registry.upsert({
      ...base,
      mcpSessionId: 'one',
      deckName: 'Deck B',
      updatedAt: '2026-07-03T00:01:00.000Z',
    });
    expect(switched.badge).toBe(first.badge);
    expect(switched.deckName).toBe('Deck B');
  });

  it('touch bumps lastActivityAt monotonically and ignores unknown sessions', () => {
    const registry = new LiveDisplayRegistry();
    const entry = registry.upsert({
      mcpSessionId: 'one',
      workspaceRoot: path.resolve('/repo'),
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Deck A',
      source: 'session_override',
      cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
      updatedAt: '2026-07-03T00:00:00.000Z',
    });
    expect(entry.lastActivityAt).toBe('2026-07-03T00:00:00.000Z');

    registry.touch('one', '2026-07-03T00:05:00.000Z');
    registry.touch('one', '2026-07-03T00:01:00.000Z');
    registry.touch('ghost', '2026-07-03T00:05:00.000Z');
    expect(registry.list()[0].lastActivityAt).toBe('2026-07-03T00:05:00.000Z');
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
    registry.upsert({ ...base, mcpSessionId: 'old', updatedAt: '2026-07-03T00:00:00.000Z' });
    registry.upsert({ ...base, mcpSessionId: 'new', updatedAt: '2026-07-03T01:00:00.000Z' });
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
      updatedAt: '2026-07-03T00:00:00.000Z',
    };
    const first = registry.upsert({ ...base, mcpSessionId: 'one' });
    registry.remove('one');
    const next = registry.upsert({ ...base, mcpSessionId: 'two' });
    expect(next.badge).toBe(first.badge);
  });
});
