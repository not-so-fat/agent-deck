import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  DISPLAY_LINE_MAX_LENGTH,
  DeckDisplaySchema,
  LiveBindingSchema,
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

    it('accepts grant source from trusted workspace sessions', () => {
      const row = {
        badge: 'fox',
        deckId: '11111111-1111-4111-8111-111111111111',
        deckName: 'Product Design',
        source: 'grant',
        workspaceRoot: '/repo',
        cardCounts: { mcp: 2, credentials: 1, playbooks: 3 },
        updatedAt: '2026-09-10T00:00:00.000Z',
        lastActivityAt: '2026-09-10T00:00:10.000Z',
      };
      expect(LiveBindingSchema.parse(row).source).toBe('grant');
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
