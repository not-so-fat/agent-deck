import { describe, expect, it } from 'vitest';
import type { LiveBinding, PendingAdminChallenge } from '@agent-deck/shared';
import { buildApprovalHref, formatAge, formatTimeUntil, renderMenubar, truncateName } from './menubar';

const NOW = new Date('2026-07-03T12:00:00.000Z');

function binding(overrides: Partial<LiveBinding>): LiveBinding {
  return {
    badge: 'fox',
    deckId: '11111111-1111-4111-8111-111111111111',
    deckName: 'Product Design',
    source: 'session_override',
    workspaceRoot: '/Users/me/workspace/agent_deck',
    clientName: 'cursor',
    cardCounts: { mcp: 4, credentials: 0, playbooks: 6 },
    updatedAt: '2026-07-03T11:59:00.000Z',
    lastActivityAt: '2026-07-03T11:59:48.000Z',
    ...overrides,
  };
}

describe('formatAge', () => {
  it('formats seconds, minutes, hours, days', () => {
    expect(formatAge('2026-07-03T11:59:48.000Z', NOW)).toBe('12s');
    expect(formatAge('2026-07-03T11:58:00.000Z', NOW)).toBe('2m');
    expect(formatAge('2026-07-03T09:00:00.000Z', NOW)).toBe('3h');
    expect(formatAge('2026-07-01T11:00:00.000Z', NOW)).toBe('2d');
    expect(formatAge('not-a-date', NOW)).toBe('');
  });
});

describe('truncateName', () => {
  it('truncates past 24 chars with ellipsis', () => {
    expect(truncateName('Product Design')).toBe('Product Design');
    expect(truncateName('A Very Long Deck Name That Overflows')).toHaveLength(24);
    expect(truncateName('A Very Long Deck Name That Overflows').endsWith('…')).toBe(true);
  });
});

describe('renderMenubar', () => {
  it('single session: deck name + badge in the title', () => {
    const output = renderMenubar([binding({})], NOW);
    const [title] = output.split('\n');
    expect(title).toBe('◆ Product Design ⌘fox');
    expect(output).toContain('---');
    expect(output).toContain('agent_deck/');
    expect(output).toContain('⌘fox');
    expect(output).toContain('cursor · 12s');
  });

  it('workspace-less (auto-bound) session groups under the deck name, no crash', () => {
    const output = renderMenubar(
      [binding({ workspaceRoot: undefined, deckName: 'Dev', badge: 'owl' })],
      NOW,
    );
    expect(output).toContain('◆ Dev');
    expect(output).toContain('⌘owl');
    expect(output).not.toContain('undefined');
  });

  it('multiple sessions: count title, rows grouped by workspace', () => {
    const output = renderMenubar(
      [
        binding({}),
        binding({
          badge: 'ember',
          deckName: 'Task Management',
          clientName: 'claude-code',
          lastActivityAt: '2026-07-03T11:58:00.000Z',
        }),
      ],
      NOW,
    );
    const [title] = output.split('\n');
    expect(title).toBe('◆ 2');
    expect(output).toContain('⌘fox');
    expect(output).toContain('⌘ember');
    expect(output.indexOf('⌘fox')).toBeLessThan(output.indexOf('⌘ember'));
  });

  it('zero sessions: em-dash title', () => {
    const output = renderMenubar([], NOW);
    expect(output.split('\n')[0]).toBe('◆ —');
  });

  it('offline: dimmed title, never stale-as-fresh', () => {
    const output = renderMenubar(null, NOW);
    expect(output.split('\n')[0]).toBe('◆ off | color=gray');
    expect(output).not.toContain('⌘');
  });

  it('falls back to "agent" when clientName is absent', () => {
    const output = renderMenubar([binding({ clientName: undefined })], NOW);
    expect(output).toContain('agent · 12s');
  });

  it('shows pending admin approval rows with dashboard href', () => {
    const pending: PendingAdminChallenge = {
      challengeId: 'adm_test',
      runtimeSessionId: 'ses_test',
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Product Design',
      expiresAt: '2026-07-03T12:04:00.000Z',
      approvalPath: '/admin/approve?challenge=adm_test&session=ses_test',
    };
    const output = renderMenubar([], NOW, [pending], 'http://127.0.0.1:1111');
    expect(output.split('\n')[0]).toBe('◆ ⚠ 1');
    expect(output).toContain('Admin approval pending');
    expect(output).toContain('href=http://127.0.0.1:1111/admin/approve?challenge=adm_test&session=ses_test');
    expect(output).toContain('Approve Product Design');
  });
});

describe('formatTimeUntil', () => {
  it('formats future expiry', () => {
    expect(formatTimeUntil('2026-07-03T12:04:00.000Z', NOW)).toBe('4m');
  });
});

describe('buildApprovalHref', () => {
  it('joins dashboard origin and approval path', () => {
    const href = buildApprovalHref(
      {
        challengeId: 'adm_x',
        runtimeSessionId: 'ses_x',
        deckId: '11111111-1111-4111-8111-111111111111',
        expiresAt: '2026-07-03T12:04:00.000Z',
        approvalPath: '/admin/approve?challenge=adm_x&session=ses_x',
      },
      'http://127.0.0.1:1111',
    );
    expect(href).toBe('http://127.0.0.1:1111/admin/approve?challenge=adm_x&session=ses_x');
  });
});
