import { describe, expect, it } from 'vitest';
import type { LiveBinding } from '@agent-deck/shared';
import {
  countSessionsByDeckId,
  formatActivityAge,
  formatDeckListSubtitle,
  groupLiveBindings,
  liveSessionRowSubtitle,
  truncateDeckName,
  workspaceBasename,
} from './live-bindings';

const NOW = new Date('2026-07-03T12:00:00.000Z');

const SAMPLE_LIVE_BINDINGS: LiveBinding[] = [
  {
    badge: 'fox',
    deckId: '11111111-1111-4111-8111-111111111111',
    deckName: 'Product Design',
    source: 'session_override',
    workspaceRoot: '/Users/demo/workspace/agent-deck',
    clientName: 'cursor',
    mode: 'normal',
    cardCounts: { mcp: 4, credentials: 1, playbooks: 6 },
    updatedAt: '2026-08-30T03:40:00.000Z',
    lastActivityAt: '2026-08-30T03:44:12.000Z',
  },
  {
    badge: 'owl',
    deckId: '22222222-2222-4222-8222-222222222222',
    deckName: 'Dev',
    source: 'session_override',
    workspaceRoot: '/Users/demo/workspace/kite-app',
    clientName: 'claude-code',
    mode: 'agent-admin',
    cardCounts: { mcp: 2, credentials: 0, playbooks: 3 },
    updatedAt: '2026-08-30T03:38:00.000Z',
    lastActivityAt: '2026-08-30T03:43:55.000Z',
  },
  {
    badge: 'ember',
    deckId: '11111111-1111-4111-8111-111111111111',
    deckName: 'Product Design',
    source: 'env',
    clientName: 'cursor',
    mode: 'normal',
    cardCounts: { mcp: 4, credentials: 1, playbooks: 6 },
    updatedAt: '2026-08-30T03:35:00.000Z',
    lastActivityAt: '2026-08-30T03:42:01.000Z',
  },
];

describe('live-bindings helpers', () => {
  it('formatActivityAge matches menubar units', () => {
    expect(formatActivityAge('2026-07-03T11:59:48.000Z', NOW)).toBe('12s');
    expect(formatActivityAge('2026-07-03T11:58:00.000Z', NOW)).toBe('2m');
    expect(formatActivityAge('not-a-date', NOW)).toBe('');
  });

  it('truncateDeckName caps at 24 chars', () => {
    expect(truncateDeckName('Product Design')).toBe('Product Design');
    expect(truncateDeckName('A Very Long Deck Name That Overflows')).toHaveLength(24);
  });

  it('workspaceBasename takes the last path segment', () => {
    expect(workspaceBasename('/Users/me/workspace/agent_deck')).toBe('agent_deck');
  });

  it('countSessionsByDeckId groups live binds', () => {
    const counts = countSessionsByDeckId([
      { deckId: 'a' },
      { deckId: 'a' },
      { deckId: 'b' },
    ]);
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
  });

  it('formatDeckListSubtitle shows cards and sessions', () => {
    expect(formatDeckListSubtitle(17, 2)).toBe('17 cards, 2 sessions');
    expect(formatDeckListSubtitle(17, 1)).toBe('17 cards, 1 session');
    expect(formatDeckListSubtitle(17, 0)).toBe('17 cards');
    expect(formatDeckListSubtitle(0, 0)).toBe('Empty');
  });

  it('groupLiveBindings coalesces no-folder rows into a workspace group for the same deck', () => {
    const groups = groupLiveBindings(SAMPLE_LIVE_BINDINGS);
    const agentDeck = groups.find((group) => group.label === 'agent-deck/');
    expect(agentDeck?.rows.map((row) => row.badge).sort()).toEqual(['ember', 'fox']);
    expect(groups.some((group) => group.label === '◆ Product Design')).toBe(false);
  });

  it('liveSessionRowSubtitle omits deck name for highlighted workspace rows', () => {
    const fox = SAMPLE_LIVE_BINDINGS[0];
    expect(
      liveSessionRowSubtitle(fox, {
        isWorkspaceGroup: true,
        highlighted: true,
        clientMeta: 'cursor · 0s',
      }),
    ).toBe('cursor · 0s');
    expect(
      liveSessionRowSubtitle(SAMPLE_LIVE_BINDINGS[2], {
        isWorkspaceGroup: true,
        highlighted: true,
        clientMeta: 'cursor · 2m',
      }),
    ).toBe('no folder · cursor · 2m');
  });
});
