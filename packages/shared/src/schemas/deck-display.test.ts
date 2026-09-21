import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  BindingActiveSourceSchema,
  DISPLAY_LINE_MAX_LENGTH,
  DeckDisplaySchema,
  LiveBindingSchema,
  appendSessionOverrideSuffix,
  countDeckCards,
  formatDisplayLine,
  formatDisplayUpdatedSuffix,
  resolveStatusLineSessionId,
  resolveStatusLineWorkspace,
} from './deck-display';

describe('deck-display', () => {
  describe('countDeckCards', () => {
    it('counts mcp services separately from other service types', () => {
      expect(
        countDeckCards({
          services: [{ type: 'mcp' }, { type: 'mcp' }, { type: 'api' }],
          credentials: [{ id: '1' }],
          playbooks: [],
        }),
      ).toEqual({ mcp: 2, credentials: 1, playbooks: 0 });
    });
  });

  describe('formatDisplayLine', () => {
    const counts = { mcp: 3, credentials: 2, playbooks: 1 };

    it('renders bound deck summary', () => {
      expect(formatDisplayLine('Dev Deck', counts)).toBe(
        '◆ Dev Deck · 3 MCP · 2 keys · 1 playbooks',
      );
    });

    it('renders unbound message', () => {
      expect(formatDisplayLine(null, counts)).toBe(
        '◆ Unbound — bind a deck to use Agent Deck',
      );
    });

    it('renders offline message', () => {
      expect(formatDisplayLine('Dev Deck', counts, { offline: true })).toBe(
        '◆ Agent Deck offline',
      );
    });

    it('appends MCP offline suffix when backend is up', () => {
      expect(formatDisplayLine(null, counts, { mcpOffline: true })).toBe(
        '◆ Unbound — bind a deck to use Agent Deck · MCP offline',
      );
    });

    it('appends updated timestamp suffix', () => {
      const suffix = formatDisplayUpdatedSuffix('2026-07-02T07:20:00.000Z');
      expect(suffix).toMatch(/\(updated 2026-07-02 \d{2}:20\)/);
      expect(formatDisplayLine('Dev Deck', counts, { updatedAt: '2026-07-02T07:20:00.000Z' })).toContain(
        '(updated',
      );
    });

    it('truncates long deck names within max length', () => {
      const line = formatDisplayLine('A'.repeat(200), counts);
      expect(line.length).toBeLessThanOrEqual(DISPLAY_LINE_MAX_LENGTH);
      expect(line.endsWith('playbooks')).toBe(true);
    });
  });

  describe('resolveStatusLineSessionId', () => {
    it('reads session_id from stdin payload', () => {
      expect(
        resolveStatusLineSessionId({
          session_id: '123e4567-e89b-12d3-a456-426614174000',
        }),
      ).toBe('123e4567-e89b-12d3-a456-426614174000');
    });
  });

  describe('resolveStatusLineWorkspace', () => {
    it('prefers workspace.project_dir over cwd', () => {
      expect(
        resolveStatusLineWorkspace({
          cwd: '/repo/packages/app',
          workspace: { project_dir: '/repo', current_dir: '/repo/packages/app' },
        }),
      ).toBe(path.resolve('/repo'));
    });

    it('prefers cwd over workspace.current_dir when project_dir absent', () => {
      expect(
        resolveStatusLineWorkspace({
          cwd: '/repo',
          workspace: { current_dir: '/other' },
        }),
      ).toBe(path.resolve('/repo'));
    });

    it('falls back to workspace.current_dir', () => {
      expect(resolveStatusLineWorkspace({ workspace: { current_dir: '/repo' } })).toBe(
        path.resolve('/repo'),
      );
    });
  });

  describe('formatDisplayLine badge', () => {
    it('appends ⌘badge after counts', () => {
      expect(
        formatDisplayLine(
          'Product Design',
          { mcp: 4, credentials: 0, playbooks: 6 },
          { badge: 'fox' },
        ),
      ).toBe('◆ Product Design · 4 MCP · 0 keys · 6 playbooks · ⌘fox');
    });

    it('counts the badge suffix in the 120-char budget', () => {
      const line = formatDisplayLine(
        'x'.repeat(200),
        { mcp: 4, credentials: 0, playbooks: 6 },
        { badge: 'zephyr' },
      );
      expect(line.length).toBeLessThanOrEqual(120);
      expect(line.endsWith('· ⌘zephyr')).toBe(true);
    });

    it('omits badge when unbound', () => {
      expect(
        formatDisplayLine(null, { mcp: 0, credentials: 0, playbooks: 0 }, { badge: 'fox' }),
      ).not.toContain('⌘');
    });
  });

  describe('formatDisplayLine session override (NOT-211)', () => {
    const counts = { mcp: 3, credentials: 2, playbooks: 1 };

    it('marks a session override concisely without breaking the one-line shape', () => {
      const line = formatDisplayLine('Beta', counts, { workspaceDefaultName: 'Alpha' });
      expect(line).toBe('◆ Beta · 3 MCP · 2 keys · 1 playbooks · session (default Alpha)');
      expect(line).toContain('◆ Beta · 3 MCP · 2 keys · 1 playbooks');
      expect(line.length).toBeLessThanOrEqual(DISPLAY_LINE_MAX_LENGTH);
      expect(line).not.toContain('\n');
    });

    it('omits the marker when active equals the workspace default', () => {
      expect(formatDisplayLine('Alpha', counts, { workspaceDefaultName: 'Alpha' })).toBe(
        formatDisplayLine('Alpha', counts),
      );
    });

    it('omits the marker when no workspace default is known', () => {
      expect(formatDisplayLine('Beta', counts)).toBe(
        '◆ Beta · 3 MCP · 2 keys · 1 playbooks',
      );
      expect(formatDisplayLine('Beta', counts, { workspaceDefaultName: null })).toBe(
        formatDisplayLine('Beta', counts),
      );
    });

    it('omits the marker when unbound even with a saved default', () => {
      expect(
        formatDisplayLine(null, counts, { workspaceDefaultName: 'Alpha' }),
      ).toBe('◆ Unbound — bind a deck to use Agent Deck');
    });

    it('keeps badge and override marker together within max length', () => {
      const line = formatDisplayLine('Beta', counts, {
        badge: 'fox',
        workspaceDefaultName: 'Alpha',
      });
      expect(line).toContain('⌘fox');
      expect(line).toContain('session (default Alpha)');
      expect(line.length).toBeLessThanOrEqual(DISPLAY_LINE_MAX_LENGTH);
    });

    it('truncates a long default name instead of exceeding max length', () => {
      const line = formatDisplayLine('Beta', counts, {
        workspaceDefaultName: 'A'.repeat(200),
      });
      expect(line.length).toBeLessThanOrEqual(DISPLAY_LINE_MAX_LENGTH);
      expect(line).toContain('session (default ');
      expect(line.endsWith(')')).toBe(true);
    });

    it('keeps the marker visible when the base line already fills the budget', () => {
      const base = formatDisplayLine('B'.repeat(200), { mcp: 12, credentials: 34, playbooks: 56 }, { badge: 'zephyr' });
      expect(base.length).toBeLessThanOrEqual(DISPLAY_LINE_MAX_LENGTH);
      const line = formatDisplayLine('B'.repeat(200), { mcp: 12, credentials: 34, playbooks: 56 }, {
        badge: 'zephyr',
        workspaceDefaultName: 'Alpha',
      });
      expect(line.length).toBeLessThanOrEqual(DISPLAY_LINE_MAX_LENGTH);
      expect(line).toContain('session (default Alpha)');
      expect(line.endsWith(')')).toBe(true);
    });

    it('explicit sessionOverride=false hides a stale default name', () => {
      // use.json deckName is stale after a rename: ids are equal, so this is
      // not an override even though the names differ.
      const line = formatDisplayLine('Beta', counts, {
        workspaceDefaultName: 'Alpha',
        sessionOverride: false,
      });
      expect(line).toBe(formatDisplayLine('Beta', counts));
      expect(line).not.toContain('session (default');
    });

    it('explicit sessionOverride=true shows a same-name override', () => {
      // Same display name but different deck ids is a real override.
      const line = formatDisplayLine('Beta', counts, {
        workspaceDefaultName: 'Beta',
        sessionOverride: true,
      });
      expect(line).toContain('session (default Beta)');
      expect(line.length).toBeLessThanOrEqual(DISPLAY_LINE_MAX_LENGTH);
    });

    it('appendSessionOverrideSuffix honors the explicit flag over names', () => {
      expect(appendSessionOverrideSuffix('◆ Beta · 1 MCP', 'Beta', 'Beta')).toBe(
        '◆ Beta · 1 MCP',
      );
      expect(appendSessionOverrideSuffix('◆ Beta · 1 MCP', 'Beta', null)).toBe(
        '◆ Beta · 1 MCP',
      );
      expect(appendSessionOverrideSuffix('◆ Beta · 1 MCP', null, 'Alpha')).toBe(
        '◆ Beta · 1 MCP',
      );
      expect(appendSessionOverrideSuffix('◆ Beta · 1 MCP', 'Beta', 'Alpha', false)).toBe(
        '◆ Beta · 1 MCP',
      );
      expect(appendSessionOverrideSuffix('◆ Beta · 1 MCP', 'Beta', 'Beta', true)).toBe(
        '◆ Beta · 1 MCP · session (default Beta)',
      );
    });

    it('appendSessionOverrideSuffix keeps a near-budget line marker visible', () => {
      const line = `◆ ${'B'.repeat(110)}`;
      const marked = appendSessionOverrideSuffix(line, 'Beta', 'Alpha', true);
      expect(marked.length).toBeLessThanOrEqual(DISPLAY_LINE_MAX_LENGTH);
      expect(marked).toContain('session (default ');
      expect(marked.endsWith(')')).toBe(true);
    });
  });

  describe('BindingActiveSourceSchema', () => {
    it('accepts session, workspace, and launch', () => {
      for (const source of ['session', 'workspace', 'launch'] as const) {
        expect(BindingActiveSourceSchema.parse(source)).toBe(source);
      }
      expect(BindingActiveSourceSchema.safeParse('session_override').success).toBe(false);
      expect(BindingActiveSourceSchema.safeParse('env').success).toBe(false);
    });
  });

  describe('LiveBindingSchema', () => {
    it('accepts a full binding row and rejects missing badge', () => {
      const row = {
        badge: 'fox',
        deckId: '11111111-1111-4111-8111-111111111111',
        deckName: 'Product Design',
        source: 'session_override',
        workspaceRoot: '/repo',
        clientName: 'cursor',
        cardCounts: { mcp: 4, credentials: 0, playbooks: 6 },
        updatedAt: '2026-07-03T00:00:00.000Z',
        lastActivityAt: '2026-07-03T00:00:10.000Z',
      };
      expect(LiveBindingSchema.parse(row).badge).toBe('fox');
      expect(LiveBindingSchema.safeParse({ ...row, badge: undefined }).success).toBe(false);
    });

    it('accepts launch source from launch-selected MCP sessions', () => {
      const row = {
        badge: 'fox',
        deckId: '11111111-1111-4111-8111-111111111111',
        deckName: 'Product Design',
        source: 'launch',
        workspaceRoot: '/repo',
        cardCounts: { mcp: 2, credentials: 1, playbooks: 3 },
        updatedAt: '2026-09-10T00:00:00.000Z',
        lastActivityAt: '2026-09-10T00:00:10.000Z',
      };
      expect(LiveBindingSchema.parse(row).source).toBe('launch');
    });
  });

  describe('schemas', () => {
    it('validates deck display payload', () => {
      const result = DeckDisplaySchema.safeParse({
        workspaceRoot: '/Users/me/repo',
        deckId: '123e4567-e89b-12d3-a456-426614174000',
        deckName: 'Dev',
        source: 'session_override',
        cardCounts: { mcp: 1, credentials: 0, playbooks: 0 },
        agentDeckOnline: true,
        mcpOnline: true,
        displayLine: '◆ Dev · 1 MCP · 0 keys · 0 playbooks',
      });
      expect(result.success).toBe(true);
    });
  });
});
