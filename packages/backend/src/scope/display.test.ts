import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatDisplayLine, MULTIPLE_SESSION_DECKS_LINE } from '@agent-deck/shared';
import { DatabaseManager } from '../models/database';
import { writeUseManifest } from '../playbooks/stub-sync';
import { LiveDisplayRegistry } from './live-display-registry';
import { resolveDeckDisplay } from './display';

describe('resolveDeckDisplay', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let db: DatabaseManager;
  let registry: LiveDisplayRegistry;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-deck-display-'));
    process.env.AGENT_DECK_HOME = tempDir;
    delete process.env.AGENT_DECK_DECK_ID;

    const dbPath = path.join(tempDir, 'agent_deck.db');
    db = new DatabaseManager(dbPath);
    registry = new LiveDisplayRegistry();
  });

  afterEach(async () => {
    await db.close();
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('shows live MCP bind for workspace', async () => {
    const workspace = path.join(tempDir, 'repo');
    const boundDeck = await db.createDeck({ name: 'Task Management' });

    registry.upsert({
      mcpSessionId: 'mcp-session-1',
      workspaceRoot: workspace,
      deckId: boundDeck.id,
      deckName: boundDeck.name,
      source: 'session_override',
      updatedAt: '2026-07-02T15:33:00.000Z',
      cardCounts: { mcp: 4, credentials: 0, playbooks: 4 },
    });

    const display = await resolveDeckDisplay({ workspaceRoot: workspace }, db, registry);
    expect(display.deckId).toBe(boundDeck.id);
    expect(display.displayLine).toContain('Task Management');
    expect(display.displayLine).toContain('(updated');
  });

  it('returns unbound when deck.yaml exists on disk but no live session', async () => {
    const workspace = path.join(tempDir, 'repo-manifest');
    await fs.mkdir(path.join(workspace, '.agent-deck'), { recursive: true });

    const deck = await db.createDeck({ name: 'Manifest Deck' });
    await fs.writeFile(
      path.join(workspace, '.agent-deck', 'deck.yaml'),
      `deck_id: ${deck.id}\n`,
      'utf8',
    );

    const display = await resolveDeckDisplay({ workspaceRoot: workspace }, db, registry);
    expect(display.deckId).toBeNull();
    expect(display.source).toBe('unbound');
    expect(display.displayLine).toContain('◆ Unbound — bind a deck to use Agent Deck');
  });

  it('returns unbound for empty workspace', async () => {
    const workspace = path.join(tempDir, 'empty');
    await fs.mkdir(workspace, { recursive: true });

    const display = await resolveDeckDisplay({ workspaceRoot: workspace }, db, registry);
    expect(display.deckId).toBeNull();
    expect(display.source).toBe('unbound');
    expect(display.displayLine).toContain('◆ Unbound — bind a deck to use Agent Deck');
  });

  it('NOT-296: single live session renders that session exact displayLine', async () => {
    const workspace = path.join(tempDir, 'solo');
    const deck = await db.createDeck({ name: 'Solo Deck' });

    registry.upsert({
      mcpSessionId: 'mcp-solo',
      workspaceRoot: workspace,
      deckId: deck.id,
      deckName: deck.name,
      source: 'launch',
      updatedAt: '2026-09-28T00:00:00.000Z',
      cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
    });
    const badge = registry.get('mcp-solo')?.badge;
    expect(badge).toBeTruthy();

    const display = await resolveDeckDisplay({ workspaceRoot: workspace }, db, registry);
    const expected = formatDisplayLine(deck.name, { mcp: 0, credentials: 0, playbooks: 0 }, {
      badge,
      updatedAt: '2026-09-28T00:00:00.000Z',
    });
    expect(display.deckId).toBe(deck.id);
    expect(display.displayLine).toBe(expected);
  });

  it('NOT-296: two sessions on different decks stay neutral without naming either', async () => {
    const workspace = path.join(tempDir, 'split');
    const deckA = await db.createDeck({ name: 'Alpha Deck' });
    const deckB = await db.createDeck({ name: 'Beta Deck' });

    const seed = (first: 'a' | 'b') => {
      const fresh = new LiveDisplayRegistry();
      const order =
        first === 'a'
          ? [
              { id: 'mcp-a', deck: deckA, at: '2026-09-28T00:00:00.000Z' },
              { id: 'mcp-b', deck: deckB, at: '2026-09-28T01:00:00.000Z' },
            ]
          : [
              { id: 'mcp-b', deck: deckB, at: '2026-09-28T01:00:00.000Z' },
              { id: 'mcp-a', deck: deckA, at: '2026-09-28T00:00:00.000Z' },
            ];
      for (const row of order) {
        fresh.upsert({
          mcpSessionId: row.id,
          workspaceRoot: workspace,
          deckId: row.deck.id,
          deckName: row.deck.name,
          source: 'launch',
          updatedAt: row.at,
          cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
        });
      }
      return fresh;
    };

    // Either insertion order — and regardless of which session updated last —
    // the line stays neutral.
    for (const first of ['a', 'b'] as const) {
      const display = await resolveDeckDisplay({ workspaceRoot: workspace }, db, seed(first));
      expect(display.deckId).toBeNull();
      expect(display.displayLine).toBe(MULTIPLE_SESSION_DECKS_LINE);
      expect(display.displayLine).toContain('multiple session decks');
      expect(display.displayLine).toContain('chat receipt');
      expect(display.displayLine).not.toContain('Alpha Deck');
      expect(display.displayLine).not.toContain('Beta Deck');
    }
  });

  it('NOT-296: two sessions on the same deck name it with a session count', async () => {
    const workspace = path.join(tempDir, 'agreed');
    const deck = await db.createDeck({ name: 'Shared Deck' });
    const service = await db.createService({
      name: 'svc',
      type: 'mcp',
      url: 'http://127.0.0.1:9/mcp',
    });
    await db.addServiceToDeck({ deckId: deck.id, serviceId: service.id, position: 0 });

    const seed = (newestFirst: boolean) => {
      const fresh = new LiveDisplayRegistry();
      const rows = [
        {
          id: 'mcp-aaa',
          at: '2026-09-28T00:00:00.000Z',
          counts: { mcp: 9, credentials: 9, playbooks: 9 },
        },
        {
          id: 'mcp-zzz',
          at: '2026-09-28T05:00:00.000Z',
          counts: { mcp: 8, credentials: 8, playbooks: 8 },
        },
      ];
      if (newestFirst) {
        rows.reverse();
      }
      for (const row of rows) {
        fresh.upsert({
          mcpSessionId: row.id,
          workspaceRoot: workspace,
          deckId: deck.id,
          deckName: deck.name,
          source: 'launch',
          updatedAt: row.at,
          cardCounts: row.counts,
        });
      }
      return fresh;
    };

    // Deterministic: identical output whichever session updated last or was
    // inserted first; fresh DB counts win over stale per-session counts.
    const first = await resolveDeckDisplay({ workspaceRoot: workspace }, db, seed(false));
    const second = await resolveDeckDisplay({ workspaceRoot: workspace }, db, seed(true));
    expect(first.displayLine).toBe(second.displayLine);
    expect(first.deckId).toBe(deck.id);
    expect(first.displayLine).toContain('Shared Deck');
    expect(first.displayLine).toContain('2 sessions');
    expect(first.displayLine).toContain('1 MCP');
    expect(first.displayLine).not.toContain('9 MCP');
    expect(first.displayLine).not.toContain('⌘');
  });

  it('NOT-296: database assignment with no live session is labeled workspace default', async () => {
    const workspace = path.join(tempDir, 'defaulted');
    const deck = await db.createDeck({ name: 'Saved Deck' });
    await db.upsertDeckWorkspace(workspace, deck.id);

    const display = await resolveDeckDisplay({ workspaceRoot: workspace }, db, registry);
    expect(display.deckId).toBe(deck.id);
    expect(display.deckName).toBe('Saved Deck');
    expect(display.displayLine).toContain('Saved Deck');
    expect(display.displayLine).toContain('workspace default');
    expect(display.displayLine).not.toContain('⌘');
    expect(display.displayLine).not.toContain('session (default');
  });

  it('NOT-296: use.json assignment with no live session is labeled workspace default', async () => {
    const workspace = path.join(tempDir, 'manifest-default');
    const deck = await db.createDeck({ name: 'Manifest Deck' });
    writeUseManifest(workspace, { version: 3, deckId: deck.id, deckName: deck.name });

    const display = await resolveDeckDisplay({ workspaceRoot: workspace }, db, registry);
    expect(display.deckId).toBe(deck.id);
    expect(display.displayLine).toContain('Manifest Deck');
    expect(display.displayLine).toContain('workspace default');
    expect(display.displayLine).not.toContain('session (default');
  });

  it('NOT-296 repair: subdirectory cwd resolves the parent use.json default, not a stale deck_workspaces row', async () => {
    // Cursor sends only the cwd (/repo/pkg); the workspace-default switch
    // wrote /repo/.agent-deck/use.json. deck_workspaces still names the
    // pre-switch deck and must not win.
    const workspace = path.join(tempDir, 'repo');
    const subdir = path.join(workspace, 'pkg');
    await fs.mkdir(subdir, { recursive: true });
    const deckA = await db.createDeck({ name: 'Stale Deck' });
    const deckB = await db.createDeck({ name: 'Current Default Deck' });
    await db.upsertDeckWorkspace(workspace, deckA.id);
    writeUseManifest(workspace, { version: 3, deckId: deckB.id, deckName: deckB.name });

    const display = await resolveDeckDisplay({ workspaceRoot: subdir }, db, registry);
    expect(display.deckId).toBe(deckB.id);
    expect(display.deckName).toBe('Current Default Deck');
    expect(display.displayLine).toContain('Current Default Deck');
    expect(display.displayLine).toContain('workspace default');
    expect(display.displayLine).not.toContain('Stale Deck');
  });

  it('NOT-296 repair: use.json pointing at a deleted deck resolves unbound, not an unrelated row', async () => {
    const workspace = path.join(tempDir, 'dangling');
    await fs.mkdir(workspace, { recursive: true });
    const unrelated = await db.createDeck({ name: 'Unrelated Deck' });
    await db.upsertDeckWorkspace(workspace, unrelated.id);
    writeUseManifest(workspace, {
      version: 3,
      deckId: '00000000-0000-4000-8000-000000000000',
      deckName: 'Deleted Deck',
    });

    const display = await resolveDeckDisplay({ workspaceRoot: workspace }, db, registry);
    expect(display.deckId).toBeNull();
    expect(display.source).toBe('unbound');
    expect(display.displayLine).not.toContain('Unrelated Deck');
    expect(display.displayLine).not.toContain('Deleted Deck');
  });

  it('NOT-296 repair: same deck with different bind sources agrees instead of staying neutral', async () => {
    const workspace = path.join(tempDir, 'mixed-source');
    const deck = await db.createDeck({ name: 'Shared Deck' });
    const fresh = new LiveDisplayRegistry();
    fresh.upsert({
      mcpSessionId: 'mcp-launched',
      workspaceRoot: workspace,
      deckId: deck.id,
      deckName: deck.name,
      source: 'launch',
      updatedAt: '2026-09-28T00:00:00.000Z',
      cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
    });
    fresh.upsert({
      mcpSessionId: 'mcp-bound',
      workspaceRoot: workspace,
      deckId: deck.id,
      deckName: deck.name,
      source: 'session_override',
      updatedAt: '2026-09-28T01:00:00.000Z',
      cardCounts: { mcp: 0, credentials: 0, playbooks: 0 },
    });

    const display = await resolveDeckDisplay({ workspaceRoot: workspace }, db, fresh);
    expect(display.deckId).toBe(deck.id);
    expect(display.displayLine).toContain('Shared Deck');
    expect(display.displayLine).toContain('2 sessions');
    expect(display.displayLine).not.toContain('multiple session decks');
  });
});
