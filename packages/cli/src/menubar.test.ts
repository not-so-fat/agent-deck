import { describe, expect, it } from 'vitest';
import type {
  LiveBinding,
  PendingAdminChallenge,
  PendingDeckSwitchRequest,
} from '@agent-deck/shared';
import {
  MENUBAR_STOP_SOURCE,
  buildApprovalHref,
  buildDeckSwitchApprovalHref,
  buildDeckSwitchApprovalLine,
  buildStopDeckMenubarArgs,
  buildStopDeckMenubarLine,
  formatAge,
  formatTimeUntil,
  renderMenubar,
  truncateName,
} from './menubar';
import { parseStopOptions } from './stop';

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

  it('shows pending admin approval rows via agent-deck open', () => {
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
    expect(output).toContain('Open dashboard | bash=agent-deck param1=open terminal=false');
    expect(output).toContain('Admin approval pending');
    expect(output).toContain(
      `bash=agent-deck param1=open param2=--path param3=${encodeURIComponent('/admin/approve?challenge=adm_test&session=ses_test')}`,
    );
    expect(output).toContain('Approve Product Design');
  });
});

describe('deck-switch approval inbox (NOT-212)', () => {
  function pendingSwitch(overrides: Partial<PendingDeckSwitchRequest> = {}): PendingDeckSwitchRequest {
    return {
      requestId: 'req_inbox_1',
      runtimeSessionId: 'ses_inbox_1',
      status: 'pending',
      currentDeckName: 'Product Design',
      requestedDeckName: 'Task Management',
      expiresAt: '2026-07-03T12:04:00.000Z',
      approvalPath: '/deck-switch/approve?request=req_inbox_1&session=ses_inbox_1',
      ...overrides,
    };
  }

  it('shows a Pending approvals entry with count and both deck labels', () => {
    const output = renderMenubar([], NOW, [], 'http://127.0.0.1:1111', [pendingSwitch()]);
    expect(output.split('\n')[0]).toBe('◆ ⚠ 1');
    expect(output).toContain('Pending approvals (1)');
    expect(output).toContain('Product Design');
    expect(output).toContain('Task Management');
    expect(output).toContain(
      `bash=agent-deck param1=open param2=--path param3=${encodeURIComponent('/deck-switch/approve?request=req_inbox_1&session=ses_inbox_1')}`,
    );
  });

  it('counts admin and deck-switch approvals together in the title', () => {
    const admin: PendingAdminChallenge = {
      challengeId: 'adm_test',
      runtimeSessionId: 'ses_test',
      deckId: '11111111-1111-4111-8111-111111111111',
      deckName: 'Product Design',
      expiresAt: '2026-07-03T12:04:00.000Z',
      approvalPath: '/admin/approve?challenge=adm_test&session=ses_test',
    };
    const output = renderMenubar([], NOW, [admin], 'http://127.0.0.1:1111', [pendingSwitch()]);
    expect(output.split('\n')[0]).toBe('◆ ⚠ 2');
    expect(output).toContain('Admin approval pending');
    expect(output).toContain('Pending approvals (1)');
  });

  it('omits the inbox section when nothing is pending', () => {
    const output = renderMenubar([binding({})], NOW);
    expect(output).not.toContain('Pending approvals');
  });

  it('reopens the approval page through agent-deck open, never a bare URL', () => {
    const href = buildDeckSwitchApprovalHref(pendingSwitch(), 'http://127.0.0.1:1111');
    expect(href).toBe(
      `bash=agent-deck param1=open param2=--path param3=${encodeURIComponent('/deck-switch/approve?request=req_inbox_1&session=ses_inbox_1')}`,
    );
    expect(href).not.toContain('bootstrap=');
  });

  it('falls back to generic labels when deck names are absent', () => {
    const line = buildDeckSwitchApprovalLine(
      pendingSwitch({ currentDeckName: undefined, requestedDeckName: undefined }),
      NOW,
    );
    expect(line).toContain('current deck');
    expect(line).toContain('requested deck');
    expect(line).toContain('expires in 4m');
  });
});

describe('formatTimeUntil', () => {
  it('formats future expiry', () => {
    expect(formatTimeUntil('2026-07-03T12:04:00.000Z', NOW)).toBe('4m');
  });
});

describe('buildApprovalHref', () => {
  it('uses agent-deck open so clicks mint a bootstrap cookie', () => {
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
    expect(href).toBe(
      `bash=agent-deck param1=open param2=--path param3=${encodeURIComponent('/admin/approve?challenge=adm_x&session=ses_x')}`,
    );
  });
});

/**
 * NOT-135 finding 1: the menu bar's stop must be identifiable in supervisor.log,
 * which is only true if the argv it emits is the argv `stop` actually parses.
 * Verified as a round trip over the real functions — no daemon, no SIGTERM.
 */
describe('menu bar stop names its origin', () => {
  it('emits the attributed stop argv', () => {
    expect(buildStopDeckMenubarArgs()).toEqual([
      'stop',
      '--source',
      MENUBAR_STOP_SOURCE,
      '--detail',
      'menu-bar-stop-item',
    ]);
  });

  it('is understood by the stop command it invokes', () => {
    // The round trip is the point: a label the menu bar emits but `stop` drops
    // would leave the SIGTERM anonymous, which is the whole defect.
    const [, ...args] = buildStopDeckMenubarArgs();
    expect(parseStopOptions(args)).toEqual({
      source: MENUBAR_STOP_SOURCE,
      detail: 'menu-bar-stop-item',
    });
  });

  it('keeps every SwiftBar param value whitespace-free', () => {
    // SwiftBar splits paramN= on whitespace, so a spaced value silently becomes
    // two arguments and the attribution is lost.
    for (const arg of buildStopDeckMenubarArgs()) {
      expect(arg).not.toMatch(/\s/);
    }
  });

  it('renders a stop item wired to agent-deck, not a bare kill', () => {
    const line = buildStopDeckMenubarLine();
    expect(line).toContain('bash=agent-deck');
    expect(line).toContain('param1=stop');
    expect(line).toContain(`param3=${MENUBAR_STOP_SOURCE}`);
    expect(line).not.toContain('kill');
  });

  it('offers the stop item in the rendered menu', () => {
    expect(renderMenubar([], new Date())).toContain(buildStopDeckMenubarLine());
  });
});
