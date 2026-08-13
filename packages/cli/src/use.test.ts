import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseUseArgs, runUse } from './use';
import { writeUseManifest } from './playbook-stubs';

vi.mock('./backend-runtime', () => ({
  createCollectionAdmin: () => ({
    resolveDeck: async (ref: string) => {
      if (ref === 'dev' || ref === 'deck-1') {
        return { id: 'deck-1', name: 'dev' };
      }
      if (ref === '761f3c44-21b3-4298-81e4-4c85bb963eb1') {
        return null;
      }
      return null;
    },
    listDeckPlaybookStubs: async () => [
      { id: 'pb_test', title: 'Test playbook', triggers: ['test trigger'] },
    ],
  }),
}));

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-deck-use-cmd-'));
  tmpDirs.push(dir);
  return dir;
}

describe('agent-deck use', () => {
  it('parseUseArgs requires deck or --refresh', () => {
    expect(parseUseArgs([])).toEqual({ error: 'deck name or id is required (or pass --refresh)' });
    expect(parseUseArgs(['dev'])).toMatchObject({ deckRef: 'dev', refresh: false });
    expect(parseUseArgs(['--refresh'])).toMatchObject({ refresh: true });
  });

  it('writes mcp config, manifest, and stubs for a deck', async () => {
    const workspace = makeWorkspace();
    const parsed = parseUseArgs(['dev', '--client', 'cursor']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const result = await runUse({ ...parsed, workspaceRoot: workspace });
    expect('error' in result).toBe(false);
    if ('error' in result) {
      return;
    }

    expect(result.deck.name).toBe('dev');
    expect(result.playbookCount).toBe(1);
    expect(fs.existsSync(path.join(workspace, '.cursor', 'mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.agent-deck', 'use.json'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, '.cursor', 'rules', 'agent-deck-stubs', 'pb_test.mdc'))).toBe(
      true,
    );
    const mcp = JSON.parse(fs.readFileSync(path.join(workspace, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(mcp.mcpServers['agent-deck']?.url).toContain('/mcp');
    // The deck is stamped as the auto-bind header.
    expect(mcp.mcpServers['agent-deck']?.headers?.['x-agent-deck-deck-id']).toBe(
      result.deck.id,
    );
  });

  it('refresh falls back to manifest deckName when deckId is stale', async () => {
    const workspace = makeWorkspace();
    writeUseManifest(workspace, {
      version: 1,
      deckId: '761f3c44-21b3-4298-81e4-4c85bb963eb1',
      deckName: 'dev',
      mcpUrl: 'http://127.0.0.1:1110/mcp',
      updatedAt: new Date().toISOString(),
    });

    const parsed = parseUseArgs(['--refresh']);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) {
      return;
    }

    const result = await runUse({ ...parsed, workspaceRoot: workspace, skipMcp: true });
    expect('error' in result).toBe(false);
    if ('error' in result) {
      return;
    }

    expect(result.deck).toEqual({ id: 'deck-1', name: 'dev' });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspace, '.agent-deck', 'use.json'), 'utf8'),
    ) as { deckId: string };
    expect(manifest.deckId).toBe('deck-1');
  });
});
